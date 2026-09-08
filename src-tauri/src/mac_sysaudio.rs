//! Systemljud på macOS via Core Audio Taps — MÖTET-kanalens motsvarighet till
//! WASAPI-loopbacken på Windows.
//!
//! Kedjan är: `CATapDescription` → tap → aggregatenhet som *innehåller* tappen →
//! IOProc på aggregatet → mono `f32` in i en `Sender<f32>`. En tap ensam går inte
//! att läsa ur, och aggregatet ger tysta nollsampel utan `master`/`subdevices`.
//!
//! 🔴 BEHÖRIGHETEN ÄR DEN FARLIGA DELEN. Utan `kTCCServiceAudioCapture` nekar macOS
//! **helt tyst**: `AudioHardwareCreateProcessTap` returnerar `noErr`,
//! `AudioDeviceStart` returnerar `noErr`, IOProc:en anropas i rätt takt med rätt
//! formade buffertar — och varje sampel är `0.0`. Det finns ingen felkod och ingen
//! loggpost. Därför MÅSTE `preflight()` köras före varje fångst; en nekad behörighet
//! går annars inte att skilja från ett tyst möte.
//!
//! Spiken som fastställde detta, med tretton avfärdade hypoteser:
//! `docs/macos/spike-coreaudio-tap/`.

use crossbeam_channel::Sender;
use objc2::rc::{Allocated, Retained};
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use objc2_foundation::NSArray;
use std::ffi::{c_void, CString};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use core_foundation::array::CFArray;
use core_foundation::base::TCFType;
use core_foundation::dictionary::CFDictionary;
use core_foundation::number::CFNumber;
use core_foundation::string::{CFString, CFStringRef};

type OSStatus = i32;
type AudioObjectID = u32;

#[repr(C)]
#[derive(Clone, Copy, Debug, Default)]
struct AudioStreamBasicDescription {
    sample_rate: f64,
    format_id: u32,
    format_flags: u32,
    bytes_per_packet: u32,
    frames_per_packet: u32,
    bytes_per_frame: u32,
    channels_per_frame: u32,
    bits_per_channel: u32,
    reserved: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
struct AudioObjectPropertyAddress {
    selector: u32,
    scope: u32,
    element: u32,
}

#[repr(C)]
struct AudioBuffer {
    number_channels: u32,
    data_byte_size: u32,
    data: *mut c_void,
}

#[repr(C)]
struct AudioBufferList {
    number_buffers: u32,
    /// Variabel längd i C. Indexeras manuellt via pekararitmetik.
    buffers: [AudioBuffer; 1],
}

type AudioDeviceIOProc = extern "C" fn(
    AudioObjectID,
    *const c_void,
    *const AudioBufferList,
    *const c_void,
    *mut AudioBufferList,
    *const c_void,
    *mut c_void,
) -> OSStatus;

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    fn AudioHardwareCreateProcessTap(desc: *mut AnyObject, out: *mut AudioObjectID) -> OSStatus;
    fn AudioHardwareDestroyProcessTap(tap: AudioObjectID) -> OSStatus;
    fn AudioHardwareCreateAggregateDevice(
        desc: core_foundation_sys::dictionary::CFDictionaryRef,
        out: *mut AudioObjectID,
    ) -> OSStatus;
    fn AudioHardwareDestroyAggregateDevice(dev: AudioObjectID) -> OSStatus;
    fn AudioObjectGetPropertyData(
        obj: AudioObjectID,
        addr: *const AudioObjectPropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        data_size: *mut u32,
        data: *mut c_void,
    ) -> OSStatus;
    fn AudioObjectGetPropertyDataSize(
        obj: AudioObjectID,
        addr: *const AudioObjectPropertyAddress,
        qualifier_size: u32,
        qualifier: *const c_void,
        data_size: *mut u32,
    ) -> OSStatus;
    fn AudioDeviceCreateIOProcID(
        dev: AudioObjectID,
        proc_: AudioDeviceIOProc,
        client_data: *mut c_void,
        out: *mut *mut c_void,
    ) -> OSStatus;
    fn AudioDeviceDestroyIOProcID(dev: AudioObjectID, id: *mut c_void) -> OSStatus;
    fn AudioDeviceStart(dev: AudioObjectID, id: *mut c_void) -> OSStatus;
    fn AudioDeviceStop(dev: AudioObjectID, id: *mut c_void) -> OSStatus;
}

extern "C" {
    fn dlopen(path: *const i8, mode: i32) -> *mut c_void;
    fn dlsym(handle: *mut c_void, sym: *const i8) -> *mut c_void;
}

const fn fcc(s: &[u8; 4]) -> u32 {
    ((s[0] as u32) << 24) | ((s[1] as u32) << 16) | ((s[2] as u32) << 8) | (s[3] as u32)
}

const K_TAP_UID: u32 = fcc(b"tuid");
const K_STREAM_FORMAT: u32 = fcc(b"sfmt");
const K_SCOPE_GLOBAL: u32 = fcc(b"glob");
const K_SCOPE_INPUT: u32 = fcc(b"inpt");
const K_DEFAULT_OUTPUT_DEVICE: u32 = fcc(b"dOut");
const K_DEVICE_UID: u32 = fcc(b"uid ");
// kAudioDevicePropertyDeviceIsRunningSomewhere — "kör enheten för NÅGON i systemet".
// Inte `goin` (kAudioDevicePropertyDeviceIsRunning), som bara svarar för den
// egna klienten och alltid är 0 innan vi startat något själva.
const K_DEVICE_RUNNING_SOMEWHERE: u32 = fcc(b"gone");
// Process-objekt (macOS 14.2+, samma generation som tap-API:t). Ger det
// `kAudioDevicePropertyDeviceIsRunningSomewhere` inte kan ge: vem som spelar.
const K_PROCESS_OBJECT_LIST: u32 = fcc(b"prs#");
const K_PROCESS_PID: u32 = fcc(b"ppid");
const K_PROCESS_IS_RUNNING_OUTPUT: u32 = fcc(b"piro");
const K_SYSTEM_OBJECT: AudioObjectID = 1;
const K_ELEM_MAIN: u32 = 0;

/// CoreAudio-fel är fyra ASCII-tecken packade i en i32. Utan avkodning blir
/// felsökning gissningar — `'nope'` är begripligt, 1852797029 är det inte.
fn fourcc(s: OSStatus) -> String {
    let b = (s as u32).to_be_bytes();
    if b.iter().all(|c| c.is_ascii_graphic()) {
        format!("{} ('{}')", s, String::from_utf8_lossy(&b))
    } else {
        format!("{}", s)
    }
}

// ─────────────────────────── behörighet ───────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Permission {
    Granted,
    Denied,
    NotDetermined,
    /// TCC gick inte att fråga — behandla som "försök ändå", inte som nekad.
    Unknown,
}

fn tcc_symbol(name: &str) -> Option<*mut c_void> {
    unsafe {
        let path =
            CString::new("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC").ok()?;
        let h = dlopen(path.as_ptr(), 2 /* RTLD_NOW */);
        if h.is_null() {
            return None;
        }
        let sym = CString::new(name).ok()?;
        let f = dlsym(h, sym.as_ptr());
        if f.is_null() {
            None
        } else {
            Some(f)
        }
    }
}

/// Läser behörighetsstatus utan att visa dialog.
///
/// 🔴 Det finns ingen publik API för detta. Apples eget referensexempel
/// (`insidegui/AudioCap`) använder samma privata TCC-funktion. Alternativet är att
/// spela in tystnad utan att veta om det.
pub fn preflight() -> Permission {
    let Some(f) = tcc_symbol("TCCAccessPreflight") else {
        return Permission::Unknown;
    };
    type Preflight = extern "C" fn(
        CFStringRef,
        core_foundation_sys::dictionary::CFDictionaryRef,
    ) -> i32;
    let preflight: Preflight = unsafe { std::mem::transmute(f) };
    let service = CFString::new("kTCCServiceAudioCapture");
    match preflight(service.as_concrete_TypeRef(), std::ptr::null()) {
        0 => Permission::Granted,
        1 => Permission::Denied,
        2 => Permission::NotDetermined,
        _ => Permission::Unknown,
    }
}

/// Begär behörighet och returnerar direkt. Dialogen visas asynkront av macOS och
/// kräver att appens run loop är igång — vilket den är i en Tauri-app.
///
/// ⚠️ Anropas bara vid `NotDetermined`. Vid `Denied` visar macOS ingen ny dialog;
/// användaren måste gå till Systeminställningar, och det är vad varningsbannern säger.
pub fn request_permission() {
    let Some(f) = tcc_symbol("TCCAccessRequest") else {
        eprintln!("DEBUG: TCCAccessRequest saknas — kan inte begära ljudbehörighet");
        return;
    };
    type Request =
        extern "C" fn(CFStringRef, core_foundation_sys::dictionary::CFDictionaryRef, *mut c_void);
    let request: Request = unsafe { std::mem::transmute(f) };
    let service = CFString::new("kTCCServiceAudioCapture");
    // Tomt block: vi väntar inte på svaret här. Nästa inspelningsförsök läser
    // statusen med preflight() i stället — att blockera motorstarten på en dialog
    // vore att låta en behörighetsfråga hålla mic-vägen gisslan.
    let block = block2::RcBlock::new(|_granted: u8| {});
    let ptr = block2::RcBlock::as_ptr(&block) as *mut c_void;
    request(service.as_concrete_TypeRef(), std::ptr::null(), ptr);
    // 🔴 Blocket läcks AVSIKTLIGT. TCC anropar det asynkront när användaren svarat,
    // vilket kan vara minuter senare. Apples konvention är att en callback-tagare
    // Block_copy:ar blocket, men det är inte dokumenterat för det här privata API:t
    // — och gissar vi fel blir det en use-after-free i en callback vi inte äger.
    //
    // ⚠️ RÄTTAD 2026-09-01. Här stod tidigare att funktionen anropas "som mest en
    // gång per körning". Det stämmer inte, och ingenting upprätthöll det: utöver
    // anropet i `run()`s setup anropas den från `try_sys_capture` vid VARJE
    // byggförsök så länge statusen är NotDetermined — alltså en gång per
    // backoff-intervall (5 s → 15 s → 60 s → tak 5 min) för en användare som
    // aldrig svarar på dialogen. Kostnaden är fortfarande försumbar (ett block om
    // några tiotal byte per försök, som mest ett per fem minuter), och läckan är
    // därför fortsatt medveten — men taket är backoffen, inte "en gång".
    std::mem::forget(block);
}

// ─────────────────────────── fångst ───────────────────────────

/// Kontext till IOProc:en. En C-callback kan inte fånga miljö, så den skickas
/// som `client_data` och ägs av `MacSysStream` — inte av en global.
struct IoCtx {
    tx: Sender<f32>,
    failed: Arc<AtomicBool>,
}

extern "C" fn io_proc(
    _dev: AudioObjectID,
    _now: *const c_void,
    input: *const AudioBufferList,
    _input_time: *const c_void,
    _output: *mut AudioBufferList,
    _output_time: *const c_void,
    client: *mut c_void,
) -> OSStatus {
    if input.is_null() || client.is_null() {
        return 0;
    }
    unsafe {
        let ctx = &*(client as *const IoCtx);
        let list = &*input;
        if list.number_buffers == 0 {
            return 0;
        }
        let buf = &*(&list.buffers as *const AudioBuffer);
        if buf.data.is_null() || buf.data_byte_size == 0 {
            return 0;
        }
        let n = (buf.data_byte_size as usize) / std::mem::size_of::<f32>();
        let samples = std::slice::from_raw_parts(buf.data as *const f32, n);
        let ch = buf.number_channels.max(1) as usize;
        // Samma nedmixning som run_stream gör på Windows: medelvärde över kanaler
        // per frame. Att skicka råa interleavade samples som mono gav MÖTET-ljud i
        // halv hastighet — se kommentaren i try_sys_capture.
        for frame in samples.chunks(ch) {
            let sum: f32 = frame.iter().filter(|v| v.is_finite()).sum();
            let avg = sum / ch as f32;
            if ctx.tx.send(if avg.is_finite() { avg } else { 0.0 }).is_err() {
                // Mottagaren är borta — processor-tråden har avslutat. Flagga så att
                // 2s-pollen binder om, exakt som cpal:s error-callback gör.
                ctx.failed.store(true, Ordering::SeqCst);
                return 0;
            }
        }
    }
    0
}

/// Aktiv Core Audio-tap. Drop river ner hela kedjan i omvänd ordning.
///
/// 🔴 Både tappen OCH aggregatet måste rivas — Apples forum rapporterar att en
/// ström kan gå till permanenta nollor efter flera minuter (samplerate-omförhandling,
/// Bluetooth-växlingar), och att bara starta om IOProc:en räcker inte då.
pub struct MacSysStream {
    tap: AudioObjectID,
    agg: AudioObjectID,
    proc_id: *mut c_void,
    ctx: *mut IoCtx,
}

// SAFETY: `MacSysStream` får skickas mellan trådar, och det är en förutsättning för
// att bygget ska kunna ske utanför övervakningsloopen (annars är mikrofonen gisslan hos
// en CoreAudio-start som kan blockera ~15 s).
//
// Underlaget, fält för fält:
//
// * `tap` och `agg` är `AudioObjectID` — vanliga u32 som HAL:en delar ut. De har ingen
//   trådaffinitet; de är namn på objekt som lever i `coreaudiod`, inte i vår process.
// * `proc_id` är en opak `AudioDeviceIOProcID`. Samma sak: en handtagsidentitet, inte
//   en pekare in i trådlokalt tillstånd.
// * `ctx` är en `Box<IoCtx>` som VI äger ensamma. `IoCtx` innehåller `Sender<f32>` och
//   `Arc<AtomicBool>`, båda `Send`. Ingen annan tråd rör lådan förrän IOProc:en gör det,
//   och den körs på CoreAudios egen realtidstråd oavsett var strukten bor.
//
// Nedrivningen i `Drop` (`AudioDeviceStop`, `AudioDeviceDestroyIOProcID`,
// `AudioHardwareDestroyAggregateDevice`, `AudioHardwareDestroyProcessTap`) är HAL-anrop
// utan krav på anropande tråd — de är inte huvudtrådsbundna som AppKit-API:er.
//
// ⚠️ Det som INTE är verifierat är att `Drop` från en annan tråd än den som byggde är
// oproblematiskt i praktiken; underlaget ovan är API-kontraktet, inte en mätning. Det
// inträffar när motorn avslutas medan ett bygge pågår, och det är den enda vägen dit.
unsafe impl Send for MacSysStream {}

impl Drop for MacSysStream {
    fn drop(&mut self) {
        unsafe {
            if !self.proc_id.is_null() {
                AudioDeviceStop(self.agg, self.proc_id);
                AudioDeviceDestroyIOProcID(self.agg, self.proc_id);
            }
            if self.agg != 0 {
                AudioHardwareDestroyAggregateDevice(self.agg);
            }
            if self.tap != 0 {
                AudioHardwareDestroyProcessTap(self.tap);
            }
            // Kontexten frigörs SIST. IOProc:en kan vara mitt i ett anrop när
            // AudioDeviceStop returnerar; stop är synkront, men ordningen här gör
            // det omöjligt att läsa en frigjord kontext även om den inte vore det.
            if !self.ctx.is_null() {
                drop(Box::from_raw(self.ctx));
            }
        }
    }
}

/// Kör utenhetens IO-motor just nu, för någon klient i systemet?
///
/// ⚠️ **RUBRIKEN RÄTTAD 2026-09-01.** Här stod "Spelar utenheten just nu", och det är
/// inte vad `kAudioDevicePropertyDeviceIsRunningSomewhere` svarar på. Egenskapen säger
/// att enhetens IO-motor är IGÅNG för någon klient — vilket den är även när klienten
/// matar digital tystnad. Uppmätt: `true` i tjugo mätningar i rad utan att något
/// spelades, medan CoreAudios egen logg samtidigt rapporterade utgångens kedja på
/// `rms:[-120.000000]`. En öppen Chrome eller Electron-app räcker för att hålla den
/// sann hela dagen; det gjorde också vår egen tap innan den fick en livscykel.
///
/// Skillnaden spelar roll åt två håll. **För sitt eget syfte är egenskapen rätt vald** —
/// frågan "kan en tap haka i enhetens klocka?" handlar just om motorn, inte om ljudet.
/// Men den duger INTE som svar på "spelar någon ljud?", och den som läser den gamla
/// rubriken drar den slutsatsen — vilket är precis vad guardrail-varningen i `audio.rs`
/// hade behövt ett svar på.
///
/// 🔴 Detta är en FÖRUTSÄTTNING för att tappen ska kunna starta, inte en optimering.
/// Uppmätt på macOS 26.6.1 2026-08-30: med tyst utgång blockerar `AudioDeviceStart`
/// på aggregatet i ~15 sekunder och faller sedan med `Error: 0x3C` (ETIMEDOUT).
/// Loggen visar varför — aggregatets IO-tråd startar först när högtalaren gör det:
///
/// ```text
/// 09:04:08  aggregatet registreras
/// 09:04:23  StartIOThread: Error: 0x3C          <- 15 s timeout
/// 09:04:29  IOWorkLoopInit: BuiltInSpeakerDevice (ai.sagt.motet.aggregate): starting
/// 09:04:29  + Speaker::startIOEngineGated()     <- ljud börjar spelas
/// 09:04:29  Digital Mic Start of IO result 0    <- allt släpper
/// ```
///
/// En tap på en vilande utenhet har ingen klocka att haka i. Att ändå försöka kostade
/// ~15 s blockering per försök, ett aggregat per försök, en sömnspärr — och rev
/// mikrofonen ur pågående inspelningar, eftersom högtalare och Digital Mic delar
/// I2S-motor på Apple Silicon.
///
/// Vid fel returneras `true`: en oläsbar egenskap ska ge ett försök, inte en tyst
/// blockering av MÖTET för alltid. Felvägen nedströms degraderar redan till mic-only.
pub fn output_is_active() -> bool {
    let addr = AudioObjectPropertyAddress {
        selector: K_DEFAULT_OUTPUT_DEVICE,
        scope: K_SCOPE_GLOBAL,
        element: K_ELEM_MAIN,
    };
    let mut dev: AudioObjectID = 0;
    let mut size = std::mem::size_of::<AudioObjectID>() as u32;
    let st = unsafe {
        AudioObjectGetPropertyData(
            K_SYSTEM_OBJECT,
            &addr,
            0,
            std::ptr::null(),
            &mut size,
            &mut dev as *mut _ as *mut c_void,
        )
    };
    if st != 0 || dev == 0 {
        return true;
    }
    let addr = AudioObjectPropertyAddress {
        selector: K_DEVICE_RUNNING_SOMEWHERE,
        scope: K_SCOPE_GLOBAL,
        element: K_ELEM_MAIN,
    };
    let mut running: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    let st = unsafe {
        AudioObjectGetPropertyData(
            dev,
            &addr,
            0,
            std::ptr::null(),
            &mut size,
            &mut running as *mut _ as *mut c_void,
        )
    };
    if st != 0 {
        return true;
    }
    running != 0
}

/// Spelar någon ANNAN process ut ljud just nu?
///
/// `None` = frågan gick inte att besvara (API:t saknas eller svarade fel) — anroparen
/// ska då falla tillbaka på det beteende som gällde innan sonden fanns, inte gissa.
///
/// # Varför den behövs vid sidan av `output_is_active()`
///
/// De två svarar på olika frågor, och skillnaden är hela poängen.
/// `output_is_active()` säger *att enhetens IO-motor kör för någon klient* — rätt fråga
/// när man undrar om en tap kan haka i enhetens klocka, men obrukbar som svar på "spelas
/// det något?". Den är sann även vid digital tystnad, och den blir sann av **vår egen
/// tap**: uppmätt 2026-09-01 gav sonden `true` oavbrutet i tjugo mätningar medan
/// CoreAudios logg samtidigt rapporterade utgångens kedja på `rms:[-120]`.
///
/// Guardrail-varningen behövde den andra frågan. Utan den var den binär på macOS —
/// falsklarm vid ren diktering, och tyst när tappen fanns men gav nollor, vilket är
/// precis vad ett återkallat TCC-medgivande ger.
///
/// # Varför vår egen pid räknas bort
///
/// Under inspelning kör vårt aggregat, som innehåller utenheten. Utan uteslutningen
/// hade sonden svarat "ja, någon spelar" på vår egen fångst — samma självreferens som
/// gör `output_is_active()` oanvändbar här, återinförd i en ny funktion.
pub fn other_process_is_playing() -> Option<bool> {
    let addr = AudioObjectPropertyAddress {
        selector: K_PROCESS_OBJECT_LIST,
        scope: K_SCOPE_GLOBAL,
        element: K_ELEM_MAIN,
    };
    let mut size: u32 = 0;
    let st = unsafe {
        AudioObjectGetPropertyDataSize(K_SYSTEM_OBJECT, &addr, 0, std::ptr::null(), &mut size)
    };
    if st != 0 || size == 0 {
        return None;
    }
    let n = size as usize / std::mem::size_of::<AudioObjectID>();
    let mut ids: Vec<AudioObjectID> = vec![0; n];
    let st = unsafe {
        AudioObjectGetPropertyData(
            K_SYSTEM_OBJECT,
            &addr,
            0,
            std::ptr::null(),
            &mut size,
            ids.as_mut_ptr() as *mut c_void,
        )
    };
    if st != 0 {
        return None;
    }

    let me = std::process::id() as i32;
    // Ett process-objekt vars `piro` inte gick att läsa gör hela svaret osäkert. Att
    // räkna det som "spelar inte" vore att svara nej på grund av okunskap.
    let mut unknown = false;
    for id in ids {
        let mut pid: i32 = 0;
        let mut psz = std::mem::size_of::<i32>() as u32;
        let paddr = AudioObjectPropertyAddress {
            selector: K_PROCESS_PID,
            scope: K_SCOPE_GLOBAL,
            element: K_ELEM_MAIN,
        };
        let st = unsafe {
            AudioObjectGetPropertyData(
                id,
                &paddr,
                0,
                std::ptr::null(),
                &mut psz,
                &mut pid as *mut _ as *mut c_void,
            )
        };
        if st != 0 {
            // Just DEN HÄR processen går inte att attribuera. Den kan mycket väl spela
            // ljud, så svaret blir osäkert — men bara om ingen annan visar sig göra det.
            unknown = true;
            continue;
        }
        if pid == me {
            continue;
        }
        let raddr = AudioObjectPropertyAddress {
            selector: K_PROCESS_IS_RUNNING_OUTPUT,
            scope: K_SCOPE_GLOBAL,
            element: K_ELEM_MAIN,
        };
        let mut running: u32 = 0;
        let mut rsz = std::mem::size_of::<u32>() as u32;
        let st = unsafe {
            AudioObjectGetPropertyData(
                id,
                &raddr,
                0,
                std::ptr::null(),
                &mut rsz,
                &mut running as *mut _ as *mut c_void,
            )
        };
        if st != 0 {
            unknown = true;
            continue;
        }
        if running != 0 {
            return Some(true);
        }
    }
    // 🔴 Ett tomt svep är INTE detsamma som ett oläsbart. Har vi räknat igenom listan
    // och kunnat läsa varje post är "ingen annan spelar" ett riktigt svar, även om
    // listan bara innehöll oss själva — det är exakt läget vid ren diktering på en
    // maskin utan andra ljudappar, och det är då falsklarmet ska UTEBLI.
    //
    // Ett tidigare utkast krävde att minst en `piro` lästs för att svara `Some(false)`.
    // På en sådan maskin blev svaret `None`, guardrailen varnade, och falsklarmet var
    // tillbaka genom en sidodörr. Samma felform som grinden som godkänner tyst när den
    // inte sett några poster — bara med motsatt utfall.
    if unknown {
        // 🔴 Loggas, och det är hela poängen med raden. Utan den återgår macOS-
        // guardrailen tyst till sitt gamla beteende — falsklarm vid varje diktering —
        // och ingenting säger att kalibreringen är ur funktion. En grind som slutar
        // fungera utan att säga det är samma felform som revisionen letade efter.
        //
        // En gång per anrop är för ofta; raden skrivs bara när svaret faktiskt blir
        // osäkert, vilket på en frisk maskin aldrig händer (uppmätt 2026-09-02: alla
        // process-objekt läsbara, svaret Some(false)/Some(true) genomgående).
        eprintln!(
            "DEBUG: kunde inte läsa alla ljudprocesser — vet inte om någon spelar,              guardrailen faller tillbaka på sitt gamla beteende"
        );
        None
    } else {
        Some(false)
    }
}

fn default_output_uid() -> Result<CFString, String> {
    let addr = AudioObjectPropertyAddress {
        selector: K_DEFAULT_OUTPUT_DEVICE,
        scope: K_SCOPE_GLOBAL,
        element: K_ELEM_MAIN,
    };
    let mut dev: AudioObjectID = 0;
    let mut size = std::mem::size_of::<AudioObjectID>() as u32;
    let st = unsafe {
        AudioObjectGetPropertyData(
            K_SYSTEM_OBJECT,
            &addr,
            0,
            std::ptr::null(),
            &mut size,
            &mut dev as *mut _ as *mut c_void,
        )
    };
    if st != 0 || dev == 0 {
        return Err(format!("default output device -> {}", fourcc(st)));
    }
    let addr = AudioObjectPropertyAddress {
        selector: K_DEVICE_UID,
        scope: K_SCOPE_GLOBAL,
        element: K_ELEM_MAIN,
    };
    let mut uid: CFStringRef = std::ptr::null();
    let mut size = std::mem::size_of::<CFStringRef>() as u32;
    let st = unsafe {
        AudioObjectGetPropertyData(
            dev,
            &addr,
            0,
            std::ptr::null(),
            &mut size,
            &mut uid as *mut _ as *mut c_void,
        )
    };
    if st != 0 || uid.is_null() {
        return Err(format!("device UID -> {}", fourcc(st)));
    }
    Ok(unsafe { CFString::wrap_under_create_rule(uid) })
}

fn tap_uid(tap: AudioObjectID) -> Result<CFString, String> {
    let addr = AudioObjectPropertyAddress {
        selector: K_TAP_UID,
        scope: K_SCOPE_GLOBAL,
        element: K_ELEM_MAIN,
    };
    let mut uid: CFStringRef = std::ptr::null();
    let mut size = std::mem::size_of::<CFStringRef>() as u32;
    let st = unsafe {
        AudioObjectGetPropertyData(
            tap,
            &addr,
            0,
            std::ptr::null(),
            &mut size,
            &mut uid as *mut _ as *mut c_void,
        )
    };
    if st != 0 || uid.is_null() {
        return Err(format!("kAudioTapPropertyUID -> {}", fourcc(st)));
    }
    Ok(unsafe { CFString::wrap_under_create_rule(uid) })
}

/// UID för vårt privata aggregat, med processens pid inbakad.
///
/// Utbruten ur `start()` för att gå att testa: mekanismen är att strängen SKA variera
/// per process, och det påståendet går annars bara att kontrollera genom att starta två
/// appar och läsa CoreAudios logg. Se kommentaren vid anropsplatsen för varför den inte
/// får vara konstant.
fn aggregate_uid() -> String {
    format!("ai.sagt.motet.aggregate.{}", std::process::id())
}

/// Startar systemljudsfångst. Returnerar guarden och samplingsfrekvensen.
///
/// Best-effort precis som Windows-vägen: varje felväg ger `Err`, och anroparen
/// faller tillbaka på mic-only. Systemljud får aldrig döda mic-inspelningen.
pub fn start(
    tx: Sender<f32>,
    failed: Arc<AtomicBool>,
) -> Result<(MacSysStream, u32, String), String> {
    unsafe {
        // Mono-mixdown av allt systemljud. Tom uteslutningslista = tappa allt.
        let empty: Retained<NSArray<AnyObject>> = NSArray::new();
        let alloc: Allocated<AnyObject> = msg_send![class!(CATapDescription), alloc];
        let desc: Retained<AnyObject> =
            msg_send![alloc, initMonoGlobalTapButExcludeProcesses: &*empty];

        // deviceUID är nil efter init och måste sättas — en global tap utan enhet
        // vet inte vad den ska tappa.
        let out_uid = default_output_uid()?;
        let device_name = out_uid.to_string();
        let ns_uid = objc2_foundation::NSString::from_str(&device_name);
        let _: () = msg_send![&*desc, setDeviceUID: &*ns_uid];

        let mut tap: AudioObjectID = 0;
        let st = AudioHardwareCreateProcessTap(Retained::as_ptr(&desc) as *mut AnyObject, &mut tap);
        if st != 0 {
            return Err(format!("AudioHardwareCreateProcessTap -> {}", fourcc(st)));
        }

        // Från och med nu måste varje felväg riva tappen.
        let cleanup_tap = |t: AudioObjectID| {
            AudioHardwareDestroyProcessTap(t);
        };

        let t_uid = match tap_uid(tap) {
            Ok(u) => u,
            Err(e) => {
                cleanup_tap(tap);
                return Err(e);
            }
        };

        // 🔴 master + subdevices + tapautostart. Utan subdevices ger aggregatet
        // tysta nollsampel utan felkod — uppmätt, se spikens README.
        let sub_device = CFDictionary::from_CFType_pairs(&[(
            CFString::new("uid").as_CFType(),
            out_uid.as_CFType(),
        )]);
        let sub_tap = CFDictionary::from_CFType_pairs(&[
            (CFString::new("uid").as_CFType(), t_uid.as_CFType()),
            (
                CFString::new("drift").as_CFType(),
                CFNumber::from(0i32).as_CFType(),
            ),
        ]);
        // 🔴 UID:t bär processens pid. Det var tidigare en konstant sträng, och två
        // samtidiga instanser — en installerad app och en `tauri:dev`-körning, eller
        // två inloggade användarkonton — hade då bett CoreAudio om två aggregat med
        // samma UID. Vad som händer då är overifierat, och det är hela poängen: det
        // är inte ett tillstånd man vill ta reda på i fält.
        //
        // Det blockerade dessutom felsökningen konkret. Revisionen 2026-09-01 kunde
        // inte köra en dev-instans bredvid den installerade appen just av det skälet,
        // och därför blev de två största fynden lämnade utan runtime-verifiering.
        // Ett verktyg man inte kan köra bredvid sig självt är svårare att laga.
        //
        // Namnet ("Sagt.ai MÖTET") lämnas konstant — det är en visningssträng, och
        // aggregatet är `private` så ingen användare ser det i Ljud-inställningarna.
        let agg_uid = aggregate_uid();
        let agg_desc = CFDictionary::from_CFType_pairs(&[
            (
                CFString::new("name").as_CFType(),
                CFString::new("Sagt.ai MÖTET").as_CFType(),
            ),
            (
                CFString::new("uid").as_CFType(),
                CFString::new(&agg_uid).as_CFType(),
            ),
            (
                CFString::new("private").as_CFType(),
                CFNumber::from(1i32).as_CFType(),
            ),
            (
                CFString::new("stacked").as_CFType(),
                CFNumber::from(0i32).as_CFType(),
            ),
            (CFString::new("master").as_CFType(), out_uid.as_CFType()),
            (
                CFString::new("subdevices").as_CFType(),
                CFArray::from_CFTypes(&[sub_device.as_CFType()]).as_CFType(),
            ),
            (
                CFString::new("taps").as_CFType(),
                CFArray::from_CFTypes(&[sub_tap.as_CFType()]).as_CFType(),
            ),
            (
                CFString::new("tapautostart").as_CFType(),
                CFNumber::from(1i32).as_CFType(),
            ),
        ]);

        let mut agg: AudioObjectID = 0;
        let st = AudioHardwareCreateAggregateDevice(agg_desc.as_concrete_TypeRef() as _, &mut agg);
        if st != 0 {
            cleanup_tap(tap);
            return Err(format!("AudioHardwareCreateAggregateDevice -> {}", fourcc(st)));
        }

        // Samplingsfrekvensen läses ur aggregatet i stället för att antas. 48 kHz är
        // vad vi mätt, men process_audio_stream resamplar utifrån detta värde och en
        // felaktig gissning ger ljud i fel hastighet.
        let addr = AudioObjectPropertyAddress {
            selector: K_STREAM_FORMAT,
            scope: K_SCOPE_INPUT,
            element: K_ELEM_MAIN,
        };
        let mut asbd = AudioStreamBasicDescription::default();
        let mut size = std::mem::size_of::<AudioStreamBasicDescription>() as u32;
        let st = AudioObjectGetPropertyData(
            agg,
            &addr,
            0,
            std::ptr::null(),
            &mut size,
            &mut asbd as *mut _ as *mut c_void,
        );
        if st != 0 || asbd.sample_rate <= 0.0 {
            AudioHardwareDestroyAggregateDevice(agg);
            cleanup_tap(tap);
            return Err(format!("stream format -> {}", fourcc(st)));
        }
        let sample_rate = asbd.sample_rate as u32;

        let ctx = Box::into_raw(Box::new(IoCtx { tx, failed }));
        let mut proc_id: *mut c_void = std::ptr::null_mut();
        let st = AudioDeviceCreateIOProcID(agg, io_proc, ctx as *mut c_void, &mut proc_id);
        if st != 0 {
            drop(Box::from_raw(ctx));
            AudioHardwareDestroyAggregateDevice(agg);
            cleanup_tap(tap);
            return Err(format!("AudioDeviceCreateIOProcID -> {}", fourcc(st)));
        }

        let st = AudioDeviceStart(agg, proc_id);
        if st != 0 {
            AudioDeviceDestroyIOProcID(agg, proc_id);
            drop(Box::from_raw(ctx));
            AudioHardwareDestroyAggregateDevice(agg);
            cleanup_tap(tap);
            return Err(format!("AudioDeviceStart -> {}", fourcc(st)));
        }

        Ok((
            MacSysStream {
                tap,
                agg,
                proc_id,
                ctx,
            },
            sample_rate,
            device_name,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::aggregate_uid;

    #[test]
    fn aggregatets_uid_bar_processens_pid() {
        // 🔴 NEGATIVT TEST för fynd 13. Grinden är att strängen INTE får vara en
        // konstant: två instanser på samma maskin bad annars CoreAudio om två aggregat
        // med samma UID, och det var vad som hindrade en dev-körning bredvid den
        // installerade appen — alltså det som lämnade revisionens två största fynd
        // utan runtime-verifiering.
        let uid = aggregate_uid();
        assert!(
            uid.contains(&std::process::id().to_string()),
            "UID:t måste variera per process, fick {uid}"
        );
        // Prefixet är fortfarande vårt, så aggregatet går att känna igen i
        // CoreAudios logg och i pmset-assertionens namn.
        assert!(uid.starts_with("ai.sagt.motet.aggregate."), "oväntat prefix: {uid}");
        // Stabil inom processen — annars skulle varje ombyggnad ge ett nytt aggregat-UID.
        assert_eq!(uid, aggregate_uid());
    }
}

