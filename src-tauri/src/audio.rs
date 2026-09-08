use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_channel::{unbounded, Receiver, Sender};
use rubato::{Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction};
use serde::Serialize;
use std::collections::VecDeque;
use std::sync::{Arc, Mutex, OnceLock};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime};
use tauri::{AppHandle, Emitter, Manager};
use crate::database::{DatabaseManager, Recording, Segment};

// Max 2 concurrent whisper-cli processes to avoid CPU starvation.
// More than 2 causes all instances to run ~4x slower, making live transcription impossible.
static TRANSCRIPTION_SEMAPHORE: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();

fn transcription_semaphore() -> &'static Arc<tokio::sync::Semaphore> {
    TRANSCRIPTION_SEMAPHORE.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2)))
}

// Monotonisk sessionsgeneration. Bumpas vid varje inspelningsstart OCH vid avbryt.
// En transkriberingsuppgift fångar generationen när dess segment dispatchas; om generationen
// hunnit ändras (ny inspelning startad, eller användaren tryckt Avbryt) avbryter uppgiften
// innan den spawnar whisper-cli och slänger ev. resultat — så en föregående sessions köade/
// sena transkriberingar aldrig läcker in i den aktuella vyn.
static SESSION_GENERATION: AtomicU64 = AtomicU64::new(0);

pub fn bump_session_generation() -> u64 {
    SESSION_GENERATION.fetch_add(1, Ordering::SeqCst) + 1
}

fn current_session_generation() -> u64 {
    SESSION_GENERATION.load(Ordering::SeqCst)
}

// Monotonisk MOTORgeneration — samma grepp som sessionsgenerationen ovan, men för
// ljudmotorns trådar. Bumpas av både `start()` och `stop()`, och varje tråd bär den
// generation den startades med.
//
// 🔴 Varför en generation och inte `is_running`-flaggan. Flaggan kunde inte svara på
// frågan "är JAG fortfarande den aktuella motorn". `stop()` satte den till false, men
// en loop som stod i ett blockerande enhetsbygge såg det inte förrän anropet
// returnerade — och hann `start()` sätta tillbaka den till true dessförinnan såg den
// aldrig ett false alls. Resultatet blev två motorer med varsin uppsättning fångster
// som band om mot varandra. Ett tal kan inte återtas på det sättet: den gamla tråden
// ser ett annat tal än sitt eget, hur många gånger flaggan än hunnit vända.
static ENGINE_GENERATION: AtomicU64 = AtomicU64::new(0);

fn bump_engine_generation() -> u64 {
    ENGINE_GENERATION.fetch_add(1, Ordering::SeqCst) + 1
}

/// Ren jämförelse, utbruten för att gå att testa utan att röra den globala räknaren —
/// ett test som muterar en `static` läcker in i varje annat test som körs parallellt.
fn generation_is_current(current: u64, mine: u64) -> bool {
    current == mine
}

/// Är den här motortråden fortfarande den aktuella?
fn engine_generation_is_current(mine: u64) -> bool {
    generation_is_current(ENGINE_GENERATION.load(Ordering::SeqCst), mine)
}

// Sessionsrelativ tid (sekunder) för ett segment som börjar vid `speech_start_ms`, mätt mot
// den delade `session.start_time`. Båda kanalerna (mic/sys) använder samma origo + samma
// väggklocka → segmenten sorteras i rätt ordning i vyn oavsett kanal.
fn session_offset(session_state: &Arc<Mutex<SessionState>>, speech_start_ms: u128) -> f64 {
    let origin = session_state
        .lock()
        .unwrap()
        .start_time
        .unwrap_or(speech_start_ms);
    speech_start_ms.saturating_sub(origin) as f64 / 1000.0
}

const SAMPLE_RATE: u32 = 16000;
const VAD_THRESHOLD: f32 = 0.008;
// 0.8s silence triggers a cut (was 1.2s) — snappier segmentation for live feel
const SILENCE_DURATION_MS: u128 = 800;
const MIN_RECORDING_DURATION_MS: u128 = 1000;
// 3.0s minimum keeps short sounds from becoming separate segments
const MIN_SEGMENT_DURATION_MS: u128 = 3000;
// 8s max chunk (was 15s) — shorter chunks → faster transcription → live text sooner
const MAX_SEGMENT_DURATION_MS: u128 = 8000;
// Molnchunks får vara längre: KB-Whisper är tränad på 30 s-fönster, så mer kontext per chunk
// ger märkbart bättre kvalitet. Lokal small behåller 8 s (CPU-latens med semaphore(2));
// molnet (Berget) transkriberar en 15 s-chunk på ~1–2 s så live-känslan består.
const CLOUD_MAX_SEGMENT_DURATION_MS: u128 = 15000;
// Pre-roll buffer size: 2.0 seconds * SAMPLE_RATE
const PRE_ROLL_SAMPLES: usize = (2.0 * SAMPLE_RATE as f32) as usize;
// Lead-in vid MAX-segmentklipp: behåll de sista ~1.5 s som akustisk uppvärmning för nästa
// chunk så whisper inte tappar de första orden när sammanhängande tal tvångsklipps mitt i.
const CHUNK_LEAD_IN_SAMPLES: usize = (1.5 * SAMPLE_RATE as f32) as usize;

#[derive(Clone, Serialize, Debug)]
pub struct AudioSettings {
    pub vad_threshold: f32,
    pub silence_duration_ms: u64,
    /// PRO online: skicka VAD-segment till molnet (kb-whisper-large) istället för
    /// lokal whisper-cli. När true körs ALDRIG lokal small (offline-fallback sätter
    /// detta till false från JS).
    pub cloud_streaming: bool,
    /// Sammanhängande-läge (1×): mixa kanalerna och transkribera EN ström i molnet
    /// (talare "MOLN"). När false (Strukturerat) streamas varje kanal separat (DU/MÖTET, ~2×).
    pub merge_channels: bool,
    /// Live-diarisering (STEG 3): när true emitteras MÖTET-kanalen som kontinuerlig
    /// 16 kHz f32-ström (`live-diarize-pcm`, 100 ms-frames) till JS, som strömmar den
    /// vidare till pyannoteAI Live-1. Sätts av JS FÖRST när en live-session mintats
    /// (broker + LIVE_DIARIZE_ENABLED + Pro + online + structured) — annars av.
    pub live_diarize: bool,
}

impl Default for AudioSettings {
    fn default() -> Self {
        Self {
            vad_threshold: VAD_THRESHOLD,
            silence_duration_ms: SILENCE_DURATION_MS as u64,
            cloud_streaming: false,
            merge_channels: false,
            live_diarize: false,
        }
    }
}

#[derive(Clone, Serialize)]
struct AudioPayload {
    mic: f32,
    system: f32,
}

#[derive(Clone, Serialize)]
struct TranscriptionChunk {
    text: String,
    source: String,
    start: f64,
    end: f64,
}

// Live cloud-streaming: a finished VAD segment shipped to JS as raw WAV bytes.
// JS POSTs it to /transcribe-chunk and feeds the result into the transcription store.
#[derive(Clone, Serialize)]
struct CloudChunk {
    audio: Vec<u8>,   // complete in-memory WAV (16kHz mono i16)
    speaker: String,  // "DU" | "MÖTET" (structured) or "MOLN" (merged)
    start: f64,       // seconds offset within the recording
    duration: f64,    // segmentets längd i sekunder → JS sätter end_time = start + duration
}

// Live-diarisering (STEG 3): en kontinuerlig 100 ms-bit av MÖTET-kanalen som rå 16 kHz
// f32 (mono). JS bygger en Float32Array (pcm_f32le på x86/ARM) och strömmar den vidare
// till pyannoteAI Live-1-ws:en. Kontinuerlig — inkl. tystnad — så pyannote får hela
// tidslinjen; JS äger ws:en, sessionskedjan och relabelingen (PR-8).
#[derive(Clone, Serialize)]
struct LiveDiarizePcm {
    samples: Vec<f32>,
}

// 100 ms @ 16 kHz mono = 1600 sampel = 6400 byte (pyannote Live-1:s chunk-storlek).
const LIVE_DIARIZE_FRAME_SAMPLES: usize = 1600;

enum AudioInput {
    Mic(f32),
    System(f32),
}

// Data for Session Recorder (Full Mix)
struct SessionChunk {
    source: String, // "mic" or "sys"
    data: Vec<f32>,
}

// Shared state for the current recording session
struct SessionState {
    segments: Vec<Segment>,
    wav_path: Option<String>,
    start_time: Option<u128>, // SystemTime as millis
    pending_transcriptions: usize,
    duration_sec: f64,
}

pub struct AudioMonitor {
    /// "Finns det redan en motor?" — läses BARA av `start()` för att avgöra om en ny
    /// tråd ska spawnas, och nollställs av motortråden när den avslutar sig själv.
    /// Att avsluta trådar är inte längre dess jobb: det gör `ENGINE_GENERATION`, av
    /// skälen i kommentaren där.
    is_running: Arc<Mutex<bool>>,
    is_recording: Arc<Mutex<bool>>,
    pub settings: Arc<Mutex<AudioSettings>>,
    session_state: Arc<Mutex<SessionState>>,
    /// Önskad mic-enhet (None = systemets default). Sätts av init_audio_engine och
    /// plockas upp av huvudloopens 2 s-poll — enhetsbyte kräver ingen motoromstart.
    desired_mic: Arc<Mutex<Option<String>>>,
    /// Settings-mikrofontestet begär öppen mic medan Inställningar visas. Tillsammans
    /// med `is_recording` bildar detta `mic_wanted` — micen hålls öppen exakt när någon
    /// av dem är sann, annars släpps den så andra appar kan använda mikrofonen.
    mic_preview: Arc<Mutex<bool>>,
}

#[derive(Serialize)]
pub struct AudioDevice {
    pub name: String,
    pub is_default: bool,
}

impl AudioMonitor {
    pub fn new() -> Self {
        Self {
            is_running: Arc::new(Mutex::new(false)),
            is_recording: Arc::new(Mutex::new(false)),
            settings: Arc::new(Mutex::new(AudioSettings::default())),
            session_state: Arc::new(Mutex::new(SessionState {
                segments: Vec::new(),
                wav_path: None,
                start_time: None,
                pending_transcriptions: 0,
                duration_sec: 0.0,
            })),
            desired_mic: Arc::new(Mutex::new(None)),
            mic_preview: Arc::new(Mutex::new(false)),
        }
    }

    pub fn update_settings(&self, threshold: f32, silence_ms: u64) {
        let mut s = self.settings.lock().unwrap();
        s.vad_threshold = threshold;
        s.silence_duration_ms = silence_ms;
        println!("DEBUG: Updated Audio Settings: {:?}", s);
    }

    /// JS avgör (isPro + online + recordingMode + diariseringsläge) och sätter detta
    /// före start_recording. cloud_streaming=true → VAD-segment går till molnet, ingen
    /// lokal whisper-cli. merge_channels=true → Sammanhängande/1× (mixad MOLN-ström).
    pub fn set_cloud_mode(&self, cloud_streaming: bool, merge_channels: bool) {
        let mut s = self.settings.lock().unwrap();
        s.cloud_streaming = cloud_streaming;
        s.merge_channels = merge_channels;
        println!("DEBUG: Cloud mode set: streaming={}, merge={}", cloud_streaming, merge_channels);
    }

    /// Live-diarisering (STEG 3): JS slår på detta när en pyannote Live-1-session mintats
    /// (broker) och stänger av det vid stopp/degradering. På → MÖTET-kanalen emitteras som
    /// `live-diarize-pcm`-frames. Ändrar inget annat i pipelinen (additivt bredvid cloud_streaming).
    pub fn set_live_diarize(&self, enabled: bool) {
        let mut s = self.settings.lock().unwrap();
        s.live_diarize = enabled;
        println!("DEBUG: Live-diarize mode set: {}", enabled);
    }

    /// Settings-mikrofontestet: sätt/nollställ önskan om öppen mic medan Inställningar
    /// visas. Motorloopens reconcile bygger/dropper mic-strömmen mot `mic_wanted`.
    pub fn set_mic_preview(&self, enabled: bool) {
        *self.mic_preview.lock().unwrap() = enabled;
        println!("DEBUG: Mic preview set: {}", enabled);
    }

    pub fn get_input_devices(&self) -> Vec<AudioDevice> {
        let host = cpal::default_host();
        let default_in = host.default_input_device().and_then(|d| d.name().ok());
        
        let mut devices = Vec::new();
        if let Ok(in_devices) = host.input_devices() {
            for device in in_devices {
                if let Ok(name) = device.name() {
                    let is_default = default_in.as_ref() == Some(&name);
                    devices.push(AudioDevice { name, is_default });
                }
            }
        }
        devices
    }

    pub fn start(&self, app: AppHandle, input_device_name: Option<String>) -> Result<(), String> {
        println!("DEBUG: Entered init_audio_engine with device: {:?}", input_device_name);
        // Spara önskad enhet FÖRE running-checken: när motorn redan kör är detta hela
        // jobbet — huvudloopens 2 s-poll binder om mic-strömmen mot den nya enheten.
        // (Tidigare var enhetsbyte vid körande motor en tyst no-op.)
        *self.desired_mic.lock().unwrap() = input_device_name;
        let mut running = self.is_running.lock().unwrap();
        if *running {
            println!("DEBUG: Audio engine already running — mic rebind via main loop poll");
            return Ok(());
        }
        *running = true;
        // Ny motor → ny generation. Varje tråd nedan bär den, och en tråd från en
        // tidigare motor avslutar sig själv så snart den ser att talet ändrats.
        let my_gen = bump_engine_generation();
        let is_running = self.is_running.clone();
        let is_recording = self.is_recording.clone(); // Clone for threads
        let settings = self.settings.clone();
        let session_state = self.session_state.clone();
        let desired_mic = self.desired_mic.clone();
        let mic_preview = self.mic_preview.clone();

        thread::spawn(move || {
            let host = cpal::default_host();

            // Channel for aggregating VAD levels
            let (level_tx, level_rx) = unbounded::<AudioInput>();
            
            // Channel for Session Recording (Full Mix)
            let (session_tx, session_rx) = unbounded::<SessionChunk>();

            // Start Session Recorder Thread
            let app_handle_recorder = app.clone();
            let is_recording_recorder = is_recording.clone();
            let session_state_recorder = session_state.clone();
            let settings_recorder = settings.clone();

            thread::spawn(move || {
                start_session_recorder(session_rx, app_handle_recorder, my_gen, is_recording_recorder, session_state_recorder, settings_recorder);
            });

            // --- Microphone Capture (LAT) ---
            // Micen öppnas INTE vid motorstart. Reconcilen i huvudloopen nedan bygger
            // den on-demand när `mic_wanted` (inspelning ELLER Settings-mikrofontest) blir
            // sann, och släpper den annars. Så länge appen bara ligger öppen hålls micen
            // INTE → andra appar (webbläsarens inspelning, Teams/Zoom) kan använda den fritt.
            // Saknad mic dödar därmed inte längre motorn; den ytar graciöst vid inspelnings-
            // start (degradering till MÖTET-only, se reconcile-grenen).
            let mut mic_capture: Option<MicCapture> = None;

            // --- System Loopback Capture ---
            // Loopbacken binds mot den AKTUELLA default-utgången och binds om i huvud-
            // loopen nedan när Windows byter utgång (hörlurar i/ur) eller när WASAPI
            // invaliderar endpointen — annars fortsätter fångsten mot en död enhet och
            // MÖTET-kanalen blir tyst trots att mic fungerar.
            //
            // 🔴 Även DEN HÄR byggnaden grindas mot en vilande utgång, inte bara
            // ombyggnaderna i loopen nedan. Grinden satt först enbart i `needs_rebind`,
            // och den luckan var hela felet: appen skapade tappen EN gång vid start,
            // mot en tyst utgång, och den vägde fast den delade ljudmotorn.
            //
            // Uppmätt i apploggen 2026-08-30, med ~40 sekunder mellan raderna:
            //
            //     13:22:10.833  Core Audio tap startad på "Högtalare i MacBook Air"
            //     13:22:12.684  Selected input device: "MacBook Air-mikrofon"
            //     ...ingenting på 34 sekunder — build_mic_capture BLOCKERADE...
            //     13:22:47.013  Mic stream started      <- bakgrundsljud startade just då
            //
            // På Apple Silicon delar högtalare och Digital Mic samma I2S-motor. En tap
            // som väntar på att en vilande utgång ska starta hindrar därmed mikrofonens
            // `AudioDeviceStart` från att returnera. Två inspelningar i rad blev tysta:
            // reconcile-loopen satt fast i anropet från den första.
            //
            // Konsekvensen av att avstå är ingen: en tyst utgång har inget mötesljud att
            // fånga, och loopen bygger tappen inom två sekunder efter att ljud börjar.
            //
            // ⚠️ KVARVARANDE RISK, medvetet inte åtgärdad här. Grinden gör felet
            // sällsynt, inte omöjligt: är utgången kort aktiv när pollen körs (ett
            // notisljud) startar bygget, och tystnar utgången under tiden blockerar
            // `AudioDeviceStart` sina ~15 sekunder på samma tråd som öppnar mikrofonen.
            // En inspelning som startas i det fönstret får mikrofonen först vid nästa
            // varv — samma symptom som i dag, bara med ett smalare tidsfönster.
            //
            // Den strukturella fixen är att bygga systemfångsten på en EGEN tråd, så att
            // en blockerande CoreAudio-start aldrig kan ligga i vägen: mikrofonen är den
            // obligatoriska kanalen och får aldrig vara gisslan hos den valfria. Det
            // kräver att `SysCapture` blir `Send` (den håller råa CoreAudio-pekare), och
            // gjordes inte i samma ändring som den här eftersom det inte gick att
            // runtime-verifiera i samma session.
            // INGET startbygge längre. Det var den här platsen — bygget före loopens
            // första mic-reconcile — som höll mikrofonen i 34,3 sekunder den 30 augusti
            // och gav två tysta inspelningar i rad. Och en tap som byggs vid motorstart
            // rivs aldrig, vilket höll datorn vaken i två dygn (se reconcilen nedan).
            //
            // MÖTET byggs numera när en inspelning startar, asynkront, av reconcilen.
            let mut sys_capture: Option<SysCapture> = None;
            let mut pending_sys_build = PendingSysBuild::new();

             // --- Main Loop: Aggregating Levels & Keeping Alive ---
             let mut current_mic = 0.0;
             let mut current_sys = 0.0;
             let app_handle_main = app.clone();
             let mut last_log = Instant::now();

             let mut last_emit = Instant::now();

             // Enhetspolling var 2 s: rebind av loopbacken vid default-utgångsbyte.
             let mut last_device_poll = Instant::now();
             // Senast den BUNDNA loopbacken levererade hörbart ljud. MEDVETET inte i
             // RecordingState trots att start-kanten nollar den: muteras av level-
             // handlern och av loopback-rebinden (fräsch tystnadsfrist) även utanför
             // inspelning, och metersvepets tystnadsgrind läser den i kantfönstret
             // mellan is_recording=true och 2s-pollens start-kantdetektering.
             let mut last_sys_audible = Instant::now();
             // Guardrail: engångsvarning per inspelning när inspelning pågår men inget
             // systemljud fångas — annars upptäcks tyst MÖTET-kanal först efteråt.
             // Some medan en inspelning pågår — None däremellan; kanterna detekteras
             // i 2s-pollen. Se RecordingState för fältens invarianter.
             let mut rec_state: Option<RecordingState> = None;
             // Engångstoast per mic-felepisod (nollställs vid lyckad rebind) —
             // fail-loud utan att spamma en toast var 2 s medan enheten saknas.
             let mut mic_error_emitted = false;
             // Retry-throttle för reconcilens mic-bygge: reconcilen kör varje loop-varv
             // (~20 ms), så utan detta skulle ett misslyckat bygge (t.ex. micen upptagen
             // under loopback-only) retry-loopa enhetsenumereringen 50+ ggr/s. None =
             // "försök direkt" (låg latens vid inspelningsstart); efter ett försök väntar
             // vi ≥ 2 s. Nollställs vid lyckat bygge och vid mic-släpp → nästa episod är direkt.
             let mut last_mic_build_attempt: Option<Instant> = None;

             // --- Follow-the-audio-state (se SysTarget för designmotiv) ---
             let mut sys_target = SysTarget::Default;
             // Metersvep var 1 s — snabbare än 2s-enhetspollen eftersom Teams-fallet
             // ska fångas inom sekunder från första distansrepliken. Svepet körs BARA
             // under inspelning: det är då fel endpoint kostar något, och utanför
             // inspelning ska en notisplings på en annan endpoint aldrig flytta
             // loopbacken från default.
             let mut last_meter_poll = Instant::now();
             // (kandidatnamn, antal på varandra följande svep) — dämpar byten så att en
             // enstaka ljudspik på fel endpoint inte rycker loopbacken. MEDVETET inte
             // i RecordingState: streaken ägs av svepgrinden (självnollande utanför
             // inspelning via else-grenen) och en streak byggd i kantfönstret före
             // start-kantdetekteringen ska överleva in i inspelningen.
             let mut candidate_streak: Option<(String, u32)> = None;
             // Beordra rebind direkt vid nästa 2s-poll efter ett target-byte.
             let mut force_sys_rebind = false;
             // Endpoint vars pinned-bind nyss misslyckades (t.ex. HFP-endpoint som
             // vägrar loopback) — karantän så att metersvepet inte retry-loopar den.
             let mut pinned_quarantine: Option<(String, Instant)> = None;
             // 🔴 Backoff när MÖTET-fångsten upprepat vägrar starta. Utan den bygger
             // loopen om var 2:e sekund för alltid: `(SysTarget::Default, None)`-armen
             // i `needs_rebind` nedan är sann så länge fångsten saknas och en utenhet
             // finns, och den varken räknar försök eller väntar.
             //
             // Uppmätt på macOS 26.6.1 2026-08-30, app v0.10.0: varje misslyckat
             // försök skapar ett nytt aggregat som blockerar ~14 s på CoreAudios
             // starttimeout (`Error: 0x3C` = ETIMEDOUT) innan det ger upp. Följden
             // blev 53 `ai.sagt.motet.aggregate` på tre timmar, IO-kontexter som
             // hölls kvar tills appen avslutades, och en `preventuseridlesleep`-spärr
             // som hindrade datorn från att somna medan appen var overksam.
             //
             // Värst var kollateralskadan: aggregatchurnen rev mikrofonen ur
             // pågående inspelningar. Sessionen blev då 0,5 s tystnad — under
             // MIN_RECORDING_DURATION_MS, alltså tyst kasserad utan felmeddelande.
             // Fem av nio inspelningar föll så innan orsaken var känd.
             let mut sys_fail_streak: u32 = 0;
             let mut sys_retry_at: Option<Instant> = None;
             // När den nuvarande fångsten byggdes. Avgör om ett fel ska räknas som
             // "den fungerade och dog" eller "den fungerade aldrig" — se
             // `sys_capture_was_stable`, som är den grind backoffen ovan saknade.
             // Börjar som None: ingen fångst finns förrän ett bygge levererat en, och
             // tidpunkten sätts där resultatet installeras.
             let mut sys_built_at: Option<Instant> = None;
             // Senaste gången vi frågade om utgången är vaken. Throttlar sonden i
             // reconcilen; None = "fråga direkt" (inspelningsstart, eller nyss släppt).
             let mut last_sys_probe: Option<Instant> = None;
             // När den nuvarande sammanhängande uppspelningen (någon ANNAN process)
             // började. Guardrailens tystnadsgren kräver att den varat en stund.
             let mut playing_since: Option<Instant> = None;

             // Föregående varvs starttid — underlaget för hängningsdetektorn nedan.
             let mut last_tick = Instant::now();

             loop {
                // Motorgenerationen, inte flaggan — se ENGINE_GENERATION för varför
                // en flagga som kan sättas tillbaka inte kan avsluta den här tråden.
                if !engine_generation_is_current(my_gen) {
                    break;
                }

                // --- Hängningsdetektor för övervakningsloopen ---
                //
                // 🔴 Det här är den enda instrumentering som hade namngett felet den
                // 30 augusti direkt. Loopen satt då 34,3 sekunder inne i
                // `build_mic_capture`, och eftersom reconcilen, enhetspollen och
                // nivåaggregeringen alla bor i samma varv stod allt stilla samtidigt.
                // Uppmätt i apploggen: mellan 13:22:12.684 ("Selected input device")
                // och 13:22:47.013 ("Mic stream started") skrevs INTE EN RAD från den
                // här loopen. Tre inspelningar startades och stoppades under tiden, två
                // av dem utan mikrofon. Felet syntes alltså bara som ett HÅL i loggen —
                // och ett hål är det svåraste som finns att upptäcka, eftersom det
                // kräver att någon läser tidsstämplarna och undrar över mellanrummet.
                //
                // Raden nedan gör hålet till en utskrift. Den säger inte var loopen
                // stod, men den säger ATT den stod, hur länge, och vid vilken tidpunkt
                // — vilket är skillnaden mellan "något är konstigt" och en sökbar rad.
                let tick_gap = last_tick.elapsed();
                if loop_stalled(tick_gap) {
                    println!(
                        "🔴 AUDIO: övervakningsloopen stod stilla i {:.1} s — ett blockerande \
                         anrop (enhetsbygge/enhetsenumerering) höll varvet. Mic-reconcile, \
                         enhetspoll och nivåuppdatering var pausade hela tiden.",
                        tick_gap.as_secs_f32()
                    );
                }
                last_tick = Instant::now();

                // --- Resultat från ett pågående MÖTET-bygge ---
                // Ligger i varvets topp (~20 ms) och inte i 2s-pollen: en färdig fångst
                // ska installeras när den är klar, inte upp till två sekunder senare.
                if let Some(built) = pending_sys_build.poll() {
                    let pinned_name = pending_sys_build.take_pinned();
                    debug_assert!(sys_capture.is_none(), "bygge klart medan en fångst redan fanns");
                    // Inspelningen kan ha stoppats medan bygget pågick. Då är fångsten
                    // inte längre önskad, och att installera den vore att återinföra
                    // precis den vilande tap som den lata livscykeln finns för att
                    // undvika — den skulle sedan ligga kvar tills nästa inspelning.
                    // 🔴 `sys_capture_wanted`, inte `!is_recording`. Villkoret MÅSTE vara
                    // samma predikat som reconcilen använde när den beställde bygget.
                    // Var det inte det: på Windows är en fångst önskad även i vila, medan
                    // det här villkoret läste `is_recording` rått och släppte den —
                    // varpå reconcilen beställde en ny i nästa varv. Bygge → släpp →
                    // bygge, femtio gånger i sekunden, i viloläge. Exakt den churn hela
                    // ändringsserien finns för att ta bort, införd av dess egen fix.
                    if built.is_some() && !sys_capture_wanted(*is_recording.lock().unwrap()) {
                        println!("DEBUG: MÖTET-bygget blev klart men fångsten är inte längre önskad — släpps");
                        drop(built);
                        sys_built_at = None;
                        last_sys_probe = None;
                        continue;
                    }
                    sys_capture = built;
                    if sys_capture.is_some() {
                        // Streaken nollas INTE här — se sys_capture_was_stable. Ett bygge
                        // som returnerar Some säger bara att API:t tog emot anropet.
                        sys_built_at = Some(Instant::now());
                        if sys_fail_streak > 0 {
                            println!(
                                "DEBUG: MÖTET-fångsten byggd igen efter {} misslyckade försök \
                                 — räknas som lyckad först efter {} s utan fel",
                                sys_fail_streak,
                                SYS_STABLE_AFTER.as_secs()
                            );
                        }
                    } else {
                        sys_built_at = None;
                        sys_fail_streak = sys_fail_streak.saturating_add(1);
                        let wait = sys_retry_backoff(sys_fail_streak);
                        sys_retry_at = Some(Instant::now() + wait);
                        println!(
                            "DEBUG: MÖTET-fångsten kunde inte startas ({} i rad) — nytt försök om {} s",
                            sys_fail_streak,
                            wait.as_secs()
                        );
                    }
                    // Pinnad bind som misslyckades eller föll tillbaka till default →
                    // tillbaka till Default och endpointen i karantän, så att metersvepet
                    // inte retry-loopar en endpoint som vägrar loopback.
                    if let Some(name) = pinned_name {
                        let bound_ok = sys_capture.as_ref()
                            .map(|c| c.device_name == name)
                            .unwrap_or(false);
                        if !bound_ok {
                            println!("DEBUG: Pinned bind to {:?} failed — quarantining", name);
                            pinned_quarantine = Some((name, Instant::now()));
                            sys_target = SysTarget::Default;
                        }
                    }
                    if let Some(cap) = &sys_capture {
                        // Ny enhet får en fräsch tystnadsfrist innan guardrail-varningen.
                        last_sys_audible = Instant::now();
                        let _ = app_handle_main.emit("sys-device-changed", cap.device_name.clone());
                    }
                }

                // --- Lat mic-livscykel: håll mic-INPUT öppen bara när den behövs ---
                // mic_wanted = aktiv inspelning ELLER Settings-mikrofontest (mic_preview).
                // Detta är ENDA stället som BYGGER mic-strömmen från None — 2s-pollen nedan
                // droppar bara en ström som behöver bytas och låter reconcilen bygga om inom
                // en ~20ms-tick. Loopbacken (MÖTET) och session-recordern rörs aldrig.
                {
                    let mic_wanted =
                        *is_recording.lock().unwrap() || *mic_preview.lock().unwrap();
                    if mic_wanted {
                        // Throttla bygg-försöket: direkt första gången (None), därefter ≥ 2 s
                        // mellan misslyckade försök så en upptagen mic inte retry-loopar hett
                        // (reconcilen kör varje ~20ms-varv).
                        let may_try_build = mic_capture.is_none()
                            && last_mic_build_attempt
                                .map_or(true, |t| t.elapsed() >= Duration::from_secs(2));
                        if may_try_build {
                            last_mic_build_attempt = Some(Instant::now());
                            let desired = desired_mic.lock().unwrap().clone();
                            match build_mic_capture(
                                &host, &app, &level_tx, &session_tx, &settings, &is_recording,
                                &session_state, desired,
                            ) {
                                Ok(cap) => {
                                    println!("DEBUG: Mic opened lazily on {:?}", cap.device_name);
                                    mic_capture = Some(cap);
                                    mic_error_emitted = false;
                                    last_mic_build_attempt = None;
                                }
                                Err(e) => {
                                    // Micen kunde inte öppnas. UNDER INSPELNING är detta den
                                    // graciösa degraderingen till MÖTET-only (t.ex. micen hålls
                                    // av ett webbmöte): inspelningen fortsätter, vi visar ett
                                    // INFORMATIVT `mic-unavailable`-event — aldrig den röda
                                    // "Mikrofonfel"-toasten. Utanför inspelning (bara preview)
                                    // är det ett vanligt mic-fel. Engångs per episod.
                                    if !mic_error_emitted {
                                        mic_error_emitted = true;
                                        if *is_recording.lock().unwrap() {
                                            eprintln!(
                                                "AUDIO: mic otillgänglig — degraderar till MÖTET-only: {}",
                                                e
                                            );
                                            let _ = app.emit("mic-unavailable", e);
                                        } else {
                                            let _ = app.emit("audio-error", format!("Mikrofonfel: {}", e));
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        // Micen är inte önskad. Släpp en ev. öppen ström → sample-kanalen
                        // kopplas ner, processor-tråden avslutas och force-flushar ev. pågående
                        // DU-segment. Släpper micen för andra appar.
                        if mic_capture.is_some() {
                            println!("DEBUG: Mic released (viloläge — ej inspelning/preview)");
                            mic_capture = None;
                            current_mic = 0.0;
                        }
                        // Nollställ felstate OVILLKORLIGT på viloläge-kanten så nästa episod
                        // börjar rent — även efter en loopback-only-inspelning där micen
                        // ALDRIG byggdes (mic_capture var None hela tiden). Annars skulle
                        // mic_error_emitted/last_mic_build_attempt läcka vidare: en andra
                        // degraderad inspelning i rad fick ingen mic-unavailable-toast, och
                        // en snabb stopp/start kunde fördröja första mic-försöket upp till 2 s.
                        mic_error_emitted = false;
                        last_mic_build_attempt = None;
                    }
                }

                // --- Lat MÖTET-livscykel: håll tappen bara under inspelning ---
                //
                // 🔴 Uppmätt 2026-09-01 på den installerade appen: tappen byggdes vid
                // motorstart och revs ALDRIG. Efter två dygns overksam körning höll den
                // fortfarande en `PreventUserIdleSystemSleep`-spärr (namngiven
                // `ai.sagt.motet.aggregate.context`) och den inbyggda högtalarens
                // IO-motor. Datorn kunde alltså inte somna så länge appen var öppen, och
                // på Apple Silicon hölls den I2S-motor som högtalare och `Digital Mic`
                // delar igång dygnet runt.
                //
                // Mikrofonen fick sin lata livscykel av samma skäl ("så länge appen bara
                // ligger öppen hålls micen INTE"); MÖTET fick den aldrig, trots att den
                // kostar mer.
                //
                // Ingen konsument förlorar något: `settings-page.tsx` visar bara
                // mic-nivån, och `control-bar.tsx` visar systemnivån enbart när
                // `isRecording` är sant. Kontrollerat i frontend, inte antaget.
                //
                // ⚠️ Medveten kostnad: MÖTET är uppe först en bit in i inspelningen i
                // stället för från sampel 0.
                //
                // Storleken på den kostnaden gissade jag fel på i planen ("~70 ms", ur
                // tap-byggets egen tid 46–55 ms). Uppmätt 2026-09-02 blev det **2,5
                // sekunder**, och orsaken är inte tappen: mic-reconcilen ligger före i
                // samma varv och `build_mic_capture` blockerar loopen tills cpal öppnat
                // enheten. Sekvensen ur apploggen:
                //
                //     21:11:03.826  Recording START
                //     21:11:03.827  Selected input device        <- mic-bygget börjar
                //     21:11:06.325  Mic stream started           <- 2,5 s senare
                //     21:11:06.340  Core Audio tap startad       <- tappen 15 ms efter
                //
                // Tappen kostar alltså 15 ms; mic-öppningen dominerar helt. Just den
                // körningen var första inspelningen efter ett nytt TCC-medgivande; i
                // normalläge visar loggen 97 ms (13:56:30.839→.936) och 191 ms
                // (17:11:04.508→.699) för samma steg.
                //
                // Ordningen är ändå rätt: mikrofonen är den obligatoriska kanalen och
                // ska byggas först. Att mic-bygget självt är synkront i loopen är ett
                // eget, kvarstående fynd — samma familj som det som just åtgärdades för
                // MÖTET, och nu det enda blockerande anropet kvar i varvet.
                {
                    let sys_wanted = sys_capture_wanted(*is_recording.lock().unwrap());
                    if sys_wanted {
                        // Sonden kostar ett par CoreAudio-anrop, så den throttlas — men
                        // FÖRSTA försöket sker direkt (None), annars hade varje
                        // inspelning börjat med upp till en sekunds MÖTET-tystnad.
                        let may_probe = sys_capture.is_none()
                            && !pending_sys_build.is_pending()
                            && sys_rebuild_allowed(sys_retry_at, Instant::now())
                            && last_sys_probe
                                .map_or(true, |t: Instant| t.elapsed() >= Duration::from_secs(1));
                        if may_probe {
                            last_sys_probe = Some(Instant::now());
                            if sys_capture_worth_attempting() {
                                let pinned_name = match &sys_target {
                                    SysTarget::Pinned(n) => Some(n.clone()),
                                    SysTarget::Default => None,
                                };
                                pending_sys_build.request(
                                    SysBuildCtx {
                                        app: app.clone(),
                                        level_tx: level_tx.clone(),
                                        session_tx: session_tx.clone(),
                                        settings: settings.clone(),
                                        is_recording: is_recording.clone(),
                                        session_state: session_state.clone(),
                                    },
                                    pinned_name,
                                );
                            }
                        }
                    } else if sys_capture.is_some() {
                        // ⚠️ ÖPPET FYND, medvetet lämnat. Nedrivningen sker HÄR, på
                        // övervakningsloopens tråd: droppen kör `AudioDeviceStop`,
                        // `AudioDeviceDestroyIOProcID`, `AudioHardwareDestroyAggregateDevice`
                        // och `AudioHardwareDestroyProcessTap` — samma HAL som kan blockera
                        // ~15 s vid start. Bygget flyttades till egen tråd; nedrivningen
                        // gjorde det inte, och den gick från att ske sällan (enhetsbyte,
                        // fel) till att ske vid VARJE inspelningsstopp.
                        //
                        // Varför den lämnas: uppmätt 2026-09-02 tog hela nedrivningen 7 ms
                        // (21:35:39.255 → .262). Att göra den asynkron kräver en
                        // reaper-tråd och en till kanal i en loop som redan fått fyra
                        // strukturella ändringar i samma serie, och skulle byta en mätt
                        // 7-millisekunderskostnad mot oprövad samtidighet. Händer det ändå
                        // rapporteras det av `loop_stalled`, som finns just för att den
                        // här sortens gap inte ska vara osynliga.
                        println!("DEBUG: MÖTET-tappen släppt (viloläge — ej inspelning)");
                        sys_capture = None;
                        sys_built_at = None;
                        current_sys = 0.0;
                        // Nästa inspelning ska sonderas direkt, inte efter en sekund.
                        last_sys_probe = None;
                    } else {
                        last_sys_probe = None;
                    }
                }

                // Use a shorter timeout to stay responsive but drain messages
                match level_rx.recv_timeout(Duration::from_millis(20)) {
                    Ok(input) => {
                        match input {
                            AudioInput::Mic(v) => current_mic = v,
                            AudioInput::System(v) => {
                                current_sys = v;
                                // Loopback är digital: äkta tystnad är exakt 0.0. Högre
                                // tröskel skulle ge falsk varning vid tyst-men-närvarande
                                // ljud (lågt uppspelningsvolym).
                                if v > 0.0 {
                                    last_sys_audible = Instant::now();
                                    // Systemljud flödar igen — släck en aktiv varning och
                                    // åter-arma den (se RecordingState::on_sys_audio).
                                    if let Some(rec) = rec_state.as_mut() {
                                        if rec.on_sys_audio() {
                                            let _ = app_handle_main.emit("audio-warning-cleared", ());
                                        }
                                    }
                                }
                            },
                        }
                    },
                    Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                        // Continue to check emission time
                    },
                    Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
                }

                // Throttle emissions to max 20Hz (every 50ms)
                if last_emit.elapsed() >= Duration::from_millis(50) {
                     let _ = app_handle_main.emit("audio-amplitude", AudioPayload {
                        mic: current_mic,
                        system: current_sys,
                    });
                    last_emit = Instant::now();
                }

                // Loopens livstecken. Se `heartbeat_interval` för varför takten
                // skiljer sig mellan inspelning och vila. Ett låstag per varv, som
                // reconcilen ovan redan tar — inte ett nästlat villkor, som hade
                // tagit låset 50 ggr/s under hela viloperiodens 30 sekunder.
                if last_log.elapsed() >= heartbeat_interval(*is_recording.lock().unwrap()) {
                    println!("DEBUG: RMS Levels - Mic: {:.4}, Sys: {:.4}", current_mic, current_sys);
                    last_log = Instant::now();
                }

                // --- Follow-the-audio-metersvep (1 s) ---
                // Läser peaknivå per render-endpoint (billigt, ingen capture-ström) och
                // pinnar loopbacken till den endpoint som faktiskt låter när den bundna
                // är tyst. Två vägar:
                //   Snabbspår: inspelning pågår och MÖTET har inte levererat ett enda
                //   sampel > 0 — klassiska Teams-fallet (samtalet på kommunikations-
                //   enheten, loopbacken på console-defaulten) — byt så fort någon annan
                //   endpoint låter.
                //   Långsamt spår: bunden endpoint tyst ≥ 4 s och samma kandidat hörbar
                //   två svep i rad — täcker byten mitt i möte utan att rycka i onödan.
                if last_meter_poll.elapsed() >= Duration::from_secs(1) {
                    last_meter_poll = Instant::now();
                    let bound_silent_for = last_sys_audible.elapsed();
                    // Svep endast under inspelning (se follow-the-audio-state ovan).
                    // 2 s nåd efter senaste ljud/rebind — hindrar oscillation mellan två
                    // samtidigt ljudande endpoints och ger en ny bind tid att leverera.
                    if *is_recording.lock().unwrap()
                        && (sys_capture.is_none() || bound_silent_for >= Duration::from_secs(2))
                    {
                        let levels = crate::audio_meter::render_endpoint_levels();
                        if levels.iter().any(|l| l.peak > 0.001) {
                            // Gatead på rec_state utan beteendeskillnad: utanför inspelning
                            // läses fältet aldrig, och i kantfönstret raderade start-kantens
                            // nollställning ändå värdet innan första läsningen. LASTBÄRANDE-
                            // invarianten (None-init + 5s-tröskel) bor i note_endpoint_audible.
                            if let Some(rec) = rec_state.as_mut() {
                                rec.note_endpoint_audible();
                            }
                        }
                        let bound_name = sys_capture.as_ref().map(|c| c.device_name.clone());
                        let quarantined = pinned_quarantine.as_ref().and_then(|(name, at)| {
                            (at.elapsed() < Duration::from_secs(30)).then(|| name.clone())
                        });
                        let candidate = levels
                            .into_iter()
                            .filter(|l| l.peak > 0.001)
                            .filter(|l| Some(&l.name) != bound_name.as_ref())
                            .filter(|l| Some(&l.name) != quarantined.as_ref())
                            .max_by(|a, b| a.peak.total_cmp(&b.peak))
                            .map(|l| l.name);
                        match candidate {
                            Some(name) => {
                                let streak = match &candidate_streak {
                                    Some((n, c)) if *n == name => c + 1,
                                    _ => 1,
                                };
                                candidate_streak = Some((name.clone(), streak));
                                // Streak ≥ 2 på BÅDA spåren — en enstaka notisplings på
                                // fel endpoint får aldrig rycka loopbacken. Snabbspåret
                                // (MÖTET har inte levererat något alls denna inspelning)
                                // slipper bara 4s-tystnadskravet, inte dämpningen.
                                let fast_path = rec_state.as_ref()
                                    .is_some_and(|r| !r.sys_had_audio);
                                let slow_path = bound_silent_for >= Duration::from_secs(4);
                                if streak >= 2 && (fast_path || slow_path) {
                                    println!(
                                        "DEBUG: Follow-the-audio: pinning loopback to {:?} (fast={}, streak={})",
                                        name, fast_path, streak
                                    );
                                    sys_target = SysTarget::Pinned(name);
                                    force_sys_rebind = true;
                                    candidate_streak = None;
                                }
                            }
                            None => candidate_streak = None,
                        }
                    } else {
                        candidate_streak = None;
                    }
                }

                if last_device_poll.elapsed() >= Duration::from_secs(2) {
                    last_device_poll = Instant::now();
                    // Ett låstag per poll — läses av unpin-invarianten och guardrailen.
                    let recording_now = *is_recording.lock().unwrap();

                    // --- Mic-rebind (endast DROP): enhetsbyte i Inställningar (desired
                    // ändrad), WASAPI-invalidering (failed-flaggan), default-mic-byte när
                    // "Standardenhet" är vald, eller självläkning när vald mic dyker upp igen.
                    // Vi DROPPAR bara den befintliga strömmen här; reconcilen i loopens topp
                    // äger (åter)byggnaden mot `desired` och bygger om inom en ~20ms-tick
                    // (R3 — ett enda byggställe + en felväg). None => ingen åtgärd: micen är
                    // antingen inte önskad, eller så bygger reconcilen den redan.
                    let mic_needs_rebind = match &mic_capture {
                        Some(cap) => {
                            let desired = desired_mic.lock().unwrap().clone();
                            cap.failed.load(Ordering::SeqCst)
                                || cap.requested != desired
                                || match &desired {
                                    None => host.default_input_device()
                                        .and_then(|d| d.name().ok())
                                        .as_deref() != Some(cap.device_name.as_str()),
                                    // Vald enhet saknades vid bindningen (fallback till
                                    // default) — bind om så fort den finns igen.
                                    Some(name) => cap.device_name != *name
                                        && input_device_exists(&host, name),
                                }
                        }
                        None => false,
                    };
                    if mic_needs_rebind {
                        if let Some(cap) = mic_capture.take() {
                            println!(
                                "DEBUG: Dropping mic for rebind (failed={}, old={:?})",
                                cap.failed.load(Ordering::SeqCst), cap.device_name
                            );
                            // Droppa gamla strömmen FÖRST — aldrig två aktiva mic-strömmar.
                            // Nedkopplad sample-kanal avslutar gamla processor-tråden, som
                            // force-flushar sitt pågående VAD-segment. Reconcilen bygger om
                            // mot aktuell `desired` nästa varv.
                            drop(cap);
                        }
                        current_mic = 0.0;
                    }

                    // Rebind-beslut per target-läge:
                    //   Default: som tidigare — felad ström (WASAPI invaliderar endpointen
                    //   vid same-name-replug), default-namnbyte, eller självläkning när en
                    //   utgång dyker upp igen.
                    //   Pinned: felad ström eller force efter target-byte; försvinner
                    //   endpointen ur aktiva listan → tillbaka till Default. Default-
                    //   namnbytet ignoreras medvetet i pinned-läge — annars skulle det
                    //   slåss mot pinnen var 2 s.
                    let default_out_name = host.default_output_device().and_then(|d| d.name().ok());
                    // INVARIANT: pinned utan pågående inspelning är alltid fel state —
                    // pinnen hör till inspelningen den skapades i. Städas här varje poll
                    // (inte bara på stopp-kanten) så att även en blixtsnabb start+stopp
                    // som aldrig hann skapa RecordingState inte lämnar en kvarlämnad pin
                    // som kapar nästa sessions MÖTET-kanal. Placeringen före exists-
                    // kontrollen gör också att idle-appen aldrig COM-enumererar för en
                    // pin som ändå ska släppas.
                    if !recording_now && matches!(sys_target, SysTarget::Pinned(_)) {
                        println!("DEBUG: Not recording — unpinning loopback, reverting to default");
                        sys_target = SysTarget::Default;
                        // Ingen `force_sys_rebind` här längre: utanför inspelning finns
                        // ingen fångst att binda om, och att tvinga fram ett bygge vore
                        // att återinföra just den tap som den lata livscykeln tog bort.
                    }
                    if let SysTarget::Pinned(name) = &sys_target {
                        // Meter-enumereringen i stället för cpal: output_devices() format-
                        // probar varje endpoint och är för tungt att köra var 2 s.
                        if !crate::audio_meter::render_endpoint_exists(name) {
                            println!("DEBUG: Pinned endpoint {:?} disappeared — reverting to default", name);
                            sys_target = SysTarget::Default;
                            force_sys_rebind = true;
                        }
                    }
                    // --- Felad fångst: riv alltid, och bokför om den aldrig fungerade ---
                    //
                    // Låg tidigare som en arm i `needs_rebind` nedan (`failed` => true)
                    // och gick därmed förbi backoffen helt. Se `sys_capture_was_stable`
                    // för varför det gav en ombyggnad var annan sekund utan tak.
                    //
                    // Att riva direkt är dessutom rätt oavsett när vi bygger om: en död
                    // fångst levererar inte ett sampel men håller kvar sitt aggregat,
                    // sin IO-kontext och — på macOS — sömnspärren.
                    if sys_capture.as_ref().is_some_and(|c| c.failed.load(Ordering::SeqCst)) {
                        let stable = sys_capture_was_stable(sys_built_at, Instant::now());
                        if let Some(cap) = sys_capture.take() {
                            println!(
                                "DEBUG: MÖTET-fångsten felade (enhet {:?}, hann bli stabil: {}) — river",
                                cap.device_name, stable
                            );
                            drop(cap);
                        }
                        sys_built_at = None;
                        current_sys = 0.0;
                        if stable {
                            // Den fungerade i minst en halv minut och dog sedan: en
                            // faktisk händelse i omvärlden. Bygg om direkt.
                            //
                            // 🔴 INGEN `force_sys_rebind` här. Fångsten är redan tagen,
                            // så `needs_rebind`-grinden (som kräver `sys_capture.is_some()`)
                            // kan inte fyra i det här varvet — flaggan hade blivit
                            // strandad, reconcilen byggt en ny fångst, och NÄSTA poll
                            // rivit den nybyggda på den kvarlämnade flaggan. Två aggregat
                            // per återhämtning i stället för ett. Reconcilen äger
                            // bygge-från-ingenting; den behöver ingen flagga för det.
                            sys_fail_streak = 0;
                            sys_retry_at = None;
                            // Sondera direkt i nästa varv i stället för att vänta ut
                            // throttlingen — enheten försvann just, svaret kan ha ändrats.
                            last_sys_probe = None;
                        } else {
                            // Den föll i samma andetag som den byggdes. Bygget var alltså
                            // aldrig lyckat, och ett till på samma villkor blir det inte
                            // heller — in i trappan.
                            sys_fail_streak = sys_fail_streak.saturating_add(1);
                            let wait = sys_retry_backoff(sys_fail_streak);
                            sys_retry_at = Some(Instant::now() + wait);
                            println!(
                                "DEBUG: MÖTET-fångsten föll direkt efter bygget ({} i rad) — nytt försök om {} s",
                                sys_fail_streak,
                                wait.as_secs()
                            );
                        }
                    }

                    // En fångst som levt igenom stabilitetsfönstret har bevisat sig.
                    // Nollställningen bor HÄR och inte vid det lyckade bygget: ett bygge
                    // som returnerar `Some` säger bara att CoreAudio/WASAPI tog emot
                    // anropet, och att kalla det ett lyckat försök är precis det som
                    // gjorde att trappan aldrig kunde klättra.
                    if sys_fail_streak > 0
                        && sys_capture.is_some()
                        && sys_capture_was_stable(sys_built_at, Instant::now())
                    {
                        println!(
                            "DEBUG: MÖTET-fångsten stabil i {} s — nollställer felräknaren (var {})",
                            SYS_STABLE_AFTER.as_secs(), sys_fail_streak
                        );
                        sys_fail_streak = 0;
                        sys_retry_at = None;
                    }

                    // 🔴 Aldrig ett andra bygge medan ett pågår. Två samtidiga byggen
                    // vore två aggregat, alltså exakt den churn hela den här historiken
                    // handlar om. `force_sys_rebind` nollställs INTE här utan inne i
                    // grenen, så en begäran som krockar med ett pågående bygge går fram
                    // vid nästa poll i stället för att tappas.
                    // 🔴 Pollen BESLUTAR, reconcilen BYGGER. Att bygga från `None`
                    // hörde tidigare hemma här, men efter den lata livscykeln finns det
                    // beslutet i reconcilen (som vet om en inspelning pågår och kör var
                    // ~20 ms i stället för var 2 s). Ett enda byggställe — samma regel
                    // som mic-vägen redan följer.
                    //
                    // Kvar här: byte av utenhet mitt i en inspelning, och `force` efter
                    // ett follow-the-audio-målbyte. Båda kräver en BEFINTLIG fångst att
                    // binda om, och båda är meningslösa utanför inspelning.
                    //
                    // `sys_capture.is_some()` är lastbärande, inte defensivt: utan det
                    // kunde ett `force_sys_rebind` som blivit kvar från förra sessionens
                    // metersvep starta ett bygge HÄR, förbi reconcilens
                    // `sys_capture_worth_attempting()`-gate — alltså en tap mot en
                    // möjligen vilande utgång, vilket är hela felet som grinden finns för.
                    // `sys_capture_wanted` och inte `recording_now`: på Windows ska
                    // ombindning vid utgångsbyte ske även utanför inspelning, precis som
                    // före den lata livscykeln.
                    let needs_rebind = sys_capture_wanted(recording_now)
                        && !pending_sys_build.is_pending()
                        && sys_capture.is_some()
                        && (force_sys_rebind || match (&sys_target, &sys_capture) {
                        (SysTarget::Default, Some(cap)) =>
                            default_out_name.as_deref() != Some(cap.device_name.as_str()),
                        _ => false,
                    });
                    if needs_rebind {
                        force_sys_rebind = false;
                        let pinned_name = match &sys_target {
                            SysTarget::Pinned(n) => Some(n.clone()),
                            SysTarget::Default => None,
                        };
                        if let Some(cap) = sys_capture.take() {
                            println!(
                                "DEBUG: Rebinding system loopback (failed={}, old={:?}, pinned={:?}, default={:?})",
                                cap.failed.load(Ordering::SeqCst), cap.device_name, pinned_name, default_out_name
                            );
                            // Droppa gamla strömmen FÖRST — aldrig två aktiva loopbacks.
                            // Nedkopplad sample-kanal avslutar gamla processor-tråden,
                            // som force-flushar sitt pågående VAD-segment.
                            drop(cap);
                        }
                        current_sys = 0.0;
                        // Bygget sker utanför loopen; resultatet installeras i varvets
                        // topp. Allt som förut låg här — streak, backoff, karantän,
                        // sys-device-changed — bor nu i den grenen, eftersom det är där
                        // utfallet är känt.
                        pending_sys_build.request(
                            SysBuildCtx {
                                app: app.clone(),
                                level_tx: level_tx.clone(),
                                session_tx: session_tx.clone(),
                                settings: settings.clone(),
                                is_recording: is_recording.clone(),
                                session_state: session_state.clone(),
                            },
                            pinned_name,
                        );
                    }

                    // Guardrail "audio-warning": inspelning aktiv ≥ 5 s utan loopback
                    // eller utan hörbart systemljud på ≥ 5 s → varna en gång per
                    // inspelning. Gäller ALLA lägen (lokalt + moln) — betatestarens
                    // Teams-möte kördes lokalt och det gamla molnvillkoret dolde
                    // problemet tills efteråt. 10 s → 5 s: i möteskontext är varje
                    // förlorad replik dyr, och follow-the-audio-switchen har redan
                    // hunnit försöka innan varningen fyrar.
                    // 🔴 EN sondering per poll, delad av diagnosraden och båda
                    // guardrail-besluten. Sonden enumererar systemets process-objekt och
                    // gör två CoreAudio-anrop per objekt — tiotals IPC-anrop mot
                    // coreaudiod, på den tråd som inte får blockera. Att anropa den två
                    // eller tre gånger per varv vore att fördubbla just den exponering
                    // som resten av den här ändringsserien handlar om att minska.
                    let playing_now = if recording_now {
                        someone_else_is_playing()
                    } else {
                        None
                    };
                    // Sammanhängande uppspelning måste ha en STARTTID — se
                    // SUSTAINED_PLAYBACK. `Some(false)`, `None` och "inte längre
                    // inspelning" nollar alla, så en ny uppspelning börjar om från noll.
                    match playing_now {
                        Some(true) => {
                            if playing_since.is_none() {
                                playing_since = Some(Instant::now());
                            }
                        }
                        _ => playing_since = None,
                    }
                    let playing_for = playing_since.map(|t: Instant| t.elapsed());

                    if recording_now {
                        if rec_state.is_none() {
                            // Start-kant: färskt per-inspelnings-state (RecordingState::new).
                            let mut rec = RecordingState::new();
                            // LOCKSTEP med new(): fältet lever utanför structen (se decl —
                            // muteras även utanför inspelning) men denna reset är lastbärande
                            // per inspelning. Utan den läser tystnadsvarningen en stale
                            // timestamp från idle-perioden före start — som antingen fyrar
                            // falskt eller undertrycker en äkta varning. Ingen kod får
                            // hamna mellan new() och den här raden.
                            last_sys_audible = Instant::now();
                            // Start-kanten ger ETT färskt försök: backoffen finns för att
                            // skydda en overksam app mot aggregat-churn, inte för att neka en
                            // användare som just tryckt på inspelning.
                            //
                            // 🔴 Bara väntetiden nollas — streaken lämnas orörd med avsikt.
                            // Nollställs även den börjar trappan om på 5 s, och eftersom varje
                            // försök blockerar ~14 s i AudioDeviceStart blir det fyra aggregat
                            // under inspelningens första två minuter. Det är exakt den churn
                            // som river mikrofonen ur en pågående session, alltså felet fixen
                            // finns för — återinfört i det läge där det skadar mest. Med
                            // streaken kvar går ett misslyckat försök direkt tillbaka till
                            // den väntetid som redan var uppnådd.
                            if sys_capture.is_none() && sys_retry_at.is_some() {
                                println!(
                                    "DEBUG: Inspelning startad — ger MÖTET ett försök till (streak {} kvar)",
                                    sys_fail_streak
                                );
                            }
                            sys_retry_at = None;
                            // Pre-flight: startar inspelningen helt utan loopback finns
                            // inget att vänta på — varna omedelbart.
                            //
                            // 🔴 ...men inte medan ett bygge pågår. Med den lata
                            // livscykeln begärs tappen först när inspelningen startar,
                            // så ett pågående bygge är NORMALFALLET de första
                            // tiondelarna av varje session. Utan det här villkoret hade
                            // varje inspelning som råkar starta strax före en 2s-poll
                            // fått "Systemljud är inte tillgängligt" — en varning som
                            // motsäger sig själv en bråkdel av en sekund senare, och det
                            // säkraste sättet att lära användaren att ignorera bannern.
                            if sys_capture.is_none()
                                && !pending_sys_build.is_pending()
                                && missing_capture_is_a_problem(playing_now)
                            {
                                let _ = app_handle_main
                                    .emit("audio-warning", rec.fire_preflight_warning());
                            }
                            rec_state = Some(rec);
                        }

                        // Guardrailens INDATA, en gång per poll under inspelning. Raden
                        // finns för att ett supportärende ska gå att avgöra utan att
                        // gissa: varför varnade den, eller varför varnade den inte.
                        // Kostar 30 rader per minuts inspelning — försumbart mot de
                        // 43 644 tystnadsrader i viloläge som fynd 7 tog bort.
                        //
                        // 🔴 Ligger EFTER start-kanten, inte före. Start-kanten nollställer
                        // `last_sys_audible`, så raden ovanför den visade tiden sedan
                        // MOTORSTART i stället för sedan inspelningsstart. Uppmätt på
                        // Windows 2026-09-08: `bunden_tystnad=2509s` på första raden i en
                        // inspelning, `2s` på nästa. Ofarligt för logiken, men en logg som
                        // ska läsas i ett supportärende får inte inleda varje inspelning
                        // med ett tal som ser ut som ett fel.
                        println!(
                            "DEBUG: MÖTET-diagnos: fångst={}, bygge_pågår={}, annan_uppspelning={:?}, bunden_tystnad={:.0}s",
                            sys_capture.is_some(),
                            pending_sys_build.is_pending(),
                            playing_now,
                            last_sys_audible.elapsed().as_secs_f32()
                        );
                    } else {
                        // Stopp-kant: släck banner som hör till inspelningen — droppen av
                        // RecordingState ÄR nollställningen av övrigt per-inspelnings-state.
                        // Unpin sköts av invarianten före pinned-kontrollen ovan (körs varje
                        // poll utan inspelning). candidate_streak nollas av metersvepets
                        // else-gren när inspelning inte pågår.
                        if let Some(rec) = rec_state.take() {
                            if rec.banner_visible() {
                                let _ = app_handle_main.emit("audio-warning-cleared", ());
                            }
                        }
                        // En `force` som satts av metersvepet strax före stopp hör till
                        // den avslutade inspelningen och får inte följa med in i nästa.
                        force_sys_rebind = false;
                    }

                    // Tystnadsgrenen: varningen betyder "det låter någonstans men vi
                    // fångar det inte". Ren diktering utan uppspelning är äkta tystnad
                    // och ska inte ge banner.
                    //
                    // Underlaget för "det låter någonstans" skiljer sig per plattform:
                    // Windows läser metersvepet, macOS process-sonden. Se
                    // `someone_else_is_playing` för varför macOS saknade svar helt.
                    if let Some(rec) = rec_state.as_mut() {
                        if rec.silence_warning_ready() {
                            let windows_endpoint_audible = rec
                                .last_any_endpoint_audible
                                .is_some_and(|t| t.elapsed() < Duration::from_secs(5));
                            let bound_silent =
                                last_sys_audible.elapsed() >= Duration::from_secs(5);
                            let problem = if sys_capture.is_none() {
                                !pending_sys_build.is_pending()
                                    && missing_capture_is_a_problem(playing_now)
                            } else {
                                bound_silent
                                    && silent_capture_is_a_problem(
                                        playing_for,
                                        windows_endpoint_audible,
                                    )
                            };
                            if problem {
                                // 🔴 Varningen loggas. Den emitterades tidigare bara som
                                // Tauri-event, så när en användare 2026-09-08 rapporterade
                                // en gul banner gick det inte att se i loggen ATT den
                                // fyrat — bara att räkna ut det ur diagnosradens indata.
                                // Ett larm som inte lämnar spår är svårt att felsöka av
                                // exakt samma skäl som en tyst degradering är det.
                                println!(
                                    "AUDIO: tystnadsvarning fyrar (fångst={}, uppspelning_i={:?}, bunden_tystnad={:.0}s)",
                                    sys_capture.is_some(),
                                    playing_for,
                                    last_sys_audible.elapsed().as_secs_f32()
                                );
                                let _ = app_handle_main
                                    .emit("audio-warning", rec.fire_silence_warning());
                            }
                        }
                    }
                }
             }
             // Städa flaggan — men BARA om vi fortfarande är den aktuella motorn.
             //
             // Två skäl. En tråd som avslutas för att en nyare motor startat får inte
             // släcka den nyares flagga. Och utan städningen alls fanns hålet åt andra
             // hållet: bryter loopen av något annat skäl än stop() står `is_running`
             // kvar på true, och varje senare `init_audio_engine` blir en tyst no-op —
             // appen har då ingen ljudmotor och inget sätt att få en.
             //
             // Kontrollen sker UNDER låset, inte bredvid det. Utanför fanns ett fönster
             // där start() hann läsa flaggan som true (och returnera "kör redan") strax
             // innan vi satte den till false — resultatet hade blivit noll motorer och
             // en flagga som sa att allt var i sin ordning. Med båda under samma lås är
             // de två utfallen de enda möjliga: antingen hinner start() först och har
             // då redan bumpat generationen (vi rör inget), eller så hinner vi först och
             // start() ser ett ärligt false.
             {
                 let mut running = is_running.lock().unwrap();
                 if engine_generation_is_current(my_gen) {
                     *running = false;
                 }
             }
             println!("DEBUG: Audio listener loop exited (generation {})", my_gen);
        });

        Ok(())
    }

    pub fn start_recording(&self) -> Result<(), String> {
        let mut rec = self.is_recording.lock().unwrap();
        *rec = true;
        println!("DEBUG: Recording START signal sent");
        // Reset session state
        let mut session = self.session_state.lock().unwrap();
        session.segments.clear();
        session.wav_path = None;
        session.start_time = Some(SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
        session.pending_transcriptions = 0;
        session.duration_sec = 0.0;
        
        Ok(())
    }

    pub fn stop_recording(&self) -> Result<(), String> {
        let mut rec = self.is_recording.lock().unwrap();
        *rec = false;
        println!("DEBUG: Recording STOP signal sent");
        Ok(())
    }

    pub fn stop(&self) {
        let mut running = self.is_running.lock().unwrap();
        *running = false;
        // Bumpa generationen: det är DEN som faktiskt avslutar trådarna. Flaggan här
        // säger bara till en framtida start() att den får spawna på nytt.
        // `gen` som variabelnamn undviks med flit: det blir ett nyckelord i
        // Rust-edition 2024, och en editionsbump ska inte fälla en orelaterad fil.
        let ny_generation = bump_engine_generation();
        println!("DEBUG: Stop signal sent (motorgeneration nu {})", ny_generation);
    }
}

// Keep the stream alive by binding it to a variable, instead of forgetting it
// This ensures it drops when the thread exits (which happens when loop breaks)
// StreamGuard removed (unused)

// Unsafe impl for StreamGuard removed (unused) 
// Wait, we can't move StreamGuard into the thread if it's not Send.
// But the stream is created inside the thread. So we just need to keep it in a variable.
// No need for Send wrapper if distinct variable.



/// Aktiv mic-fångst mot en specifik (eller default-) ingångsenhet. Samma drop-semantik
/// som SysCapture: droppad ström kopplar ner sample-kanalen, processor-tråden avslutas
/// och force-flushar pågående VAD-segment.
struct MicCapture {
    /// Håller cpal-strömmen vid liv; drop = stoppa fångsten.
    _stream: cpal::Stream,
    /// Faktiskt bundet enhetsnamn — jämförs mot aktuell default-ingång var 2 s
    /// när ingen specifik enhet är vald.
    device_name: String,
    /// Enhetsnamnet som begärdes vid bindningen (None = default). Skiljer sig från
    /// device_name vid fallback — jämförs mot desired_mic så att en fallback inte
    /// triggar rebind varje poll.
    requested: Option<String>,
    /// Sätts av cpal:s error-callback när endpointen invalideras → trigga rebind.
    failed: Arc<AtomicBool>,
}

/// Bygger mic-fångsten mot begärd enhet (fallback: default-ingång) och spawnar dess
/// processor-tråd. Till skillnad från best-effort-build_sys_capture är felvägen Result:
/// anroparen avgör om felet är fatalt (motorstart → fail!) eller toast + retry var 2 s
/// (rebind i huvudloopen) — mic-vägen är alltid fail-loud, aldrig tyst.
fn build_mic_capture(
    host: &cpal::Host,
    app: &AppHandle,
    level_tx: &Sender<AudioInput>,
    session_tx: &Sender<SessionChunk>,
    settings: &Arc<Mutex<AudioSettings>>,
    is_recording: &Arc<Mutex<bool>>,
    session_state: &Arc<Mutex<SessionState>>,
    requested: Option<String>,
) -> Result<MicCapture, String> {
    let mic_device_opt = if let Some(ref name) = requested {
        find_input_device(host, name).or_else(|| {
            println!("DEBUG: Requested device not found, falling back to default");
            host.default_input_device()
        })
    } else {
        host.default_input_device()
    };
    let mic_device = match mic_device_opt {
        Some(d) => d,
        None => return Err("Ingen mikrofon hittades. Anslut en mikrofon och försök igen.".to_string()),
    };
    let device_name = mic_device.name().unwrap_or_default();
    println!("DEBUG: Selected input device: {:?}", device_name);

    let mic_config = mic_device.default_input_config()
        .map_err(|e| format!("Kunde inte läsa mikrofonens konfiguration: {}", e))?;

    let (mic_sample_tx, mic_sample_rx) = unbounded::<f32>();
    let mic_sample_rate = mic_config.sample_rate().0;
    let failed = Arc::new(AtomicBool::new(false));

    // Felflaggan ger mic:en samma same-name-replug-läkning som loopbacken: WASAPI
    // invaliderar endpointen → error-callback → rebind i huvudloopen.
    let mic_stream_res = match mic_config.sample_format() {
        cpal::SampleFormat::F32 => run_stream::<f32>(&mic_device, &mic_config.clone().into(), mic_sample_tx, Some(failed.clone())),
        cpal::SampleFormat::I16 => run_stream::<i16>(&mic_device, &mic_config.clone().into(), mic_sample_tx, Some(failed.clone())),
        cpal::SampleFormat::U16 => run_stream::<u16>(&mic_device, &mic_config.clone().into(), mic_sample_tx, Some(failed.clone())),
        fmt => return Err(format!("Ljudformatet stöds inte: {:?}", fmt)),
    };
    // Felen loggas OCH returneras. Returvärdet blir en toast för användaren;
    // loggraden är det enda som ger tidpunkt och enhetsnamn, och därmed det enda
    // som går att korrelera mot systemets egen ljudlogg vid en efterhandsanalys.
    // Utan den syns bara att något gick fel, aldrig mot vilken enhet eller när.
    let stream = mic_stream_res.map_err(|e| {
        let msg = format!("Kunde inte skapa mikrofonström: {}", e);
        eprintln!("DEBUG: {} (enhet {:?})", msg, device_name);
        msg
    })?;
    stream.play().map_err(|e| {
        let msg = format!("Kunde inte starta mikrofonström: {}", e);
        eprintln!("DEBUG: {} (enhet {:?})", msg, device_name);
        msg
    })?;
    println!("DEBUG: Mic stream started on {:?}", device_name);

    // Processor-tråden får nya enhetens samplerate → korrekt resample-ratio.
    // Kloner av samma session_tx/level_tx → DU-segment och SessionChunks
    // fortsätter in i pågående session efter en rebind.
    let app_handle_mic = app.clone();
    let settings_mic = settings.clone();
    let is_recording_mic = is_recording.clone();
    let session_state_mic = session_state.clone();
    let mic_level_tx = level_tx.clone();
    let mic_session_tx = session_tx.clone();

    thread::spawn(move || {
        process_audio_stream(
            mic_sample_rx,
            mic_sample_rate,
            "DU",
            app_handle_mic,
            Some((mic_level_tx, true)),
            settings_mic,
            Some(("mic".to_string(), mic_session_tx)),
            is_recording_mic,
            session_state_mic,
        );
    });

    Ok(MicCapture { _stream: stream, device_name, requested, failed })
}

/// Hittar ingångsenheten med exakt detta namn, om den finns just nu.
fn find_input_device(host: &cpal::Host, name: &str) -> Option<cpal::Device> {
    host.input_devices().ok()?
        .find(|d| d.name().map(|n| n == name).unwrap_or(false))
}

/// Finns en ingångsenhet med exakt detta namn just nu? (För självläkning: vald enhet
/// som saknades vid bindningen binds om så fort den dyker upp igen.)
fn input_device_exists(host: &cpal::Host, name: &str) -> bool {
    find_input_device(host, name).is_some()
}

/// Hittar utgångsenheten med exakt detta namn, om den finns just nu.
/// Namnen matchar audio_meter::render_endpoint_levels() — båda är WASAPI:s
/// PKEY_Device_FriendlyName.
fn find_output_device(host: &cpal::Host, name: &str) -> Option<cpal::Device> {
    host.output_devices().ok()?
        .find(|d| d.name().map(|n| n == name).unwrap_or(false))
}

/// Vilken render-endpoint MÖTET-loopbacken ska följa.
///
/// `Default` = Windows console-default (dagens beteende). `Pinned(name)` = en specifik
/// endpoint som huvudloopens metersvep pekat ut som den som faktiskt låter. Behövs för
/// att Teams/Zoom/Slack routar samtalsljud till *default kommunikationsenhet* (ofta ett
/// BT-headsets HFP-endpoint) — en annan endpoint än console-defaulten, så en loopback
/// som bara följer default_output_device() blir tyst mitt i mötet.
///
/// Designval: EN loopback som binds om ("follow-the-audio") i stället för att fånga
/// alla endpoints samtidigt — session-recordern parar mic/sys sampel-för-sampel till
/// stereo-WAV och MergedVad förutsätter en enda sys-producent; en mixer för N strömmar
/// vore en ombyggnad av hela nedströmskedjan. Per-process-loopback (fånga Teams direkt)
/// stöds inte av cpal — framtida möjlighet.
enum SysTarget {
    Default,
    Pinned(String),
}

/// Tystnadsvarningens läge under en inspelning. Ersätter bool-paret
/// audio_warning_sent/audio_warning_active: inom en inspelning var bara
/// kombinationerna false/false och true/true nåbara, så lägena är exakt två.
enum WarningState {
    /// Ingen banner synlig — varningen får fyra när villkoren uppfylls. Både
    /// startläget och läget efter re-arm (systemljud flödade igen).
    Armed,
    /// Banner synlig — släcks och åter-armas via on_sys_audio när ljud flödar igen.
    Warned,
}

/// Per-inspelnings-state för guardrail-varningen "audio-warning" (inspelning pågår
/// men inget systemljud fångas). Skapas på 2s-pollens start-kant och droppas på
/// stopp-kanten — "en gång per inspelning" är därmed struct-livstiden, inte en
/// nollställningslista som måste hållas i synk på flera ställen.
struct RecordingState {
    /// När start-kanten detekterades — varningströskeln (≥ 5 s) mäts härifrån.
    started: Instant,
    warning: WarningState,
    /// Cooldown mellan tystnadsvarningar. Re-arm-flödet (ljud → cleared → ny
    /// tystnad → ny varning) får inte flimra bannern var 5:e sekund i fall där
    /// ljudet hoppar mellan endpoints snabbare än follow-the-audio hinner pinna.
    /// Sätts BARA av tystnadsvarningen — pre-flight-varningen rör den inte.
    last_warning_fired: Option<Instant>,
    /// Har MÖTET-kanalen levererat något ljud alls under inspelningen?
    /// false + hörbar annan endpoint = snabbspåret (Teams på kommunikations-
    /// enheten medan loopbacken lyssnar på console-defaulten).
    sys_had_audio: bool,
    /// Senaste svep där NÅGON render-endpoint var hörbar. Gate för tystnads-
    /// varningen: låter det ingenstans (ren diktering utan uppspelning) finns
    /// inget att fånga och ingen varning att ge.
    /// INVARIANT som gör timestampen färsk när den behövs: svep-grinden öppnar
    /// vid 2 s bunden tystnad och varningströskeln ligger på 5 s — svepet har
    /// alltså hunnit köra ≥ 3 gånger innan varningsvillkoret läser värdet.
    /// Sänk aldrig 5s-tröskeln under svep-grindens 2 s + en svepperiod.
    last_any_endpoint_audible: Option<Instant>,
}

impl RecordingState {
    /// Start-kanten: färsk inspelning = färskt varningsstate — en timestamp från
    /// förra sessionen får varken öppna eller blockera varningen.
    fn new() -> Self {
        Self {
            started: Instant::now(),
            warning: WarningState::Armed,
            last_warning_fired: None,
            sys_had_audio: false,
            last_any_endpoint_audible: None,
        }
    }

    /// Systemljud flödar igen: släck en synlig banner och ÅTERAKTIVERA varningen —
    /// blir det tyst ≥ 5 s igen ska en ny varning fyra. Utan re-arm skulle en enda
    /// ljudblipp avväpna guardrailen för resten av inspelningen. Cooldownen
    /// (last_warning_fired) behålls avsiktligt över re-arm. Returnerar true när
    /// "audio-warning-cleared" ska emittas.
    fn on_sys_audio(&mut self) -> bool {
        self.sys_had_audio = true;
        match self.warning {
            WarningState::Warned => {
                self.warning = WarningState::Armed;
                true
            }
            WarningState::Armed => false,
        }
    }

    /// Metersvepet såg en hörbar render-endpoint — notera tidpunkten. Enda skrivaren
    /// av `last_any_endpoint_audible`, så LASTBÄRANDE-invarianten (None-init i new()
    /// + 5s-varningströskeln ⇒ ≥ 3 svep innan värdet läses) hålls hos fältets ägare
    /// i stället för spridd på anropsplatsen. Se fältkommentaren + silence_warning_ready().
    fn note_endpoint_audible(&mut self) {
        self.last_any_endpoint_audible = Some(Instant::now());
    }

    /// Pre-flight på start-kanten: inspelning startad helt utan loopback — inget
    /// att vänta på, varna omedelbart. Startar INTE 20s-cooldownen: pre-flighten
    /// är ingen tystnadsvarning och ska inte skjuta upp en senare sådan.
    /// Returnerar banner-texten som MÅSTE emittas som "audio-warning" — övergången
    /// till Warned och emitten är oskiljbara, annars markeras bannern som visad
    /// utan att användaren sett den och guardrailen avväpnas tyst.
    fn fire_preflight_warning(&mut self) -> &'static str {
        self.warning = WarningState::Warned;
        "Systemljud är inte tillgängligt — mötesljud (MÖTET) spelas inte in"
    }

    /// Tystnadsvarningen fyrar: starta 20s-cooldownen. Returnerar banner-texten
    /// som MÅSTE emittas som "audio-warning" (samma kontrakt som pre-flighten).
    fn fire_silence_warning(&mut self) -> &'static str {
        self.warning = WarningState::Warned;
        self.last_warning_fired = Some(Instant::now());
        "Systemljud fångas inte — kontrollera ljudutgången"
    }

    /// Varningens inspelningsinterna grindar: armad, ≥ 5 s in i inspelningen och
    /// utanför 20s-cooldownen. Miljövillkoren (loopback saknas / bunden endpoint
    /// tyst men annan hörbar) ligger kvar vid anropsplatsen i 2s-pollen.
    fn silence_warning_ready(&self) -> bool {
        matches!(self.warning, WarningState::Armed)
            && self.started.elapsed() >= Duration::from_secs(5)
            && self.last_warning_fired
                .map_or(true, |t| t.elapsed() >= Duration::from_secs(20))
    }

    /// Stopp-kanten äger bara bannern: true = "audio-warning-cleared" ska emittas.
    fn banner_visible(&self) -> bool {
        matches!(self.warning, WarningState::Warned)
    }
}

/// Aktiv WASAPI-loopback mot en specifik utgångsenhet. När strömmen droppas kopplas
/// sample-kanalen ner, processor-tråden avslutar sin `for sample in rx`-loop och
/// force-flushar pågående VAD-segment — gamla trådar städar alltså sig själva.
/// Bäraren av den aktiva systemljudsfångsten. Windows använder cpal:s WASAPI-
/// loopback, macOS en Core Audio-tap. Båda är RAII: drop = fångsten stoppar.
#[cfg(not(target_os = "macos"))]
type SysStream = cpal::Stream;
#[cfg(target_os = "macos")]
type SysStream = crate::mac_sysaudio::MacSysStream;

/// Avkodar HTML-entiteter som KB-Whisper matar ut i klartext.
///
/// # Varför den behövs
///
/// Modellen skriver ibland ut bokstavliga entiteter i stället för tecknet. Uppmätt
/// 2026-08-30 med den bundlade `whisper-cli` och `ggml-kb-whisper-small.bin`:
///
/// ```text
/// talat:  "Intäkterna ligger nio procent över plan"
/// utdata: "Intäkterna ligger 9&nbsp;% över plan"
/// ```
///
/// Råa bytes bekräftade med `xxd`: `39 26 6e 62 73 70 3b 25` — alltså ASCII-tecknen
/// `&nbsp;`, inte ett U+00A0. Ingenting städade dem, och eftersom React escapar text
/// såg användaren strängen `&nbsp;` mitt i sitt transkript.
///
/// Felet är **indataberoende, inte slumpmässigt**: samma ljud ger samma utdata
/// (beam-size 1 är deterministisk). Ett testklipp gav entiteten i två av två
/// körningar, ett annat gav vanligt mellanslag i samma position. Sällsynt men
/// reproducerbart per inspelning — alltså inget man kan vänta ut.
///
/// `&nbsp;` blir U+00A0, inte ett vanligt mellanslag: det är vad entiteten betyder,
/// och hårt mellanslag före `%` är dessutom typografiskt korrekt på svenska.
///
/// # Varför en enda genomgång och inte kedjade `replace`
///
/// Kedjade ersättningar måste avkoda `&amp;` sist, annars blir `&amp;nbsp;` — den
/// korrekta kodningen av den BOKSTAVLIGA texten `&nbsp;` — felaktigt till ett
/// mellanslag. En genomgång vänster till höger kan inte göra det misstaget.
///
/// # ⚠️ Täcker BARA den lokala vägen
///
/// Funktionen appliceras där `whisper-cli`:s stdout tolkas. **Molnvägen (Pro) går via
/// backend och passerar aldrig här.** Molnet kör KB-Whisper Large — samma modellfamilj
/// som den lokala small-modellen — så samma entitetsbeteende är rimligt att vänta sig,
/// men det är **overifierat**: molnmodellen har inte kunnat köras vid skrivandet.
///
/// Står här i stället för att antas, just därför att skillnaden är lätt att missa: en
/// Pro-användare kan se `9&nbsp;%` trots den här fixen, och felet ser då ut att vara
/// olöst. Rätt lösning är antingen samma avkodning i backend eller en gemensam punkt
/// som båda vägarna passerar.
fn avkoda_entiteter(text: &str) -> String {
    if !text.contains('&') {
        return text.to_string();
    }
    let mut ut = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        ut.push_str(&rest[..start]);
        let efter = &rest[start..];
        // En entitet är kort. Ligger nästa `;` längre bort är `&` bara ett vanligt
        // et-tecken i texten, och får inte sluka resten av meningen.
        match efter[1..].find(';').filter(|p| *p <= 8) {
            Some(p) => {
                let namn = &efter[1..1 + p];
                match entitet_till_tecken(namn) {
                    Some(c) => ut.push(c),
                    // Okänd entitet lämnas ORÖRD. Att gissa vore värre än att låta den
                    // stå: transkriptet är användarens ord, inte våra.
                    None => {
                        ut.push('&');
                        ut.push_str(namn);
                        ut.push(';');
                    }
                }
                rest = &efter[p + 2..];
            }
            None => {
                ut.push('&');
                rest = &efter[1..];
            }
        }
    }
    ut.push_str(rest);
    ut
}

fn entitet_till_tecken(namn: &str) -> Option<char> {
    match namn {
        "nbsp" => Some('\u{00A0}'),
        "amp" => Some('&'),
        "quot" => Some('"'),
        "apos" => Some('\''),
        "lt" => Some('<'),
        "gt" => Some('>'),
        _ => namn.strip_prefix('#').and_then(|n| {
            let kod = match n.strip_prefix(['x', 'X']) {
                Some(hex) => u32::from_str_radix(hex, 16).ok()?,
                None => n.parse::<u32>().ok()?,
            };
            char::from_u32(kod)
        }),
    }
}

/// Får MÖTET-fångsten byggas om nu, givet backoffen?
///
/// Egen ren funktion i stället för ett inline-villkor: grinden satt tidigare mitt
/// i en flerahundraradersloop och gick bara att verifiera genom att köra appen och
/// vänta på att felet skulle inträffa. Nu går den att testa.
fn sys_rebuild_allowed(retry_at: Option<Instant>, now: Instant) -> bool {
    retry_at.map_or(true, |t| now >= t)
}

/// Ett loopvarv som tagit längre tid än så har inte varit långsamt — det har stått
/// stilla. Övervakningsloopen tickar var ~20 ms (`recv_timeout`) och dess tyngsta
/// planerade arbete är 2s-pollen, så tröskeln ligger med bred marginal över allt
/// normalt och under den ~14 s ett misslyckat CoreAudio-bygge kostar.
const LOOP_STALL_AFTER: Duration = Duration::from_secs(5);

/// Ovanför det här är gapet inte ett blockerande anrop längre.
///
/// ⚠️ Taket finns för en fråga jag inte kunnat KÖRA: om `Instant` på macOS räknar
/// tid då datorn varit i vila. Gör den det, får varje uppvaknande ur lockläge ett
/// gap på timmar, och detektorn skulle skriva "loopen stod stilla i 28 800 s" —
/// ett självsäkert påstående om något som aldrig hänt, i just den logg den här
/// ändringen städar. Att verifiera det kräver att maskinen faktiskt sover, vilket
/// inte gick att göra här.
///
/// Taket gör frågan betydelselös i stället för besvarad: allt loopen realistiskt
/// kan blockera på ligger under det. Uppmätt tak i praktiken är CoreAudios
/// starttimeout (~15 s) och det värsta observerade fallet 34,3 s
/// (`build_mic_capture`, 2026-08-30) — 120 s är 3,5× det. Ett gap däröver kommer
/// från omvärlden, inte från ett anrop, och tigs därför ihjäl. Priset är att en
/// hypotetisk blockering längre än två minuter inte får någon egen rad; den syns
/// fortfarande som ett hål i livstecknet.
const LOOP_STALL_CEILING: Duration = Duration::from_secs(120);

/// Har övervakningsloopen stått stilla mellan två varv?
fn loop_stalled(gap: Duration) -> bool {
    gap >= LOOP_STALL_AFTER && gap <= LOOP_STALL_CEILING
}

/// Hur ofta loopens livstecken (`RMS Levels`) skrivs.
///
/// Under inspelning varje sekund: nivåerna per kanal ÄR diagnosen. En kanal som
/// ligger på 0.0000 hela sessionen är skillnaden mellan "tyst möte" och "mikrofonen
/// spelade aldrig in något", och den syns ingen annanstans i loggen.
///
/// I vila var 30:e sekund. Raden skrevs tidigare en gång per sekund oavsett läge,
/// och det gjorde loggen närmast obrukbar för sitt syfte — uppmätt på den
/// installerade appen 2026-09-01, efter drygt två dygns körning:
///
/// ```text
/// 43 644 av 43 851 rader (99,5 %) var det här livstecknet i viloläge
/// 207 rader var allt annat — fem inspelningar, en enhetsbindning, en rebind
/// ```
///
/// Rotationen vid 5 MB tar därmed ~ett dygns overksam körning, och en användare
/// som hör av sig om gårdagens möte har redan fått incidenten överskriven av
/// tystnadsrader. Med 30 s i vila räcker samma 5 MB en månad, medan takten under
/// inspelning — den enda tid nivåerna säger något — är oförändrad.
///
/// Loopens liveness täcks inte av den här raden längre utan av `loop_stalled`,
/// som rapporterar hål aktivt i stället för att lämna dem åt en läsare att upptäcka.
fn heartbeat_interval(recording: bool) -> Duration {
    if recording {
        Duration::from_secs(1)
    } else {
        Duration::from_secs(30)
    }
}

/// Ska MÖTET-fångsten hållas vid liv just nu?
///
/// **macOS: bara under inspelning.** En levande tap håller `PreventUserIdleSystemSleep`
/// och den I2S-motor som högtalare och `Digital Mic` delar — uppmätt 2026-09-01 höll en
/// overksam app båda i två dygn.
///
/// **Windows: alltid, som förut.** WASAPI-loopbacken har ingen motsvarande kostnad.
///
/// Det stod här som ett ANTAGANDE när gaten skrevs 2026-09-02, och antagandet var
/// motiveringen för hela plattformsgränsen — vilket var en rad för mycket att lita på.
/// Uppmätt 2026-09-08 på en Windows-maskin med `powercfg /requests`, med loopbacken
/// bunden och appen overksam i 41 minuter:
///
/// ```text
/// overksam, loopback bunden:  SYSTEM: None
/// under inspelning:           SYSTEM: Driver: Realtek High Definition Audio
/// ```
///
/// Den bundna loopbacken hindrar alltså inte systemet från att sova, och begäran under
/// inspelning är korrekt — då ska datorn hållas vaken. Ingen motsvarighet till macOS
/// `PreventUserIdleSystemSleep`, som hölls i två dygn av en overksam app.
///
/// (`powercfg /requests` har ingen `AUDIO`-rubrik; det är `SYSTEM` som gäller.)
///
/// Ett macOS-fix ska ändå inte ändra beteendet på plattformen det inte handlar om —
/// men nu vilar gränsen på en mätning i stället för på min gissning.
#[cfg(target_os = "macos")]
fn sys_capture_wanted(recording: bool) -> bool {
    recording
}

#[cfg(not(target_os = "macos"))]
fn sys_capture_wanted(_recording: bool) -> bool {
    true
}

/// Spelar någon ANNAN process ut ljud just nu? `None` = går inte att avgöra.
///
/// Guardrail-varningen behöver veta om det finns något att fånga. På Windows besvaras
/// den frågan av metersvepet (`last_any_endpoint_audible`); på macOS returnerar svepet
/// alltid tom vektor, och fältet var därför ALLTID `None` — varningen blev binär:
/// falsklarm vid ren diktering, och helt tyst när tappen fanns men gav nollor.
///
/// `None` på Windows är därför inte ett fel utan ett "den här plattformen svarar på
/// frågan någon annanstans", och anropsplatsen faller tillbaka på exakt det beteende
/// som gällde innan sonden fanns. Detsamma gäller en macOS-version där process-API:t
/// inte går att läsa.
#[cfg(target_os = "macos")]
fn someone_else_is_playing() -> Option<bool> {
    crate::mac_sysaudio::other_process_is_playing()
}

#[cfg(not(target_os = "macos"))]
fn someone_else_is_playing() -> Option<bool> {
    None
}

/// Ska en SAKNAD MÖTET-fångst varna användaren just nu?
///
/// Ja om vi inte vet bättre. Nej bara när vi VET att ingen spelar något — då finns
/// inget mötesljud att missa, och en banner vore ett falsklarm på det vanligaste av
/// alla lägen (diktering utan uppspelning). Att ett `None` varnar är avsiktligt: det
/// bevarar Windows-beteendet ("urdragen utgång ska ge banner även om inget råkar
/// spelas just då") oförändrat.
fn missing_capture_is_a_problem(playing: Option<bool>) -> bool {
    playing != Some(false)
}

/// Hur länge någon annan måste ha spelat innan vår tystnad blir ett bevis.
///
/// 🔴 Utan den här fördröjningen fyrade varningen på ljudets FRAMKANT. Uppmätt på den
/// signerade betan 2026-09-08:
///
/// ```text
/// 15:24:23.117  fångst=true, annan_uppspelning=Some(true), bunden_tystnad=6s  → varning
/// 15:24:23.177  Speech TRIGGERED on MÖTET at RMS: 0.0617   <- 60 ms senare hörde vi det
/// ```
///
/// Sonden ser att en process börjat mata ut ljud innan vårt eget resamplade 50 ms-block
/// hunnit fram. I det glappet ser tillståndet exakt ut som "de spelar och vi är döva",
/// och 2s-pollen råkar sampla där. Med intermittent ljud — någon som talar med pauser
/// längre än fem sekunder, alltså ett helt vanligt möte — träffar den regelbundet.
const SUSTAINED_PLAYBACK: Duration = Duration::from_secs(5);

/// Ska en TYST men existerande fångst varna?
///
/// Bara när någon annan spelat SAMMANHÄNGANDE en stund och vi ändå inte hört något. Det
/// är TCC-fallet: macOS nekar systemljud helt tyst — varje anrop returnerar noErr och
/// varje sampel är 0.0 — så "det låter i datorn men vår ström är digitalt tyst" är den
/// enda observerbara skillnaden mellan ett återkallat medgivande och ett tyst möte.
///
/// `playing_for` = hur länge den nuvarande uppspelningen pågått, `None` = ingen pågår.
/// Windows-vägen skickar i stället `windows_endpoint_audible`, som redan är utjämnad:
/// metersvepet svarar "någon endpoint hördes inom 5 s", inte "hörs just nu". Det var
/// den asymmetrin som gjorde macOS-grenen känslig för framkanten.
fn silent_capture_is_a_problem(
    playing_for: Option<Duration>,
    windows_endpoint_audible: bool,
) -> bool {
    windows_endpoint_audible || playing_for.is_some_and(|d| d >= SUSTAINED_PLAYBACK)
}

/// Hur länge en MÖTET-fångst måste ha levt för att räknas som fungerande.
const SYS_STABLE_AFTER: Duration = Duration::from_secs(30);

/// Hann fångsten bli stabil innan den föll?
///
/// Skiljer två fall som ser exakt likadana ut i `failed`-flaggan:
///
/// * en ström som körde i minuter och sedan dog (hörluren drogs ur, samplerate
///   omförhandlades) — en genuin händelse som ska ge en omedelbar ombyggnad, och
///
/// * en ström som dog i samma andetag som den byggdes — vilket betyder att bygget
///   aldrig fungerade, hur `Ok` det än såg ut.
///
/// 🔴 Skillnaden är hela poängen med funktionen. Backoffen som infördes 2026-08-30
/// sitter på armen `(SysTarget::Default, None)` i `needs_rebind`, alltså på fallet
/// "ingen fångst finns". Det andra fallet ovan går aldrig genom den armen: bygget
/// returnerar `Some`, streaken nollställs som efter ett lyckat försök, och nästa
/// 2s-poll ser `failed`-flaggan och river och bygger om — var annan sekund, i all
/// evighet, utan att någon räknare någonsin växer. Det är samma felform som gav 53
/// aggregat på tre timmar, fast med sju gånger tätare kadens, och den fanns kvar i
/// samma `match` som fixen skrevs in i.
///
/// `None` (inget bygge gjort) är per definition inte stabilt.
fn sys_capture_was_stable(built_at: Option<Instant>, now: Instant) -> bool {
    built_at.map_or(false, |t| now.saturating_duration_since(t) >= SYS_STABLE_AFTER)
}

/// Är det meningsfullt att försöka bygga MÖTET-fångsten just nu?
///
/// På macOS: nej om utenheten är vilande. En Core Audio-tap på en tyst utgång har
/// ingen klocka att haka i, så `AudioDeviceStart` blockerar ~15 s och faller med
/// `Error: 0x3C`. Se `mac_sysaudio::output_is_active` för mätningen.
///
/// Det är inte en förlust: är utgången tyst finns per definition inget mötesljud att
/// fånga. Nästa 2s-poll bygger fångsten så snart något börjar spelas, vilket är
/// precis vad användaren såg — MÖTET slog igång i samma stund som en video startade.
///
/// På Windows finns inte problemet: WASAPI-loopback binder mot endpointen oavsett om
/// någon spelar, så där svarar funktionen alltid ja och beteendet är oförändrat.
///
/// ⚠️ KÄND LUCKA, medvetet accepterad: upptäckten sker via 2s-pollen, så i ett möte
/// som varit helt tyst kan upp till två sekunder av den första repliken klippas —
/// utenheten startar när någon talar, men tappen byggs först vid nästa poll.
///
/// Det är ändå klart bättre än före ändringen, då samma scenario gav 15 s blockering,
/// noll mötesljud OCH en riven mikrofon. Men luckan är en permanent egenskap och står
/// därför skriven här i stället för att upptäckas av en kund som undrar var första
/// meningen tog vägen.
///
/// Rätt lösning är en `AudioObjectAddPropertyListener` på
/// `kAudioDevicePropertyDeviceIsRunningSomewhere`, som fyrar i samma ögonblick enheten
/// startar i stället för upp till två sekunder senare. Den är inte gjord här eftersom
/// den kräver en callback in i övervakningsloopen och inte gick att runtime-verifiera
/// i samma session som resten av fixen.
#[cfg(target_os = "macos")]
fn sys_capture_worth_attempting() -> bool {
    crate::mac_sysaudio::output_is_active()
}

#[cfg(not(target_os = "macos"))]
fn sys_capture_worth_attempting() -> bool {
    true
}

/// Väntetid innan MÖTET-fångsten får försöka igen efter ett misslyckande.
///
/// 5 s → 15 s → 60 s → tak 5 min. Taket finns för att ett fel som inte går över
/// av sig själv (ingen utenhet, nekad TCC, trasig drivrutin) annars kostar ett
/// aggregat var 14:e sekund resten av sessionen.
fn sys_retry_backoff(streak: u32) -> Duration {
    match streak {
        0 | 1 => Duration::from_secs(5),
        2 => Duration::from_secs(15),
        3 => Duration::from_secs(60),
        _ => Duration::from_secs(300),
    }
}

/// Allt ett MÖTET-bygge behöver, i ägd form så att det kan flyttas till en egen tråd.
#[derive(Clone)]
struct SysBuildCtx {
    app: AppHandle,
    level_tx: Sender<AudioInput>,
    session_tx: Sender<SessionChunk>,
    settings: Arc<Mutex<AudioSettings>>,
    is_recording: Arc<Mutex<bool>>,
    session_state: Arc<Mutex<SessionState>>,
}

/// Ett pågående bygge av MÖTET-fångsten.
///
/// # Varför bygget inte längre sker inline
///
/// `build_sys_capture` anropades tidigare mitt i övervakningsloopen. På macOS kan
/// `AudioDeviceStart` på ett aggregat blockera ~15 sekunder innan det faller med
/// `0x3C` (ETIMEDOUT), och under tiden står ALLT annat i loopen stilla — mic-reconcile,
/// enhetspoll, nivåuppdatering. Uppmätt värsta fall 2026-08-30: **34,3 sekunder**, med
/// tre inspelningar startade och stoppade inuti blockeringen, varav två helt utan
/// mikrofon. Mikrofonen är den obligatoriska kanalen och får aldrig vara gisslan hos
/// den valfria.
///
/// # Varför plattformarna delar tillståndsmaskin men inte tråd
///
/// macOS bygger på en egen tråd; Windows bygger synkront i `request()` och lämnar
/// resultatet i kanalen, så det plockas upp av nästa `poll()` ~20 ms senare. Det ger
/// EN kodväg i loopen i stället för två cfg-grenar mitt i beslutslogiken.
///
/// Windows kan inte bygga på tråd: cpal:s WASAPI-`Stream` håller en rå `HANDLE` och är
/// inte `Send`. ⚠️ Det ledet går inte att kompilera härifrån och är alltså inte
/// verifierat — men blockeringsproblemet är macOS-specifikt (WASAPI-loopback binder mot
/// endpointen oavsett om någon spelar), så Windows-vägen har inget att vinna på bytet
/// och lämnas med sitt beprövade beteende.
struct PendingSysBuild {
    rx: Option<Receiver<Option<SysCapture>>>,
    /// Vilken endpoint bygget begärdes mot (follow-the-audio). Måste överleva bygget:
    /// karantänsbeslutet efteråt behöver veta vad som försöktes.
    pinned: Option<String>,
}

impl PendingSysBuild {
    fn new() -> Self {
        Self { rx: None, pinned: None }
    }

    /// Pågår ett bygge? Anroparen får aldrig starta ett andra — två samtidiga byggen
    /// vore två aggregat, alltså exakt den churn hela historiken handlar om.
    fn is_pending(&self) -> bool {
        self.rx.is_some()
    }

    fn request(&mut self, ctx: SysBuildCtx, pinned: Option<String>) {
        debug_assert!(!self.is_pending(), "två samtidiga MÖTET-byggen");
        self.pinned = pinned.clone();
        self.rx = Some(spawn_sys_build(ctx, pinned));
    }

    /// `None` = fortfarande pågående. `Some(resultat)` = klart, och kanalen är tömd.
    ///
    /// En avbruten byggtråd (kanalen nedkopplad utan värde) behandlas som ett
    /// misslyckat bygge: det är sant, och alternativet vore ett `is_pending` som
    /// aldrig blir falskt och en MÖTET-kanal som aldrig byggs om.
    fn poll(&mut self) -> Option<Option<SysCapture>> {
        let rx = self.rx.as_ref()?;
        match rx.try_recv() {
            Ok(result) => {
                self.rx = None;
                Some(result)
            }
            Err(crossbeam_channel::TryRecvError::Empty) => None,
            Err(crossbeam_channel::TryRecvError::Disconnected) => {
                self.rx = None;
                eprintln!("DEBUG: MÖTET-byggtråden försvann utan resultat");
                Some(None)
            }
        }
    }

    /// Namnet bygget begärdes mot, konsumerat i samma veva som resultatet.
    fn take_pinned(&mut self) -> Option<String> {
        self.pinned.take()
    }
}

fn run_sys_build(ctx: &SysBuildCtx, pinned: Option<&str>) -> Option<SysCapture> {
    // Egen host: `cpal::Host` är en unit-struct på både macOS och Windows, så det här
    // kostar ingenting och slipper skicka en referens över trådgränsen.
    let host = cpal::default_host();
    build_sys_capture(
        &host,
        &ctx.app,
        &ctx.level_tx,
        &ctx.session_tx,
        &ctx.settings,
        &ctx.is_recording,
        &ctx.session_state,
        pinned,
    )
}

#[cfg(target_os = "macos")]
fn spawn_sys_build(ctx: SysBuildCtx, pinned: Option<String>) -> Receiver<Option<SysCapture>> {
    let (tx, rx) = crossbeam_channel::bounded(1);
    // Kopian finns för felvägen: `spawn` konsumerar closuren (och därmed ctx) även när
    // den failar, så utan den hade ett misslyckat trådstart inte gått att falla tillbaka
    // ifrån. Klonen är fyra Arc/Sender och ett AppHandle — den kostar ingenting.
    let ctx_fallback = ctx.clone();
    let pinned_fallback = pinned.clone();
    let tx_fallback = tx.clone();

    let spawned = thread::Builder::new()
        .name("motet-build".into())
        .spawn(move || {
            // Skickas resultatet inte fram (motorn avslutades under bygget) droppas
            // fångsten HÄR, på den här tråden. Det är hela skälet till att
            // `MacSysStream` är `Send`.
            let _ = tx.send(run_sys_build(&ctx, pinned.as_deref()));
        });

    if let Err(e) = spawned {
        // Hellre en blockerad loop än ingen mötesfångst alls: trådstart failar bara vid
        // resursbrist, och då är en sekunds blockering det minsta av problemen.
        eprintln!("DEBUG: kunde inte starta MÖTET-byggtråden ({e}) — bygger synkront");
        let _ = tx_fallback.send(run_sys_build(&ctx_fallback, pinned_fallback.as_deref()));
    }
    rx
}

#[cfg(not(target_os = "macos"))]
fn spawn_sys_build(ctx: SysBuildCtx, pinned: Option<String>) -> Receiver<Option<SysCapture>> {
    // Synkront: cpal:s WASAPI-ström är inte `Send`. Resultatet ligger i kanalen och
    // plockas upp av nästa `poll()`, så tillståndsmaskinen ser likadan ut för anroparen.
    let (tx, rx) = crossbeam_channel::bounded(1);
    let _ = tx.send(run_sys_build(&ctx, pinned.as_deref()));
    rx
}

struct SysCapture {
    /// Håller strömmen vid liv; drop = stoppa fångsten.
    _stream: SysStream,
    /// Enhetsnamnet vid bindning — jämförs mot aktuell default-utgång var 2 s.
    device_name: String,
    /// Sätts av cpal:s error-callback när endpointen invalideras → trigga rebind.
    failed: Arc<AtomicBool>,
}

/// Bygger systemljudfångsten (WASAPI-loopback) och spawnar dess processor-tråd.
/// `target: Some(name)` binder mot en specifik endpoint (follow-the-audio); saknas den
/// eller vägrar den starta (vissa BT-HFP-endpoints tar inte loopback) faller vi tillbaka
/// till default-utgången REDAN HÄR — utan intern fallback skulle en vägrande pin lämna
/// sys_capture = None till nästa 2s-poll, dvs. ett fångstgap mitt i inspelningen.
/// Anroparen upptäcker fallbacken via device_name-mismatch och återgår till
/// SysTarget::Default + karantän. `target: None` = default-utgången (dagens beteende).
/// Best-effort: alla felvägar → None (mic-vägen dör aldrig av saknat systemljud).
/// Anropas vid motorstart och vid varje rebind i huvudloopen.
fn build_sys_capture(
    host: &cpal::Host,
    app: &AppHandle,
    level_tx: &Sender<AudioInput>,
    session_tx: &Sender<SessionChunk>,
    settings: &Arc<Mutex<AudioSettings>>,
    is_recording: &Arc<Mutex<bool>>,
    session_state: &Arc<Mutex<SessionState>>,
    target: Option<&str>,
) -> Option<SysCapture> {
    if let Some(name) = target {
        match find_output_device(host, name) {
            Some(device) => {
                if let Some(cap) = try_sys_capture(
                    device, app, level_tx, session_tx, settings, is_recording, session_state,
                ) {
                    return Some(cap);
                }
                eprintln!("DEBUG: Pinned device {:?} failed to start, falling back to default", name);
            }
            None => {
                eprintln!("DEBUG: Pinned output device {:?} not found, falling back to default", name);
            }
        }
    }
    let sys_device = match host.default_output_device() {
        Some(d) => d,
        None => {
            eprintln!("DEBUG: No output device found");
            return None;
        }
    };
    try_sys_capture(sys_device, app, level_tx, session_tx, settings, is_recording, session_state)
}

/// Försöker starta loopback-fångst mot exakt denna enhet — ingen fallback här;
/// build_sys_capture äger fallback-beslutet.
#[cfg(not(target_os = "macos"))]
fn try_sys_capture(
    sys_device: cpal::Device,
    app: &AppHandle,
    level_tx: &Sender<AudioInput>,
    session_tx: &Sender<SessionChunk>,
    settings: &Arc<Mutex<AudioSettings>>,
    is_recording: &Arc<Mutex<bool>>,
    session_state: &Arc<Mutex<SessionState>>,
) -> Option<SysCapture> {
    let device_name = sys_device.name().unwrap_or_default();
    println!("DEBUG: Binding system loopback to: {:?}", device_name);

    let sys_config = match sys_device.default_output_config() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("DEBUG: Failed to read output config: {}", e);
            return None;
        }
    };

    let (sys_sample_tx, sys_sample_rx) = unbounded::<f32>();
    let sys_sample_rate = sys_config.sample_rate().0;
    let sys_stream_config: cpal::StreamConfig = sys_config.clone().into();
    let failed = Arc::new(AtomicBool::new(false));

    // Loopback levereras interleavat (oftast stereo). run_stream medel-
    // värdesbildar kanalerna per frame till mono — precis som mic-vägen.
    // Att skicka råa interleavade samples som mono gav MÖTET-ljud i halv
    // hastighet (en oktav ner) i både live-transkriberingen och sessions-
    // WAV:en, vilket förstörde kvaliteten för lokal OCH moln-transkribering.
    let sys_stream_res = match sys_config.sample_format() {
        cpal::SampleFormat::F32 => run_stream::<f32>(&sys_device, &sys_stream_config, sys_sample_tx, Some(failed.clone())),
        cpal::SampleFormat::I16 => run_stream::<i16>(&sys_device, &sys_stream_config, sys_sample_tx, Some(failed.clone())),
        cpal::SampleFormat::U16 => run_stream::<u16>(&sys_device, &sys_stream_config, sys_sample_tx, Some(failed.clone())),
        fmt => {
            eprintln!("DEBUG: Ljudformatet stöds inte för systemljud: {:?}", fmt);
            return None;
        }
    };

    let stream = match sys_stream_res {
        Ok(s) => s,
        Err(e) => {
            eprintln!("DEBUG: Failed to build system stream: {}", e);
            return None;
        }
    };
    if let Err(e) = stream.play() {
        // System loopback is best-effort: log and continue with mic only,
        // never kill the engine over missing system audio.
        eprintln!("DEBUG: Failed to start system stream (continuing mic-only): {}", e);
        return None;
    }
    println!("DEBUG: System stream started on {:?}", device_name);

    // Processor-tråden får nya enhetens samplerate → korrekt resample-ratio.
    // Kloner av samma session_tx/level_tx → MÖTET-segment och SessionChunks
    // fortsätter in i pågående session efter en rebind.
    let app_handle_sys = app.clone();
    let settings_sys = settings.clone();
    let is_recording_sys = is_recording.clone();
    let session_state_sys = session_state.clone();
    let sys_level_tx = level_tx.clone();
    let sys_session_tx = session_tx.clone();

    thread::spawn(move || {
        process_audio_stream(
            sys_sample_rx,
            sys_sample_rate,
            "MÖTET",
            app_handle_sys,
            Some((sys_level_tx, false)),
            settings_sys,
            Some(("sys".to_string(), sys_session_tx)),
            is_recording_sys,
            session_state_sys,
        );
    });

    Some(SysCapture { _stream: stream, device_name, failed })
}

/// macOS-motsvarigheten: Core Audio Taps i stället för WASAPI-loopback.
///
/// Kontraktet är identiskt med Windows-versionen — en `Sender<f32>` med
/// kanalmedelvärdesbildade samples, en samplerate, och en RAII-guard — så allt
/// nedströms (`process_audio_stream`, stereo-parningen, `extract_meeting_channel`,
/// live-diariseringen) är orört.
///
/// Tappen binds till default-utgången internt, så `sys_device` styr inte VAD som
/// fångas. Den används ändå — för sitt NAMN.
///
/// 🔴 `device_name` måste komma från cpal, inte från CoreAudios enhets-UID.
/// Rebind-loopen jämför fältet mot `default_out_name`, som är cpal:s namn
/// (`"MacBook Air Speakers"`). CoreAudios UID är en annan sträng
/// (`"BuiltInSpeakerDevice"`), och med den i fältet blir jämförelsen ALLTID olika →
/// `needs_rebind` alltid sant → tappen rivs och byggs om var annan sekund, för
/// alltid. Kompilerar felfritt, låter förfärligt.
#[cfg(target_os = "macos")]
fn try_sys_capture(
    sys_device: cpal::Device,
    app: &AppHandle,
    level_tx: &Sender<AudioInput>,
    session_tx: &Sender<SessionChunk>,
    settings: &Arc<Mutex<AudioSettings>>,
    is_recording: &Arc<Mutex<bool>>,
    session_state: &Arc<Mutex<SessionState>>,
) -> Option<SysCapture> {
    use crate::mac_sysaudio::{self, Permission};

    // 🔴 Behörigheten läses FÖRE varje fångst, inte bara vid appstart. Användaren
    // kan återkalla den i Systeminställningar mitt i en session, och utan
    // behörighet nekar macOS HELT TYST: varje anrop returnerar noErr och varje
    // sampel är 0.0. En nekad behörighet går alltså inte att skilja från ett tyst
    // möte i efterhand — den skillnaden finns bara här.
    match mac_sysaudio::preflight() {
        Permission::Granted => {}
        Permission::NotDetermined => {
            // Dialogen visas asynkront. Vi väntar INTE på svaret: att blockera
            // motorstarten på en behörighetsfråga vore att hålla mic-vägen gisslan.
            // Nästa inspelning läser statusen och lyckas om användaren godkände.
            println!("DEBUG: Ljudbehörighet ej beslutad — begär, fortsätter mic-only");
            mac_sysaudio::request_permission();
            return None;
        }
        Permission::Denied => {
            eprintln!("DEBUG: Ljudbehörighet NEKAD — mic-only. Användaren måste slå på \
                       den i Systeminställningar → Integritet och säkerhet");
            return None;
        }
        Permission::Unknown => {
            // TCC gick inte att fråga (privat API kan försvinna i en macOS-version).
            // Försök ändå — ett misslyckat försök degraderar till mic-only ändå,
            // och att vägra i förväg vore att göra en okänd status till ett nej.
            eprintln!("DEBUG: Kunde inte läsa ljudbehörighet — försöker fånga ändå");
        }
    }

    let (sys_sample_tx, sys_sample_rx) = unbounded::<f32>();
    let failed = Arc::new(AtomicBool::new(false));

    // Namnet tas från cpal så att rebind-jämförelsen blir äppel-mot-äppel.
    // mac_sysaudio::start returnerar CoreAudio-UID:t, som bara loggas.
    let device_name = sys_device.name().unwrap_or_default();

    let (stream, sys_sample_rate, tap_device_uid) =
        match mac_sysaudio::start(sys_sample_tx, failed.clone()) {
            Ok(v) => v,
            Err(e) => {
                // Best-effort, samma semantik som Windows: systemljud som inte
                // startar ger mic-only, aldrig en död motor.
                eprintln!("DEBUG: Systemljud kunde inte startas (fortsätter mic-only): {}", e);
                return None;
            }
        };
    println!(
        "DEBUG: Core Audio tap startad på {:?} (UID {:?}) @ {} Hz",
        device_name, tap_device_uid, sys_sample_rate
    );

    let app_handle_sys = app.clone();
    let settings_sys = settings.clone();
    let is_recording_sys = is_recording.clone();
    let session_state_sys = session_state.clone();
    let sys_level_tx = level_tx.clone();
    let sys_session_tx = session_tx.clone();

    thread::spawn(move || {
        process_audio_stream(
            sys_sample_rx,
            sys_sample_rate,
            "MÖTET",
            app_handle_sys,
            Some((sys_level_tx, false)),
            settings_sys,
            Some(("sys".to_string(), sys_session_tx)),
            is_recording_sys,
            session_state_sys,
        );
    });

    Some(SysCapture { _stream: stream, device_name, failed })
}

fn run_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    tx: Sender<f32>,
    error_flag: Option<Arc<AtomicBool>>,
) -> Result<cpal::Stream, String>
where
    T: cpal::Sample + cpal::SizedSample + 'static + num_traits::cast::ToPrimitive,
{
    let tx = tx.clone();
    let channels = config.channels as usize;
    device.build_input_stream(
        config,
        move |data: &[T], _: &_| {
            for frame in data.chunks(channels) {
                let mut sum = 0.0;
                for sample in frame {
                    let val = (*sample).to_f32().unwrap_or(0.0);
                    if !val.is_nan() && !val.is_infinite() {
                        sum += val;
                    }
                }
                let avg = sum / channels as f32;
                let _ = tx.send(if avg.is_nan() { 0.0 } else { avg });
            }
        },
        move |err| {
            eprintln!("Stream error: {}", err);
            // Sys-loopbacken pollar flaggan var 2 s och binder om strömmen. Fångar
            // same-name-replug där WASAPI invaliderar endpointen utan att default-
            // utgångens namn ändras.
            if let Some(ref flag) = error_flag {
                flag.store(true, Ordering::SeqCst);
            }
        },
        None,
    ).map_err(|e| e.to_string())
}

fn process_audio_stream(
    rx: Receiver<f32>, 
    input_rate: u32, 
    source_label: &str, 
    app: AppHandle,
    level_info: Option<(Sender<AudioInput>, bool)>,
    settings: Arc<Mutex<AudioSettings>>,
    session_sender: Option<(String, Sender<SessionChunk>)>,
    is_recording: Arc<Mutex<bool>>,
    session_state: Arc<Mutex<SessionState>>,
) {
    println!("DEBUG: Starting processor for {}", source_label);
    
    let ratio = SAMPLE_RATE as f64 / input_rate as f64;
    let target_chunk = 800; // 800 samples @ 16kHz = 50ms = 20Hz updates
    let input_chunk_size = (target_chunk as f64 / ratio).ceil() as usize;

    // Use a VecDeque for continuous rolling buffer (Pre-roll)
    let mut pre_roll_buffer: VecDeque<f32> = VecDeque::with_capacity(PRE_ROLL_SAMPLES);
    
    let mut speech_buffer: Vec<f32> = Vec::new();
    let mut is_speaking = false;
    let mut silence_start = Instant::now();
    let mut count = 0;
    // input_buffer needs to be a ring buffer to handle variable chunk sizes from cpal safely
    let mut input_buffer: VecDeque<f32> = VecDeque::with_capacity(input_chunk_size * 2);

    // Live-diarisering (STEG 3): ackumulerar resamplad 16 kHz f32 till 100 ms-frames för
    // MÖTET-kanalen. Bara sys-processorn fyller den (gate nedan) → mic-processorns förblir tom.
    let mut live_frame_buffer: Vec<f32> = Vec::with_capacity(LIVE_DIARIZE_FRAME_SAMPLES * 2);
    
    // Talstart-tidsstämpel relativ till inspelningsstart (delad sessionsklocka, ms sedan epoch).
    // Båda kanalerna (mic/sys) jämförs mot samma session.start_time → korrekt ordning i vyn.
    let mut speech_start_ms: u128 = 0;

    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 128,
        window: WindowFunction::BlackmanHarris2,
    };

    // Ingen panik vid exotiska enhetsformat: tråden avslutas rent och rebind-loopen
    // försöker igen (sys), respektive fail-loud-vägen tar mic-fel vid motorstart.
    let mut resampler = match SincFixedIn::<f32>::new(
        ratio,
        2.0, // max deviation
        params,
        input_chunk_size,
        1
    ) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("ERROR: Failed to init resampler for {} (input rate {}): {}", source_label, input_rate, e);
            return;
        }
    };

    let mut rubato_input = vec![vec![0.0; input_chunk_size]; 1];

    for sample in rx {
        input_buffer.push_back(sample);
        
        // Only process when we have enough data for a full chunk
        if input_buffer.len() >= input_chunk_size {
             
             // Copy exactly input_chunk_size samples to rubato_input
             for i in 0..input_chunk_size {
                 rubato_input[0][i] = input_buffer[i];
             }
             
             // Remove processed samples from input_buffer (Ring buffer behavior)
             // This preserves any "extra" samples (e.g. 2401st sample) for next iteration
             input_buffer.drain(0..input_chunk_size);
             
             count += 1;

             // Calculate Input RMS for debugging (Check if source is silent)
             if cfg!(debug_assertions) && count % 100 == 0 { // Log occasionally
                 let mut in_sq = 0.0;
                 for x in &rubato_input[0] { in_sq += x * x; }
                 let in_rms = (in_sq / input_chunk_size as f32).sqrt();
                 if in_rms < 0.001 {
                      println!("DEBUG: Input Silence Detected on {} (RMS: {:.6})", source_label, in_rms);
                 }
             }

             let resampled_output_res = resampler.process(&rubato_input, None);
             
             if let Ok(output) = resampled_output_res {
                 let output_data = &output[0];

                 let mut sum_squares = 0.0;
                 for &x in output_data {
                     sum_squares += x * x;
                 }
                 let chunk_rms = (sum_squares / output_data.len() as f32).sqrt();
                 
                 // Send level update
                 if let Some((ref tx, is_mic)) = level_info {
                     let input = if is_mic { AudioInput::Mic(chunk_rms) } else { AudioInput::System(chunk_rms) };
                     let _ = tx.send(input);
                 }

                 // Send to Session Recorder ONLY if recording
                 if *is_recording.lock().unwrap() {
                     if let Some((ref tag, ref tx)) = session_sender {
                         let chunk_copy = output_data.to_vec();
                         let _ = tx.send(SessionChunk {
                             source: tag.clone(),
                             data: chunk_copy,
                         });
                     }
                 }

                 // Read current settings (needed in both recording and flush paths)
                 let (threshold, silence_duration, cloud_streaming, merge_channels, live_diarize) = {
                    let s = settings.lock().unwrap();
                    (s.vad_threshold, s.silence_duration_ms as u128, s.cloud_streaming, s.merge_channels, s.live_diarize)
                 };

                 // ── Live-diarisering (STEG 3): kontinuerlig MÖTET-ström till JS ──────────
                 // Endast sys/MÖTET-kanalen, endast under inspelning och när live_diarize är på.
                 // Emitterar 100 ms-frames (inkl. tystnad — pyannote behöver hela tidslinjen) i
                 // takt med ljudinfångningen → aldrig snabbare än realtid. JS strömmar dem vidare
                 // till Live-1-ws:en. Additivt: rör inte VAD/moln-vägen nedan.
                 if live_diarize && source_label == "sys" && *is_recording.lock().unwrap() {
                     live_frame_buffer.extend_from_slice(output_data);
                     while live_frame_buffer.len() >= LIVE_DIARIZE_FRAME_SAMPLES {
                         let frame: Vec<f32> =
                             live_frame_buffer.drain(0..LIVE_DIARIZE_FRAME_SAMPLES).collect();
                         let _ = app.emit("live-diarize-pcm", LiveDiarizePcm { samples: frame });
                     }
                 } else if !live_frame_buffer.is_empty() {
                     // Live av / inspelning stoppad → släng residualsampel så nästa session
                     // inte ärver en halv frame.
                     live_frame_buffer.clear();
                 }

                 // Gate VAD logic behind is_recording
                 if !*is_recording.lock().unwrap() {
                     // If not recording, prevent state buildup and clear buffers
                     if !speech_buffer.is_empty() {
                         // Flush whatever is in the buffer if we just stopped recording
                         let duration_ms = (speech_buffer.len() as f32 / SAMPLE_RATE as f32 * 1000.0) as u128;
                         if duration_ms > 100 { // Only flush if meaningful data (>0.1s)
                            println!("DEBUG: Recording stopped, flushing pending speech buffer on {} ({}ms)", source_label, duration_ms);
                            let start_offset = session_offset(&session_state, speech_start_ms);
                            dispatch_segment(&speech_buffer, source_label, &app, session_state.clone(), start_offset, cloud_streaming, merge_channels);
                         } else {
                            println!("DEBUG: Recording stopped, dropping short buffer on {} ({}ms)", source_label, duration_ms);
                         }
                         
                         is_speaking = false;
                         speech_buffer.clear();
                     }

                     // 🔴 PRE-ROLLEN MÅSTE TÖMMAS HÄR — den överlevde annars mellan
                     // inspelningar och tog med sig ljud från föregående session.
                     //
                     // Buffertens 2 sekunder fylls bara under inspelning (raderna
                     // nedanför den här grinden), och den här tråden lever kvar mellan
                     // inspelningar för MÖTET-kanalen — fångsten byggs vid motorstart
                     // och rivs först vid enhetsbyte eller fel. Utan tömningen stod
                     // alltså slutet av föregående inspelning kvar i bufferten, och
                     // nästa inspelning fick det inklistrat först i sitt första segment:
                     // `speech_buffer.extend(pre_roll_buffer.iter())` vid talstart.
                     //
                     // Träffas när tal utlöses inom 2 s från inspelningsstart, vilket är
                     // normalfallet — man trycker spela in och börjar prata. Följden är
                     // att upp till två sekunder ur ett tidigare möte transkriberas in i
                     // nästa mötes transkript, tyst och utan spår. För en produkt vars
                     // hela löfte är att transkriptet är kundens är det fel sorts fel.
                     //
                     // DU-kanalen råkar vara skyddad i dag av att mic-strömmen släpps
                     // mellan inspelningar (lat mic-livscykel) så att tråden med sin
                     // buffert avslutas — men det är en sidoeffekt av en annan feature,
                     // inte ett skydd. Tömningen hör hemma här, i den kanal som äger
                     // bufferten.
                     pre_roll_buffer.clear();

                     // Reset time tracking relative to recording start in session recorder?
                     // No, process_audio_stream runs continuously. 
                     // The session recorder tracks the actual file time.
                     // But for transcription timestamps to align with the file, we need to sync with "Recording Start".
                     // However, we are tracking total_16k_samples since APP START here.
                     // The Session Recorder starts writing at strict 16k.
                     // Ideally we should reset `total_16k_samples` when recording starts?
                     // BUT, pre-roll buffer exists!
                     // If we reset, we might mess up pre-roll timestamp.
                     // Simple solution: When `is_recording` becomes true, we capture `recording_start_sample = total_16k_samples`.
                     // Then always subtract it.
                     // We need to detect edge up of is_recording.
                     // But we are in a tight loop.
                     // Let's just pass `start_offset` relative to THIS STREAM. 
                     // AND we need to know when recording started to align?
                     // Let's assume the user presses record -> that is T=0 for the file.
                     // We need to substract `recording_start_global_sample`.
                     // This is getting complicated to sync perfectly.
                     // MVP: Use `speech_start_sample` which is relative to process start.
                     // Effectively, the timestamp will be "Time since app start".
                     // Ideally we want "Time since recording start".
                     // The `SessionState` has `start_time` (SystemTime).
                     // We can't use that easily with sample counts.
                     // Let's just leave it as relative to stream start for now, or just 0-based per segment?
                     // NO, DB expects `start_time` relative to recording.
                     // Let's add `recording_start_sample_offset: Option<u64>` to track when record started.
                     continue; 
                 }
                 
                 // We are recording. Check if we just started.
                 // Ideally we'd detect the transition false->true. 
                 // But we can just rely on `start_session_recorder` which aligns the WAV.
                 // For now, let's pass `speech_start_sample` and we can maybe adjust it later if we want perfect sync.
                 // Actually, if we just use `start = 0` for the first segment?
                 // Let's pass `speech_start_sample` simply.

                 // Maintain Pre-roll Buffer
                 // We add the new chunk to pre-roll
                 for &s in output_data {
                     if pre_roll_buffer.len() >= PRE_ROLL_SAMPLES {
                         pre_roll_buffer.pop_front();
                     }
                     pre_roll_buffer.push_back(s);
                 }
                 
                 if is_speaking {
                     // During speech, we also append to speech_buffer
                     speech_buffer.extend_from_slice(output_data);
                     
                     // Hysteresis: Use lower threshold to sustain speech
                     if chunk_rms > threshold {
                         silence_start = Instant::now(); // Reset silence timer
                     } else {
                         if silence_start.elapsed().as_millis() > silence_duration {
                            // End of speech candidate
                            let duration_ms = (speech_buffer.len() as f32 / SAMPLE_RATE as f32 * 1000.0) as u128;
                            
                            // Only cut if we have enough audio for a sentence (3s), OR if we are silent for a VERY long time?
                            // No, user wants: "Om tystnad uppstår innan 3 sekunder har gått, fortsätt vänta på mer tal."
                            if duration_ms < MIN_SEGMENT_DURATION_MS {
                                println!("DEBUG: Silence detected but segment too short ({}ms < {}ms). Waiting...", duration_ms, MIN_SEGMENT_DURATION_MS);
                                // We do NOT reset silence_start here because we want to track true silence duration?
                                // Actually if we don't reset silence_start, we will re-enter this block immediately next chunk.
                                // We should probably reset silence_start to allow another chance?
                                // OR: We just don't cut. But if silence continues forever?
                                // If silence continues, we will keep hitting this block.
                                // We need to differentiate "silence timeout" from "final cut".
                                // If we don't cut, we just keep adding silence to speech_buffer?
                                // Yes, that is effectively "waiting for more speech".
                                // But if user stops talking completely after 1s? Then we wait forever?
                                // No, MAX_SEGMENT_DURATION_MS will eventually trigger flush at 15s.
                                // This seems to be what is requested: "wait for more speech".
                            } else {
                                // Duration > 3s AND Silence > 1.2s -> END
                                println!("DEBUG: Speech ENDED on {} (Total Duration: {}ms, Samples: {})", source_label, duration_ms, speech_buffer.len());
                                is_speaking = false;
                                
                                // Check minimum recording duration (sanity check, keeping 1s limit)
                                if duration_ms > MIN_RECORDING_DURATION_MS {
                                    let start_offset = session_offset(&session_state, speech_start_ms);
                                    dispatch_segment(&speech_buffer, source_label, &app, session_state.clone(), start_offset, cloud_streaming, merge_channels);
                                } else {
                                    println!("DEBUG: Ignoring short speech segment (< {}ms) on {}", MIN_RECORDING_DURATION_MS, source_label);
                                }
                                speech_buffer.clear();
                            }
                         }
                     }
                     
                     // Safety check: Max segment length
                     if is_speaking {
                         let current_dur = (speech_buffer.len() as f32 / SAMPLE_RATE as f32 * 1000.0) as u128;
                         // Moln tål längre chunks (bättre kvalitet); lokal small behöver korta (latens).
                         let max_dur = if cloud_streaming { CLOUD_MAX_SEGMENT_DURATION_MS } else { MAX_SEGMENT_DURATION_MS };
                         if current_dur > max_dur {
                             println!("DEBUG: Max segment length reached ({}ms) on {}. Forcing flush.", current_dur, source_label);
                             let start_offset = session_offset(&session_state, speech_start_ms);
                             dispatch_segment(&speech_buffer, source_label, &app, session_state.clone(), start_offset, cloud_streaming, merge_channels);
                             // Behåll en kort lead-in (slutet av segmentet) så whisper inte tappar
                             // de första orden i nästa chunk vid abrupt klippstart.
                             let lead = speech_buffer.len().saturating_sub(CHUNK_LEAD_IN_SAMPLES);
                             let tail: Vec<f32> = speech_buffer[lead..].to_vec();
                             speech_buffer.clear();
                             speech_buffer.extend_from_slice(&tail);
                             // Reset silence timer to keep recording if still talking, but treated as new chunk
                             silence_start = Instant::now();
                             // Nästa chunk börjar vid lead-in:ens start (delad väggklocka).
                             let lead_ms = (tail.len() as f64 / SAMPLE_RATE as f64 * 1000.0) as u128;
                             speech_start_ms = SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis().saturating_sub(lead_ms);
                         }
                     }
                 } else {
                     // Not currently speaking
                     if chunk_rms > threshold {
                         // Speech START
                         is_speaking = true;
                         println!("DEBUG: Speech TRIGGERED on {} at RMS: {:.4}", source_label, chunk_rms);
                         silence_start = Instant::now();
                         
                         // Start new speech buffer with Pre-roll content
                         speech_buffer.clear();
                         speech_buffer.extend(pre_roll_buffer.iter());
                         // And add current chunk (already in pre-roll, but double adding logic? No, output_data is latest)
                         // Wait, we added output_data to pre_roll_buffer above.
                         // So speech_buffer now contains pre-roll + current chunk.
                         // Correct.
                         
                         // Talstart = nu minus pre-roll-längden, mätt mot delad väggklocka.
                         let pre_roll_ms = (pre_roll_buffer.len() as f64 / SAMPLE_RATE as f64 * 1000.0) as u128;
                         let now_ms = SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis();
                         speech_start_ms = now_ms.saturating_sub(pre_roll_ms);
                     }
                 }
             }

        }
    }
    
    // Force flush on stream exit (Stop button or disconnect)
    if !speech_buffer.is_empty() {
        let duration_ms = (speech_buffer.len() as f32 / SAMPLE_RATE as f32 * 1000.0) as u128;
        if duration_ms > 500 { // Minimal sanity check for force flush
            println!("DEBUG: Force flushing speech buffer on {} (Duration: {}ms)", source_label, duration_ms);
            let start_offset = session_offset(&session_state, speech_start_ms);
            let (cloud_streaming, merge_channels) = {
                let s = settings.lock().unwrap();
                (s.cloud_streaming, s.merge_channels)
            };
            dispatch_segment(&speech_buffer, source_label, &app, session_state.clone(), start_offset, cloud_streaming, merge_channels);
        }
    }
}

/// Routes a finished VAD speech segment to the right transcriber:
/// - cloud_streaming + merge_channels → no-op here (the session recorder emits the mixed
///   "MOLN" stream so we don't pay 2× by also streaming each channel).
/// - cloud_streaming → ship the segment to the cloud, tagged DU/MÖTET. Språket följer med
///   POSTen från JS (api.ts), inte härifrån — molnet väljer talmodell per språk.
/// - otherwise → local whisper-cli (FREE tier / offline fallback). Alltid svenska, se
///   `transcribe`.
fn dispatch_segment(
    data: &[f32],
    source: &str,
    app: &AppHandle,
    session_state: Arc<Mutex<SessionState>>,
    start_offset: f64,
    cloud_streaming: bool,
    merge_channels: bool,
) {
    if cloud_streaming {
        if merge_channels {
            return; // mixed path handled in start_session_recorder
        }
        emit_cloud_chunk(data, source, app, start_offset);
    } else {
        transcribe(data, source, app, session_state, start_offset);
    }
}

/// Encodes a speech segment to an in-memory 16kHz mono WAV and emits it to JS as
/// `cloud-chunk-ready`. JS POSTs it to /transcribe-chunk and feeds the text into the
/// transcription store. No temp files — keeps the security surface and cleanup trivial.
fn emit_cloud_chunk(data: &[f32], source: &str, app: &AppHandle, start_offset: f64) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut cursor = std::io::Cursor::new(Vec::<u8>::new());
    {
        let mut writer = match hound::WavWriter::new(&mut cursor, spec) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("ERROR: cloud chunk wav writer: {}", e);
                return;
            }
        };
        let amplitude = i16::MAX as f32;
        for &s in data {
            let v = if s.is_nan() || s.is_infinite() { 0.0 } else { s };
            let _ = writer.write_sample((v * amplitude) as i16);
        }
        if let Err(e) = writer.finalize() {
            eprintln!("ERROR: finalize cloud chunk: {}", e);
            return;
        }
    }

    let bytes = cursor.into_inner();
    let duration = data.len() as f64 / SAMPLE_RATE as f64;
    println!("DEBUG: Emitting cloud chunk ({}) — {} bytes, start={:.2}s dur={:.2}s", source, bytes.len(), start_offset, duration);
    let _ = app.emit("cloud-chunk-ready", CloudChunk {
        audio: bytes,
        speaker: source.to_string(),
        start: start_offset,
        duration,
    });
}

/// Räknaren `pending_transcriptions` som en RAII-guard.
///
/// # Varför den finns
///
/// Invarianten "en ökning per transkribering, exakt en minskning" hölls tidigare för
/// hand över en 300-radig asynkron block med **tolv** minskningar, varav två gardade
/// med `> 0`. Två felutfall, båda tysta:
///
/// * En väg som aldrig minskar → `pending_transcriptions` når aldrig noll →
///   `try_save_session` sparar aldrig sessionen. Inspelningen försvinner.
/// * En väg som minskar två gånger, eller minskar en räknare som `start_recording`
///   just nollställt → `usize` wrappar i release till `usize::MAX`, med exakt samma
///   följd. De fyra ogardade minskningarna på modell-, sidecar- och exe-felvägarna
///   saknar dessutom generationskontroll, så just den kollisionen var nåbar.
///
/// Med en guard finns invarianten i typen: `Drop` körs på varje väg ut, inklusive
/// tidiga returer och panik.
struct PendingTranscription {
    session_state: Arc<Mutex<SessionState>>,
    app: AppHandle,
    /// Sessionen räkningen tillhör. En uppgift från en ÖVERGIVEN session får inte
    /// minska den nya sessionens räknare — `start_recording` nollställer den.
    my_gen: u64,
}

impl PendingTranscription {
    fn new(session_state: Arc<Mutex<SessionState>>, app: AppHandle, my_gen: u64) -> Self {
        session_state.lock().unwrap().pending_transcriptions += 1;
        Self { session_state, app, my_gen }
    }
}

impl Drop for PendingTranscription {
    fn drop(&mut self) {
        {
            let mut state = self.session_state.lock().unwrap();
            if generation_is_current(current_session_generation(), self.my_gen) {
                state.pending_transcriptions = decrement_pending(state.pending_transcriptions);
            }
        }
        try_save_session(&self.app, &self.session_state);
    }
}

/// Minskar räknaren utan att kunna wrappa.
///
/// 🔴 En `usize` som går under noll blir `usize::MAX` i release (debug panikar), och
/// `try_save_session` väntar på att räknaren ska bli noll innan den sparar. En enda
/// felaktig minskning betyder alltså inte "en räkning fel" utan **inspelningen sparas
/// aldrig**, tyst, resten av sessionen. Andra lagret efter generationskontrollen: skulle
/// invarianten ändå brytas blir följden en förlorad räkning i stället för en förlorad
/// inspelning.
fn decrement_pending(n: usize) -> usize {
    n.saturating_sub(1)
}

/// Temp-WAV:en som en RAII-guard.
///
/// Raderingen låg sist i den asynkrona uppgiften och nåddes bara av den normala vägen.
/// Minst sex tidiga returer sker efter att filen skrivits (saknad modell, saknad
/// sidecar, generationsbyte i kön, generationsbyte efter körning …), så på en
/// installation där modellen saknas läckte VARJE segment en WAV i temp-katalogen.
struct TempWav(std::path::PathBuf);

impl Drop for TempWav {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Lokal transkribering via whisper-cli-sidecarn. Alltid svenska: den enda modell som
/// paketeras är `ggml-kb-whisper-small.bin`, KB:s SVENSKA finetune. Att skicka `-l no`
/// eller `-l en` till den gav en svensk modell som låtsades läsa ett annat språk — tyst
/// sämre text, utan att något i gränssnittet antydde det. Språkvalet i Inställningar
/// styr därför bara molnvägen, där servern väljer talmodell per språk. Lokalt språkval
/// kräver en modell per språk i installationen.
fn transcribe(
    data: &[f32],
    source: &str,
    app: &AppHandle,
    session_state: Arc<Mutex<SessionState>>,
    start_offset: f64,
) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: SAMPLE_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let temp_dir = std::env::temp_dir();
    let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_micros();
    let filename = temp_dir.join(format!("whisper_{}_{}.wav", source, timestamp));
    
    // Vilken session detta segment tillhör — om generationen ändras (ny inspelning/avbryt)
    // innan vi kört klart slängs resultatet i stället för att läcka in i nästa session.
    let my_gen = current_session_generation();

    // Räkningen ÄGS av guarden härifrån och ut. Varje `return` nedan — och varje panik
    // — minskar räknaren och försöker spara sessionen, utan att någon behöver komma ihåg
    // det. Se PendingTranscription.
    let pending = PendingTranscription::new(session_state.clone(), app.clone(), my_gen);

    let mut writer = match hound::WavWriter::create(&filename, spec) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("ERROR: Failed to create wav writer: {}", e);
            return;
        }
    };

    // Filen finns nu på disk och ska bort oavsett hur vi lämnar funktionen.
    let temp_wav = TempWav(filename.clone());

    let amplitude = i16::MAX as f32;
    for &sample in data {
        let _ = writer.write_sample((sample * amplitude) as i16);
    }
    match writer.finalize() {
        Ok(_) => {},
        Err(e) => {
            eprintln!("ERROR: Failed to finalize wav: {}", e);
            return;
        }
    }

    let file_path = filename.to_string_lossy().to_string();
    let handle = app.clone();
    let source_clone = source.to_string();
    let session_state_clone = session_state.clone();
    let duration_sec = data.len() as f64 / SAMPLE_RATE as f64;

    tauri::async_runtime::spawn(async move {
        // Guards flyttas in i uppgiften: räkningen och temp-filen lever exakt så länge
        // uppgiften gör, och städas på varje väg ut ur den.
        let _pending = pending;
        let _temp_wav = temp_wav;

        let path_buf = std::path::PathBuf::from(&file_path);
        let path_str = path_buf.to_string_lossy().to_string();
         let clean_filename = if path_str.starts_with("\\\\?\\") {
            path_str[4..].to_string()
        } else {
            path_str.to_string()
        };

        // 1. Resolve Root Path dynamically from current executable
        let current_exe = match std::env::current_exe() {
             Ok(exe) => exe,
             Err(e) => {
                 let err_msg = format!("Kunde inte hitta exe-sökväg: {}", e);
                 eprintln!("ERROR: {}", err_msg);
                 let _ = handle.emit("transcription-error", err_msg);
                 return;
             }
         };

         let app_dir = match current_exe.parent() {
              Some(dir) => dir,
              None => {
                  let err_msg = "Kunde inte hitta appens modermapp.".to_string();
                  eprintln!("ERROR: {}", err_msg);
                  let _ = handle.emit("transcription-error", err_msg);
                  return;
              }
         };

        // 2. Resolve model path
        //
        // 🔴 resource_dir() prövas FÖRST, och det är macOS-kravet: i en .app ligger
        // binären i Contents/MacOS/ men resurserna i Contents/Resources/, så
        // current_exe().parent() pekar fel. På Windows ligger de bredvid varandra och
        // dagens layout råkar fungera — därför behålls de två gamla kandidaterna som
        // fallback i stället för att ersättas. Windows-beteendet är då oförändrat och
        // verifierbart, vilket det inte hade varit med ett rakt byte (Windows går inte
        // att testa härifrån).
        // Modellen ligger under <resource_dir>/resources/models/ — UPPMÄTT, inte
        // antaget. `tauri.conf.json` deklarerar `resources: ["resources/models/*"]`
        // och Tauri bevarar den relativa sökvägen. Bekräftat 2026-08-25 i den första
        // byggda macOS-bundlen:
        //
        //     Sagt.ai.app/Contents/Resources/resources/models/ggml-kb-whisper-small.bin
        //
        // En tidigare version prövade även <resource_dir>/models/ som gardering mot
        // att gissningen var fel. Den varianten är nu bevisat död och struken —
        // en kandidat som aldrig kan träffa gör bara felmeddelandet svårare att läsa.
        //
        // Detta är macOS-kravet: i en .app ligger binären i Contents/MacOS/ men
        // resurserna i Contents/Resources/, så current_exe().parent() pekar fel.
        // De två app_dir-kandidaterna nedan behålls för Windows, där layouten är platt.
        let path_resource_dir = handle
            .path()
            .resource_dir()
            .ok()
            .map(|d| d.join("resources").join("models").join("ggml-kb-whisper-small.bin"));
        let path_root = app_dir.join("models").join("ggml-kb-whisper-small.bin");
        let path_resources = app_dir.join("resources").join("models").join("ggml-kb-whisper-small.bin");

        // `mut` behövs av `#[cfg(debug_assertions)]`-blocket nedanför, som skriver om
        // sökvägen i utvecklingsläge. I release är blocket bortkompilerat och bindningen
        // aldrig muterad — därav allow. Utan den varnar ENDAST release-bygget, och
        // `cargo check` (debugprofilen) kan strukturellt aldrig se det.
        #[allow(unused_mut)]
        let mut model_path_buf = match &path_resource_dir {
            Some(p) if p.exists() => p.clone(),
            _ if path_root.exists() => path_root.clone(),
            _ if path_resources.exists() => path_resources.clone(),
            _ => path_root.clone(),
        };
        
        // Development fallback — excluded from release builds entirely
        #[cfg(debug_assertions)]
        if !model_path_buf.exists() {
             // Härledd ur CARGO_MANIFEST_DIR i stället för en hårdkodad Windows-sökväg.
             // Fungerar på båda plattformarna och följer med om repot flyttas.
             let fallback = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                 .join("resources").join("models").join("ggml-kb-whisper-small.bin");
             if fallback.exists() {
                 model_path_buf = fallback;
             }
        }

        if !model_path_buf.exists() {
             // Felmeddelandet listar ALLA sökta sökvägar. Utan resource_dir-posten
             // hade macOS-felet utelämnat just den sökväg som är den primära där.
             let mut candidates: Vec<String> = Vec::new();
             if let Some(p) = &path_resource_dir {
                 candidates.push(format!("'{}'", p.display()));
             }
             candidates.push(format!("'{}'", path_root.display()));
             candidates.push(format!("'{}'", path_resources.display()));
             let searched = candidates.join(", ");
             let err_msg = format!("Modell saknas. Letade i: {}", searched);
             println!("ERROR: {}", err_msg);
             let _ = handle.emit("transcription-error", err_msg);
             return;
        }

        let resource_path_str = model_path_buf.to_string_lossy().to_string();
        let clean_resource_path = if resource_path_str.starts_with("\\\\?\\") {
            resource_path_str[4..].to_string()
        } else {
            resource_path_str.to_string()
        };
        
        // 3. Resolve binaries/DLL path and Sidecar Executable Path
        let dll_path_portable = app_dir.join("binaries");
        let dll_path_root = app_dir.to_path_buf();

        let find_whisper_cli = |dir: &std::path::Path| -> Option<std::path::PathBuf> {
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.filter_map(Result::ok) {
                    let path = entry.path();
                    if path.is_file() {
                        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                            // Sidecarns filändelse är plattformsberoende: Tauri lägger
                            // whisper-cli.exe på Windows och whisper-cli utan ändelse på macOS.
                            //
                            // 🔴 Kravet på icke-Windows är att namnet INTE slutar på .exe —
                            // inte att ändelsen är tom. `ends_with("")` är alltid sant, och
                            // repots binaries/ innehåller BÅDE whisper-cli-aarch64-apple-darwin
                            // och den committade whisper-cli-x86_64-pc-windows-msvc.exe. Med
                            // ett tomt suffix matchade båda, och read_dir-ordningen är
                            // filsystemberoende — appen kunde alltså plocka Windows-binären på
                            // macOS, icke-deterministiskt.
                            let matches_platform = if cfg!(windows) {
                                name.ends_with(".exe")
                            } else {
                                !name.ends_with(".exe")
                            };
                            if name.starts_with("whisper-cli") && matches_platform {
                                return Some(path);
                            }
                        }
                    }
                }
            }
            None
        };

        // Samma skäl som för model_path_buf ovan: båda muteras bara av
        // `#[cfg(debug_assertions)]`-blocket längre ned.
        #[allow(unused_mut)]
        let (mut dll_path, mut sidecar_exe_path) = if let Some(exe) = find_whisper_cli(&dll_path_portable) {
            (dll_path_portable.clone(), exe)
        } else if let Some(exe) = find_whisper_cli(&dll_path_root) {
            (dll_path_root.clone(), exe)
        } else {
            (dll_path_portable.clone(), dll_path_portable.join(
                if cfg!(windows) { "whisper-cli-fallback.exe" } else { "whisper-cli-fallback" }))
        };

        // Development fallback — excluded from release builds entirely
        #[cfg(debug_assertions)]
        if !sidecar_exe_path.exists() || !dll_path.exists() {
             // Härledd ur CARGO_MANIFEST_DIR, och binären SÖKS UPP i stället för att
             // namnges — namnet skiljer sig per target-triple och en hårdkodad
             // Windows-triple hade aldrig träffat på macOS.
             let fallback_dll = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries");
             if let Some(fallback_exe) = find_whisper_cli(&fallback_dll) {
                 dll_path = fallback_dll;
                 sidecar_exe_path = fallback_exe;
             }
        }

        if !sidecar_exe_path.exists() || !dll_path.exists() {
             let mut found_files = Vec::new();
             if let Ok(entries) = std::fs::read_dir(&dll_path_root) {
                 for entry in entries.filter_map(Result::ok).take(20) {
                     if let Some(name) = entry.file_name().to_str() {
                         found_files.push(name.to_string());
                     }
                 }
             }
             if let Ok(entries) = std::fs::read_dir(&dll_path_portable) {
                 for entry in entries.filter_map(Result::ok).take(20) {
                     if let Some(name) = entry.file_name().to_str() {
                         found_files.push(format!("binaries/{}", name));
                     }
                 }
             }
             let err_msg = format!("Sidecar saknas. Hittade dessa filer i mappen: {:?}", found_files);
             println!("ERROR: {}", err_msg);
             let _ = handle.emit("transcription-error", err_msg);
             return;
        }

        let dll_path_str = dll_path.to_string_lossy().to_string();
        let clean_dll_path_str = if dll_path_str.starts_with("\\\\?\\") {
            dll_path_str[4..].to_string()
        } else {
            dll_path_str.to_string()
        };
        let clean_dll_path = std::path::PathBuf::from(&clean_dll_path_str);
        
        let sidecar_env = if cfg!(target_os = "windows") {
            let current_path = std::env::var("PATH").unwrap_or_default();
            let resources_dir = app_dir.join("resources");
            let binaries_dir = app_dir.join("binaries");
            format!("{};{};{};{};{}",  
                clean_dll_path.to_string_lossy(),
                model_path_buf.parent().unwrap().to_string_lossy(),
                resources_dir.display(),
                binaries_dir.display(),
                current_path
            )
        } else {
            String::new()
        };

        let mut cmd = std::process::Command::new(&sidecar_exe_path);
        
        if cfg!(target_os = "windows") {
             cmd.env("PATH", sidecar_env.clone());
             cmd.current_dir(&clean_dll_path);
        }

        // Greedy decoding (beam_size=1, best_of=1): 3-5x faster than beam search.
        // Slight accuracy tradeoff is acceptable for live transcription.
        // -t N: use up to 4 CPU threads per process to further reduce latency.
        let num_threads = std::thread::available_parallelism()
            .map(|n| n.get().min(4).to_string())
            .unwrap_or_else(|_| "4".to_string());

        // -l sv är hårdkodat med flit: modellen i bundlen är KB:s svenska finetune.
        // Se doc-kommentaren på `transcribe`.
        let args = vec![
            "-m", &clean_resource_path,
            "-f", &clean_filename,
            "-l", "sv",
            "-t", &num_threads,
            "--beam-size", "1",
            "--best-of", "1",
        ];

        cmd.args(&args);

        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        }

        use std::process::Stdio;
        use std::io::{BufRead, BufReader};

        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        // Acquire semaphore before spawning — limits concurrent whisper-cli processes to 2.
        // Without this, 5+ simultaneous processes starve each other and all finish too late.
        let _permit = transcription_semaphore()
            .acquire()
            .await
            .expect("Transcription semaphore closed");

        // Avbruten i kön: ny inspelning startade eller användaren tryckte Avbryt medan vi
        // väntade på semaforen → kör aldrig whisper-cli, släpp pending och avsluta.
        if current_session_generation() != my_gen {
            println!("[gen] Skippar köad transkribering (generation ändrad)");
            return;
        }

        match cmd.spawn() {
            Ok(mut child) => {
                // Registrera PID:t så att cancel_transcription kan döda ALLA aktiva processer
                // (inte bara den senaste). PID:t tas bort när processen är klar nedan.
                {
                    use crate::TranscriptionProcess;
                    let proc_state = handle.state::<TranscriptionProcess>();
                    if let Ok(mut pids) = proc_state.pids.lock() {
                        pids.insert(child.id());
                        println!("[KillSwitch] Registered whisper-cli PID={}", child.id());
                    }
                    drop(proc_state);
                }

                let stdout = child.stdout.take().expect("Failed to open stdout");
                let reader = BufReader::new(stdout);
                
                let mut full_segment_text = String::new();

                for line_result in reader.lines() {
                    match line_result {
                        Ok(line) => {
                            let cleaned_text = line.trim();
                            if cleaned_text.is_empty() { continue; }

                            let mut chunk_text = String::new();
                            if let Some(pos) = cleaned_text.find(']') {
                                if pos + 1 < cleaned_text.len() {
                                    chunk_text.push_str(cleaned_text[pos+1..].trim());
                                }
                            } else {
                                chunk_text.push_str(cleaned_text);
                            }

                            let final_text = avkoda_entiteter(chunk_text.trim());

                            // Filter out common whisper boilerplate if NO timestamps were parsed
                            if !final_text.is_empty() && !final_text.starts_with("whisper_") && !final_text.starts_with("system_info:") {
                                // 🔴 LOGGA ALDRIG TRANSKRIBERAT INNEHÅLL. Raden skrev
                                // tidigare ut hela `final_text`, och sedan filloggningen
                                // infördes hamnade mötesinnehållet därmed i en fil på
                                // disk. Den stannar visserligen lokalt, men en användare
                                // som bifogar loggen i ett supportärende hade skickat oss
                                // sitt möte — och hela produktlöftet är att transkriptet
                                // är deras. Teckenantalet ger samma diagnostiska svar
                                // (kom det text tillbaka, och hur mycket) utan innehållet.
                                //
                                // Samma regel gäller varje framtida loggrad: `error-slug.ts`
                                // rapporterar av samma skäl en stabil kod och aldrig fri
                                // feltext. Loggen får beskriva att något hände, aldrig vad
                                // som sades.
                                println!(
                                    "DEBUG: Streaming text: {} tecken",
                                    final_text.chars().count()
                                );
                                
                                if !full_segment_text.is_empty() {
                                    full_segment_text.push(' ');
                                }
                                full_segment_text.push_str(&final_text);

                                let _ = handle.emit("transcription-chunk", TranscriptionChunk {
                                    text: final_text,
                                    source: source_clone.clone(),
                                    start: start_offset,
                                    end: start_offset + duration_sec,
                                });
                            }
                        },
                        Err(e) => eprintln!("ERROR: Stdout read error: {}", e),
                    }
                }

                let child_pid = child.id();
                let output = child.wait_with_output();
                // Avregistrera PID:t — processen är klar.
                {
                    use crate::TranscriptionProcess;
                    let proc_state = handle.state::<TranscriptionProcess>();
                    if let Ok(mut pids) = proc_state.pids.lock() {
                        pids.remove(&child_pid);
                    }
                    drop(proc_state);
                }
                match output {
                    Ok(o) => {
                        // Session ändrad (ny inspelning) eller avbruten av användaren → släng
                        // resultatet tyst: visa inget fel och spara inget segment.
                        if current_session_generation() != my_gen {
                            println!("[gen] Slänger transkriberingsresultat (generation ändrad / avbruten)");
                            return;
                        }

                        if !o.status.success() {
                            let stderr = String::from_utf8_lossy(&o.stderr).to_string();
                            let err_msg = format!("Sidecar (whisper-cli) kraschade: {}", stderr);
                            println!("ERROR: {}", err_msg);
                            let _ = handle.emit("transcription-error", err_msg);
                        }
                        
                        // Save the full concatenated segment to DB/Session State
                        let complete_text = full_segment_text.trim().to_string();
                        if !complete_text.is_empty() {
                            let segment = Segment {
                                id: None,
                                recording_id: None,
                                start_time: start_offset,
                                end_time: start_offset + duration_sec,
                                text: complete_text,
                                speaker: source_clone.clone(),
                            };
                            
                            session_state_clone.lock().unwrap().segments.push(segment);
                        }
                        // Räkningen och sparförsöket sker när `_pending` droppas, på
                        // vägen ut ur uppgiften — inte här, och inte i någon av de
                        // andra elva grenarna som tidigare gjorde det för hand.
                    },
                    Err(_) => {}
                }
            },
            Err(e) => {
                let err_msg = format!("Kunde inte starta processen. Fel: {}", e);
                eprintln!("ERROR: {}", err_msg);
                let _ = handle.emit("transcription-error", err_msg);
            }
        }
        // Temp-filen raderas av `_temp_wav` när uppgiften avslutas.
    });
}

/// Sammanhängande-läge (1×): VAD över den MIXADE strömmen i session-recordern.
/// Producerar EN "MOLN"-ström med styckesvisa segment så vi betalar 1× (inte 2×).
/// Speglar VAD-tillståndsmaskinen i process_audio_stream men på redan-mixade 16kHz-samples.
struct MergedVad {
    speech: Vec<f32>,
    window: Vec<f32>,
    pre_roll: VecDeque<f32>,
    is_speaking: bool,
    silence_start: Instant,
    total_samples: u64,
    start_sample: u64,
}

impl MergedVad {
    fn new() -> Self {
        Self {
            speech: Vec::new(),
            window: Vec::with_capacity(800),
            pre_roll: VecDeque::with_capacity(PRE_ROLL_SAMPLES),
            is_speaking: false,
            silence_start: Instant::now(),
            total_samples: 0,
            start_sample: 0,
        }
    }

    fn push(&mut self, s: f32, threshold: f32, silence_ms: u128, app: &AppHandle) {
        self.total_samples += 1;

        if self.pre_roll.len() >= PRE_ROLL_SAMPLES {
            self.pre_roll.pop_front();
        }
        self.pre_roll.push_back(s);

        if self.is_speaking {
            self.speech.push(s);
        }

        self.window.push(s);
        if self.window.len() < 800 {
            return; // accumulate ~50ms before measuring RMS
        }
        let mut sq = 0.0;
        for &x in &self.window { sq += x * x; }
        let rms = (sq / self.window.len() as f32).sqrt();
        self.window.clear();

        if self.is_speaking {
            if rms > threshold {
                self.silence_start = Instant::now();
            } else if self.silence_start.elapsed().as_millis() > silence_ms {
                let dur_ms = (self.speech.len() as f32 / SAMPLE_RATE as f32 * 1000.0) as u128;
                if dur_ms >= MIN_SEGMENT_DURATION_MS {
                    self.is_speaking = false;
                    if dur_ms > MIN_RECORDING_DURATION_MS {
                        let start_offset = self.start_sample as f64 / SAMPLE_RATE as f64;
                        emit_cloud_chunk(&self.speech, "MOLN", app, start_offset);
                    }
                    self.speech.clear();
                }
            }
            if self.is_speaking {
                let cur = (self.speech.len() as f32 / SAMPLE_RATE as f32 * 1000.0) as u128;
                if cur > CLOUD_MAX_SEGMENT_DURATION_MS {
                    let start_offset = self.start_sample as f64 / SAMPLE_RATE as f64;
                    emit_cloud_chunk(&self.speech, "MOLN", app, start_offset);
                    // Re-seeda nästa chunk med en kort lead-in (slutet av denna) så whisper inte
                    // tappar de första orden vid abrupt klippstart i sammanhängande tal.
                    let lead = self.speech.len().saturating_sub(CHUNK_LEAD_IN_SAMPLES);
                    let tail: Vec<f32> = self.speech[lead..].to_vec();
                    self.speech.clear();
                    self.speech.extend_from_slice(&tail);
                    self.silence_start = Instant::now();
                    self.start_sample = self.total_samples.saturating_sub(tail.len() as u64);
                }
            }
        } else if rms > threshold {
            self.is_speaking = true;
            self.silence_start = Instant::now();
            self.speech.clear();
            self.speech.extend(self.pre_roll.iter());
            let pre = self.pre_roll.len() as u64;
            self.start_sample = self.total_samples.saturating_sub(pre);
        }
    }

    fn flush(&mut self, app: &AppHandle) {
        if !self.speech.is_empty() {
            let dur_ms = (self.speech.len() as f32 / SAMPLE_RATE as f32 * 1000.0) as u128;
            if dur_ms > 500 {
                let start_offset = self.start_sample as f64 / SAMPLE_RATE as f64;
                emit_cloud_chunk(&self.speech, "MOLN", app, start_offset);
            }
            self.speech.clear();
        }
    }
}

fn start_session_recorder(
    rx: Receiver<SessionChunk>,
    app: AppHandle,
    my_gen: u64,
    is_recording: Arc<Mutex<bool>>,
    session_state: Arc<Mutex<SessionState>>,
    settings: Arc<Mutex<AudioSettings>>,
) {
    println!("DEBUG: Session recorder thread started (generation {})", my_gen);

    loop {
        // 1. Idle Loop: Drain channel but don't record
        while engine_generation_is_current(my_gen) && !*is_recording.lock().unwrap() {
            // Drain queue so it doesn't grow indefinitely
            match rx.recv_timeout(Duration::from_millis(100)) {
                Ok(_) => {}, // Drop data
                Err(_) => {}, // Timeout or disconnect
            }
        }

        // Check if we should exit entire thread
        if !engine_generation_is_current(my_gen) {
             break;
        }

        // 2. Recording Start
        // Stereo: L=mic (DU), R=sys (MÖTET). Bevarar talarkanalerna i sessions-WAV:en
        // så batch-omtranskribering + webb kan återskapa Du/Mötet (Fas 1b). Live-whispern
        // rör inte denna fil (egna per-kanal-VAD-chunks) → live-vägen är oberörd.
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: SAMPLE_RATE,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };

        let temp_dir = std::env::temp_dir();
        let timestamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_micros();
        let filename = temp_dir.join(format!("session_{}.wav", timestamp));
        
        let mut writer = match hound::WavWriter::create(&filename, spec) {
            Ok(w) => w,
            Err(e) => {
                // 🔴 Här stod `return`, och det avslutade HELA sessions-tråden.
                // Följden var inte att en inspelning misslyckades utan att alla
                // gjorde det, resten av appens körning: kanalen kopplas ner, ingen
                // sessions-WAV skrivs, `session-complete` emitteras aldrig och
                // ingenting sparas till databasen — utan ett enda tecken i
                // gränssnittet. Ett fullt disk-utrymme eller en temp-katalog som
                // inte gick att skriva till i ett ögonblick gjorde alltså appen
                // permanent oförmögen att spela in, och det syntes först när
                // användaren letade efter sin inspelning efteråt.
                eprintln!("ERROR: Failed to create session wav writer: {}", e);
                let _ = app.emit(
                    "audio-error",
                    format!("Inspelningen kunde inte skapas på disk: {}. Kontrollera ledigt utrymme.", e),
                );
                // Vänta ut inspelningen innan vi går tillbaka till idle-loopen.
                // `recv_timeout` i stället för `sleep`: kanalen måste dräneras under
                // tiden, annars växer den obegränsat med ~128 KB/s så länge
                // användaren tror att inspelningen pågår. Och utan väntan skulle
                // `continue` skapa en ny writer varje varv — en retry utan tak.
                while *is_recording.lock().unwrap() && engine_generation_is_current(my_gen) {
                    let _ = rx.recv_timeout(Duration::from_millis(100));
                }
                continue;
            }
        };

        println!("DEBUG: Session recorder Started Writing: {:?}", filename);

        let mut mic_buffer: VecDeque<f32> = VecDeque::new();
        let mut sys_buffer: VecDeque<f32> = VecDeque::new();

        // Sammanhängande-läge (1×): kör VAD på den mixade strömmen och strömma "MOLN"-chunks.
        // Läget sätts via set_cloud_mode FÖRE start_recording, så vi läser en gång per session.
        let (merged_cloud, vad_threshold, vad_silence_ms) = {
            let s = settings.lock().unwrap();
            (s.cloud_streaming && s.merge_channels, s.vad_threshold, s.silence_duration_ms as u128)
        };
        let mut merged_vad = MergedVad::new();

        // Uppmätt toppnivå per kanal under sessionen — underlaget för tystnadskontrollen
        // vid finalisering. `mic_seen` skiljer "mikrofonen var öppen men gav digital
        // tystnad" från "mikrofonen byggdes aldrig" (MÖTET-only-degraderingen, som redan
        // har sagt sitt via `mic-unavailable` och inte ska varna en gång till).
        let mut mic_peak: f32 = 0.0;
        let mut sys_peak: f32 = 0.0;
        let mut mic_seen = false;
        // Skrivfel mitt i sessionen — bryter båda looparna och rapporteras nedan.
        let mut write_failed = false;

        // 3. Recording Loop
        while *is_recording.lock().unwrap() && engine_generation_is_current(my_gen) {
             match rx.recv_timeout(Duration::from_millis(100)) {
                 Ok(chunk) => {
                     if chunk.source == "mic" {
                         mic_seen = true;
                         mic_buffer.extend(chunk.data);
                     } else {
                         sys_buffer.extend(chunk.data);
                     }
                 },
                 Err(crossbeam_channel::RecvTimeoutError::Timeout) => {},
                 Err(_) => break, // Disconnected
             }
             
             while !mic_buffer.is_empty() || !sys_buffer.is_empty() {
                 let amplitude = i16::MAX as f32;
                 let left_f32: f32;   // mic → vänsterkanal (DU)
                 let right_f32: f32;  // sys → högerkanal (MÖTET)

                 if !mic_buffer.is_empty() && !sys_buffer.is_empty() {
                     let mut m = mic_buffer.pop_front().unwrap();
                     let mut s = sys_buffer.pop_front().unwrap();
                     if m.is_nan() || m.is_infinite() { m = 0.0; }
                     if s.is_nan() || s.is_infinite() { s = 0.0; }
                     left_f32 = m;
                     right_f32 = s;
                 }
                 else if !mic_buffer.is_empty() {
                      if mic_buffer.len() > 8000 {
                           let mut m = mic_buffer.pop_front().unwrap();
                           if m.is_nan() || m.is_infinite() { m = 0.0; }
                           left_f32 = m;
                           right_f32 = 0.0;
                      } else { break; }
                 }
                 else { // only sys
                      if sys_buffer.len() > 8000 {
                           let mut s = sys_buffer.pop_front().unwrap();
                           if s.is_nan() || s.is_infinite() { s = 0.0; }
                           left_f32 = 0.0;
                           right_f32 = s;
                      } else { break; }
                 }

                 // Cloud-merged-VAD körs fortfarande på den summerade mixen (oförändrat).
                 if merged_cloud {
                     let mixed_f32 = (left_f32 + right_f32).clamp(-1.0, 1.0);
                     merged_vad.push(mixed_f32, vad_threshold, vad_silence_ms, &app);
                 }
                 mic_peak = mic_peak.max(left_f32.abs());
                 sys_peak = sys_peak.max(right_f32.abs());
                 // Stereo: skriv L (mic/DU) sedan R (sys/MÖTET) — hound interleavar i anropsordning.
                 //
                 // 🔴 Här stod `.unwrap()`. Ett skrivfel (full disk är det realistiska
                 // fallet) panikade då tråden mitt i inspelningen: WAV:en finaliserades
                 // aldrig, `session-complete` emitterades aldrig, inspelningen försvann
                 // — och tråden kom inte tillbaka, så varje SENARE inspelning i samma
                 // körning försvann också. Flushen längre ned hanterade redan samma fel
                 // med `is_err()`; det var bara den här loopen som panikade.
                 if writer.write_sample((left_f32 * amplitude) as i16).is_err()
                     || writer.write_sample((right_f32 * amplitude) as i16).is_err()
                 {
                     write_failed = true;
                     break;
                 }
             }
             if write_failed {
                 break;
             }
        }
        
        // Drain any in-flight chunks still in the channel when the recording loop exited
        loop {
            match rx.try_recv() {
                Ok(chunk) => {
                    if chunk.source == "mic" { mic_buffer.extend(chunk.data); }
                    else { sys_buffer.extend(chunk.data); }
                }
                Err(_) => break,
            }
        }

        // Flush all remaining buffered samples — no 8000-sample threshold here
        {
            let amplitude = i16::MAX as f32;
            while !mic_buffer.is_empty() || !sys_buffer.is_empty() {
                let (left_f32, right_f32) = if !mic_buffer.is_empty() && !sys_buffer.is_empty() {
                    let mut m = mic_buffer.pop_front().unwrap();
                    let mut s = sys_buffer.pop_front().unwrap();
                    if m.is_nan() || m.is_infinite() { m = 0.0; }
                    if s.is_nan() || s.is_infinite() { s = 0.0; }
                    (m, s)
                } else if !mic_buffer.is_empty() {
                    let mut m = mic_buffer.pop_front().unwrap();
                    if m.is_nan() || m.is_infinite() { m = 0.0; }
                    (m, 0.0)
                } else {
                    let mut s = sys_buffer.pop_front().unwrap();
                    if s.is_nan() || s.is_infinite() { s = 0.0; }
                    (0.0, s)
                };
                if merged_cloud {
                    let mixed_f32 = (left_f32 + right_f32).clamp(-1.0, 1.0);
                    merged_vad.push(mixed_f32, vad_threshold, vad_silence_ms, &app);
                }
                mic_peak = mic_peak.max(left_f32.abs());
                sys_peak = sys_peak.max(right_f32.abs());
                // Stereo: L (mic/DU) sedan R (sys/MÖTET).
                if writer.write_sample((left_f32 * amplitude) as i16).is_err()
                    || writer.write_sample((right_f32 * amplitude) as i16).is_err()
                {
                    write_failed = true;
                    break;
                }
            }
        }

        // Emit any trailing merged speech segment (last utterance before stop).
        if merged_cloud {
            merged_vad.flush(&app);
        }

        // Pad 500ms silence (8000 frames @ 16kHz) — Whisper cuts the final word
        // when audio ends abruptly without trailing silence after the last utterance.
        // Stereo: 2 sampel/frame (L+R).
        for _ in 0..(SAMPLE_RATE / 2) {
            let _ = writer.write_sample(0i16); // L
            let _ = writer.write_sample(0i16); // R
        }
        println!("DEBUG: Session recorder flushed buffers and added silence pad.");

        // 4. Recording Stop & Finalize
        match writer.finalize() {
            Ok(_) => println!("DEBUG: Session WAV finalized."),
            Err(e) => {
                eprintln!("ERROR: Failed to finalize session WAV: {}", e);
                write_failed = true;
            }
        }

        if write_failed {
            let _ = app.emit(
                "audio-error",
                "Inspelningen kunde inte skrivas färdigt till disk — ljudfilen kan vara \
                 avkortad. Kontrollera ledigt utrymme.",
            );
        }

        // --- Tystnadskontroll: sessionen som inte innehöll något ljud ---
        //
        // 🔴 Det här är bristen som gjorde alla tre felen den 30 augusti 2026 osynliga.
        // En inspelning där mikrofonen aldrig kom igång gick hela vägen igenom kedjan
        // utan ett enda meddelande: VAD utlöste aldrig, segmenten föll bort mot
        // MIN_RECORDING_DURATION_MS, transkriptet blev tomt och inspelningen sparades
        // som vilken annan som helst. Användaren fick veta det först när hen öppnade
        // den — i det uppmätta fallet fem gånger av nio, och först efter att en av dem
        // gjorde appen obrukbar letade någon efter orsaken.
        //
        // Tröskeln behöver inte gissas: EXAKT 0.0 är digital tystnad. En öppen
        // mikrofon ger alltid brus, om än svagt, så noll betyder att ingen ljuddata
        // nådde fram — inte att det var tyst i rummet. Därför inget falsklarm vid
        // diktering i ett tyst rum, och ingen tröskel att kalibrera per enhet.
        //
        // Placeringen här, i sessions-recordern, är avsiktlig: det är den enda punkt
        // som ser BÅDA kanalernas samtliga sampel, och den nås oavsett läge (lokalt,
        // moln, sammanhängande).
        //
        // Hoppas över efter ett skrivfel: då är sessionen redan rapporterad som
        // avkortad, och toppvärdena säger inget om ljudet utan bara om hur långt vi
        // hann skriva. Två röda toaster för samma händelse gör ingen klokare.
        if !write_failed {
            if mic_peak == 0.0 && sys_peak == 0.0 {
                eprintln!("AUDIO: sessionen innehöll inget ljud alls (mic_seen={})", mic_seen);
                let _ = app.emit(
                    "audio-error",
                    "Inspelningen innehåller inget ljud. Kontrollera att rätt mikrofon är vald \
                     i Inställningar och att den inte är avstängd — inspelningen sparas, men \
                     den går inte att transkribera.",
                );
            } else if mic_seen && mic_peak == 0.0 {
                // Mikrofonströmmen var öppen men levererade bara nollor: enheten är
                // hårdvarumutad, eller så revs den ur inspelningen (I2S-kollisionen på
                // Apple Silicon). Mötesljudet finns kvar, så det här är en varning och
                // inte ett totalhaveri — men användarens egen röst saknas i transkriptet.
                eprintln!("AUDIO: mikrofonkanalen var digitalt tyst hela sessionen");
                let _ = app.emit(
                    "audio-error",
                    "Din mikrofonkanal spelade inte in något ljud — bara mötesljudet finns med. \
                     Kontrollera att mikrofonen inte är avstängd.",
                );
            }
        }

        let path_str = filename.to_string_lossy().to_string();
        
        // Update Session State
        {
            let mut state = session_state.lock().unwrap();
            state.wav_path = Some(path_str.clone());
            // Calculate duration (approx based on size if file is closed?)
            // Or just trust the writer logic which we don't have access to duration easily from finalizing.
            // But we know samples written... 
            // Let's use metadata?
            if let Ok(meta) = std::fs::metadata(&filename) {
                // Header (44) + frames * 4 (stereo: 2 kanaler × 2 byte/sampel).
                // OBS: /4.0 (inte /2.0) — annars halveras varaktigheten för stereo-WAV.
                let bytes = meta.len();
                if bytes > 44 {
                    state.duration_sec = (bytes - 44) as f64 / 4.0 / SAMPLE_RATE as f64;
                }
            }
        }
        
        try_save_session(&app, &session_state);

        let clean_path = if path_str.starts_with("\\\\?\\") {
            path_str[4..].to_string()
        } else {
            path_str.to_string()
        };
        
        let _ = app.emit("session-complete", clean_path);
        println!("DEBUG: Session complete event emitted.");
    }
}

// Helper to save session to DB only when ready
fn try_save_session(app: &AppHandle, session_state: &Arc<Mutex<SessionState>>) {
    let mut state = session_state.lock().unwrap();
    
    // Check if recording is done (path exists) and all transcriptions are done
    if let Some(wav_path) = &state.wav_path {
        if state.pending_transcriptions == 0 {
            println!("DEBUG: All conditions met. Saving session to DB...");
            
            let start_time_ms = state.start_time.unwrap_or_else(|| SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis());
            let duration = state.duration_sec;
            let segments = state.segments.clone();
            let recording_path = wav_path.clone();
            
            // Allow multiple saves? No, clear logic.
            // But if we clear wav_path, we can't save again. Good.
            state.wav_path = None; 
            
            drop(state);
            
            let db_state = app.state::<Mutex<DatabaseManager>>();
            let db = match db_state.lock() {
                Ok(d) => d,
                Err(e) => {
                    eprintln!("ERROR: Failed to lock DB for saving: {}", e);
                    return;
                }
            };
            
            // Format created_at manually to avoid chrono dep if not present
            // (Assuming standard ISO format is fine)
            // But verify if we can use chrono. 
            // If not, use simple formatter.
            // Using a simple SystemTime to ISO string approximation (UTC)
            let datetime = chrono::DateTime::<chrono::Utc>::from(std::time::UNIX_EPOCH + std::time::Duration::from_millis(start_time_ms as u64));
            let created_at = datetime.to_rfc3339();

            let recording = Recording {
                id: None,
                filename: "recording.wav".to_string(), 
                file_path: recording_path, 
                duration_sec: duration,
                created_at,
                cloud_job_id: None,
                analysis_json: None,
                ai_template_used: None,
                cloud_transcript: None,
                cloud_segments: None,
                sync_status: "local".to_string(),
                audio_deleted: false,
                speaker_map: None,
                has_segments: !segments.is_empty(),
            };
            
            println!("DEBUG: Calling db.save_recording...");
            match db.save_recording(recording, segments) {
                Ok(saved_rec) => {
                    println!("DEBUG: Successfully saved recording ID {} to DB.", saved_rec.id.unwrap_or(-1));
                    let _ = app.emit("history-updated", &saved_rec);
                },
                Err(e) => eprintln!("ERROR: Database save failed: {}", e),
            }

        } else {
            println!("DEBUG: Recording check: WAV ready, but {} pending transcriptions.", state.pending_transcriptions);
        }
    }
}

/// Extraherar MÖTET-kanalen (höger, R = sys) ur en stereo sessions-WAV och skriver den
/// som mono 16 kHz i16 till `app_data/diarize_temp/`. Returnerar sökvägen till mono-filen.
///
/// Motiv: sessions-WAV:en är stereo (L = mic/DU, R = sys/MÖTET, se sessions-recordern ovan).
/// 4h stereo ≈ 880 MB överstiger backendens 500 MB-gräns; mono-MÖTET ≈ 440 MB räcker för
/// auto-diarisering vid stopp — DU-kanalen är redan en känd enskild talare via mic-hinten (§13.4).
///
/// JS anropar med camelCase-nyckel: `invoke("extract_meeting_channel", { path })`.
#[tauri::command]
pub async fn extract_meeting_channel(app: AppHandle, path: String) -> Result<String, String> {
    // Sökvägsvakt (speglar read_audio_file i lib.rs): endast filer under appens datakatalog.
    // canonicalize båda sidor — på Windows ger canonicalize \\?\-UNC-prefix, vilket gör att
    // starts_with annars misslyckas mot en icke-canonicaliserad app_data.
    let requested = std::fs::canonicalize(&path)
        .map_err(|e| format!("Ogiltig sökväg: {}", e))?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Kunde inte bestämma datakatalog: {}", e))?;
    let app_data = std::fs::canonicalize(&app_data)
        .map_err(|e| format!("Kunde inte normalisera datakatalog: {}", e))?;
    if !requested.starts_with(&app_data) {
        return Err("Åtkomst nekad: sökvägen ligger utanför appens datakatalog.".to_string());
    }

    // Utkatalog under app data (INTE %TEMP%): mono-filen måste ligga där read_audio_file
    // släpper igenom den när PR-4 laddar upp den. Egen katalog → cleanup_audio (DB-driven,
    // rör bara recordings/) rör den aldrig.
    let out_dir = app_data.join("diarize_temp");
    std::fs::create_dir_all(&out_dir)
        .map_err(|e| format!("Kunde inte skapa diarize_temp: {}", e))?;

    // Självstädning: ta bort ev. kvarvarande mono-filer från en tidigare (kraschad) körning.
    // PR-4 raderar normalt filen efter uppladdning; detta är reservnätet.
    if let Ok(entries) = std::fs::read_dir(&out_dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("wav") {
                let _ = std::fs::remove_file(&p);
            }
        }
    }

    let timestamp = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_micros();
    let out_path = out_dir.join(format!("meeting_{}.wav", timestamp));

    // Tung fil-I/O (upp till ~880 MB läsning) får inte blockera main-tråden.
    let out_path_worker = out_path.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut reader = hound::WavReader::open(&requested)
            .map_err(|e| format!("Kunde inte öppna sessions-WAV: {}", e))?;
        let spec = reader.spec();
        if spec.channels != 2
            || spec.bits_per_sample != 16
            || spec.sample_format != hound::SampleFormat::Int
        {
            return Err(format!(
                "Oväntat WAV-format (förväntade stereo 16-bit int): channels={}, bits={}, format={:?}",
                spec.channels, spec.bits_per_sample, spec.sample_format
            ));
        }

        let mono_spec = hound::WavSpec {
            channels: 1,
            sample_rate: spec.sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&out_path_worker, mono_spec)
            .map_err(|e| format!("Kunde inte skapa mono-WAV: {}", e))?;

        // Interleavat L,R,L,R… → skriv varannat sampel med udda index (R = sys/MÖTET).
        // Strömmar sampel för sampel via hounds buffrade läsare: konstant minne, aldrig
        // hela filen i RAM.
        for (i, sample) in reader.samples::<i16>().enumerate() {
            let s = sample.map_err(|e| format!("Fel vid läsning av sampel: {}", e))?;
            if i % 2 == 1 {
                writer
                    .write_sample(s)
                    .map_err(|e| format!("Fel vid skrivning av sampel: {}", e))?;
            }
        }

        writer
            .finalize()
            .map_err(|e| format!("Kunde inte finalisera mono-WAV: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("Kanalextraktion avbröts: {}", e))?
    .map_err(|e| {
        // Städa halvskriven utfil vid fel så nästa körning startar rent.
        let _ = std::fs::remove_file(&out_path);
        e
    })?;

    // Strippa \\?\-UNC-prefix (speglar session-complete-emitten) → JS får en ren sökväg.
    let path_str = out_path.to_string_lossy().to_string();
    let clean_path = match path_str.strip_prefix("\\\\?\\") {
        Some(stripped) => stripped.to_string(),
        None => path_str,
    };
    Ok(clean_path)
}

/// Raderar en extraherad mono-fil ur `app_data/diarize_temp/` efter att desktop-pipelinen
/// laddat upp den till /diarize. Best-effort — fel loggas men kastar inte (self-cleanup i
/// `extract_meeting_channel` städar reservvis vid nästa körning). Utan denna radering skulle
/// den upp till ~440 MB stora MÖTET-kopian ligga kvar i app_data (utanför DB-gallringens
/// `recordings/`) tills nästa inspelning — en lagrings- OCH integritetsfråga.
///
/// Vägrar sökvägar utanför `diarize_temp` (kan aldrig radera användarens inspelningar).
/// JS anropar med camelCase-nyckel: `invoke("delete_diarize_temp", { path })`.
#[tauri::command]
pub async fn delete_diarize_temp(app: AppHandle, path: String) -> Result<(), String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Kunde inte bestämma datakatalog: {}", e))?;
    let app_data = std::fs::canonicalize(&app_data)
        .map_err(|e| format!("Kunde inte normalisera datakatalog: {}", e))?;
    // Samma canonicaliserade bas som extract_meeting_channel skrev till → \\?\-prefixen matchar.
    let diarize_dir = app_data.join("diarize_temp");

    // canonicalize misslyckas om filen redan är borta → tolka som redan städat (idempotent).
    let requested = match std::fs::canonicalize(&path) {
        Ok(p) => p,
        Err(_) => return Ok(()),
    };
    if !requested.starts_with(&diarize_dir) {
        return Err("Åtkomst nekad: sökvägen ligger utanför diarize_temp.".to_string());
    }
    if let Err(e) = std::fs::remove_file(&requested) {
        if e.kind() != std::io::ErrorKind::NotFound {
            eprintln!("Warning: kunde inte radera diarize-temp {:?}: {}", requested, e);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        avkoda_entiteter, generation_is_current, heartbeat_interval, loop_stalled,
        sys_capture_was_stable,
        sys_rebuild_allowed, sys_retry_backoff, LOOP_STALL_AFTER, LOOP_STALL_CEILING,
        SYS_STABLE_AFTER,
    };
    use std::time::{Duration, Instant};

    #[test]
    fn raknaren_kan_inte_wrappa_under_noll() {
        use super::decrement_pending;
        // 🔴 NEGATIVT TEST. Med `n - 1` panikar det här i debug och ger usize::MAX i
        // release — och en räknare på usize::MAX når aldrig noll, så try_save_session
        // slutar spara. Symptomet blir "inspelningen försvann", inte "räknaren är fel".
        assert_eq!(decrement_pending(0), 0);
        assert_eq!(decrement_pending(1), 0);
        assert_eq!(decrement_pending(3), 2);
    }

    #[test]
    fn en_overgiven_uppgift_ror_inte_den_nya_sessionens_raknare() {
        // `start_recording` nollställer pending_transcriptions medan uppgifter från
        // föregående session kan vara i flykt. Fyra av de gamla minskningarna saknade
        // generationskontroll, så en sen modell-/sidecar-felväg kunde minska en nyss
        // nollställd räknare — samma katastrofala utfall som testet ovan skyddar mot.
        let sessionen_uppgiften_tillhor = 4u64;
        let sessionen_nu = 5u64; // användaren tryckte spela in igen
        assert!(!generation_is_current(sessionen_nu, sessionen_uppgiften_tillhor));
        assert!(generation_is_current(sessionen_nu, sessionen_nu));
    }

    #[test]
    fn ett_fardigt_bygge_slapps_bara_nar_fangsten_inte_ar_onskad() {
        use super::sys_capture_wanted;
        // 🔴 Regression, funnen av `/code-review ultra` på PR #234.
        //
        // Droppvillkoret i poll-hanteraren läste `!is_recording` rått medan reconcilen
        // som BESTÄLLDE bygget läste `sys_capture_wanted`. På Windows, där predikatet
        // alltid är sant, gav det: reconcilen beställer → bygget blir klart (synkront
        // där) → droppvillkoret ser `!is_recording` och släpper → reconcilen beställer
        // igen. Femtio gånger i sekunden, i viloläge.
        //
        // Testet fångar inte fel ANROPSSTÄLLE — bara review gör det. Det låser i
        // stället fast egenskapen som gör felet uppenbart när man läser båda:
        // en fångst är önskad i vila på Windows, alltså får ett färdigt bygge inte
        // släppas då.
        if cfg!(target_os = "macos") {
            assert!(!sys_capture_wanted(false), "macOS släpper i vila");
        } else {
            assert!(
                sys_capture_wanted(false),
                "Windows vill ha fångsten även i vila — ett färdigt bygge får inte släppas"
            );
        }
    }

    #[test]
    fn den_lata_livscykeln_ar_bara_macos() {
        use super::sys_capture_wanted;
        // 🔴 NEGATIVT TEST för plattformsgränsen. Motivet för att släppa tappen är
        // macOS-specifikt (sömnspärr + delad I2S-motor); WASAPI-loopbacken har ingen
        // motsvarande kostnad, och Windows-runtime går bara att verifiera via ett
        // signerat CI-bygge. Ett macOS-fix får inte tyst ändra den andra plattformen.
        if cfg!(target_os = "macos") {
            assert!(sys_capture_wanted(true), "under inspelning ska tappen hållas");
            assert!(!sys_capture_wanted(false), "i vila ska den släppas — hela poängen");
        } else {
            assert!(sys_capture_wanted(true));
            assert!(
                sys_capture_wanted(false),
                "Windows behåller loopbacken mellan inspelningar, som före ändringen"
            );
        }
    }

    #[test]
    fn saknad_fangst_varnar_utom_nar_vi_vet_att_ingen_spelar() {
        use super::missing_capture_is_a_problem;
        // 🔴 Det enda fallet som TYSTAR varningen är att vi VET att ingen spelar.
        // Det är dagens falsklarm: ren diktering på macOS gav "Systemljud är inte
        // tillgängligt" vid varje inspelningsstart, eftersom grinden mot vilande
        // utgång helt korrekt avstått från att bygga tappen.
        assert!(!missing_capture_is_a_problem(Some(false)));
        // Någon spelar och vi fångar inget → precis vad guardrailen finns för.
        assert!(missing_capture_is_a_problem(Some(true)));
        // 🔴 "Vet inte" MÅSTE varna. Det är Windows-vägen (metersvepet svarar där i
        // stället) och en macOS-version där process-API:t inte går att läsa. Tystas
        // den här grenen försvinner bannern för urdragen ljudutgång på Windows —
        // en tyst regression i den plattform ändringen inte ens rör.
        assert!(missing_capture_is_a_problem(None));
    }

    #[test]
    fn tystnadsvarningen_fyrar_inte_pa_ljudets_framkant() {
        use super::silent_capture_is_a_problem;
        use std::time::Duration;
        // 🔴 DET UPPMÄTTA FALSKLARMET, 2026-09-08 på den signerade betan:
        //
        //   15:24:23.117  fångst=true, annan_uppspelning=Some(true), bunden_tystnad=6s
        //   15:24:23.177  Speech TRIGGERED on MÖTET at RMS: 0.0617
        //
        // Sonden såg uppspelningen 60 ms innan vår egen ström hann leverera ett hörbart
        // block. I det glappet ser tillståndet ut som "de spelar och vi är döva". Med
        // pauser längre än fem sekunder — ett vanligt möte — träffar 2s-pollen där
        // regelbundet, och användaren får en gul banner mitt i ett fungerande möte.
        assert!(
            !silent_capture_is_a_problem(Some(Duration::from_millis(60)), false),
            "en uppspelning som just börjat är inget bevis för att vi är döva"
        );
        // Även ett par sekunder är för kort — vår kedja är resamplad och buffrad.
        assert!(!silent_capture_is_a_problem(Some(Duration::from_secs(2)), false));
        // Men har de spelat sammanhängande i fem sekunder och vi ändå inte hört något,
        // ÄR det TCC-fallet. Då ska varningen fyra.
        assert!(silent_capture_is_a_problem(Some(Duration::from_secs(5)), false));
        assert!(silent_capture_is_a_problem(Some(Duration::from_secs(30)), false));
    }

    #[test]
    fn tyst_fangst_varnar_bara_nar_nagon_faktiskt_spelar() {
        use super::silent_capture_is_a_problem;
        use std::time::Duration;
        // TCC-fallet: strömmen finns, levererar nollor, och någon annan spelar ljud.
        // macOS nekar systemljud HELT tyst — det här är den enda observerbara
        // skillnaden mellan ett återkallat medgivande och ett tyst möte.
        assert!(silent_capture_is_a_problem(Some(Duration::from_secs(10)), false));
        // Windows: metersvepet är underlaget, sonden svarar inte där. Det svepet är
        // redan utjämnat ("hördes inom 5 s"), så det behöver ingen egen varaktighet.
        assert!(silent_capture_is_a_problem(None, true));
        // 🔴 Tyst möte får ALDRIG varna. Under inspelning kör vår egen tap, så en
        // sond som räknade in oss själva hade svarat "ja, någon spelar" här och
        // flimrat bannern i varje paus i samtalet.
        assert!(!silent_capture_is_a_problem(None, false));
    }

    #[test]
    fn pending_bygge_ar_pending_tills_resultatet_hamtats() {
        // 🔴 Invarianten som skyddar mot två samtidiga aggregat: så länge ett bygge är
        // ute får loopens `needs_rebind` aldrig slå till. Före den här ändringen fanns
        // ingen sådan invariant — bygget var synkront och alltså aldrig "ute" — så den
        // införs och testas i samma andetag som asynkroniteten.
        let (tx, rx) = crossbeam_channel::bounded::<Option<super::SysCapture>>(1);
        let mut pending = super::PendingSysBuild {
            rx: Some(rx),
            pinned: Some("EarPods".to_string()),
        };
        assert!(pending.is_pending(), "ett obesvarat bygge måste räknas som pågående");
        assert!(pending.poll().is_none(), "poll får inte påstå att bygget är klart");
        assert!(pending.is_pending(), "en tom poll får inte avsluta bygget");

        // Bygget landar — här som ett misslyckande, vilket är det utfall som går att
        // konstruera utan en riktig CoreAudio-enhet.
        tx.send(None).unwrap();
        let resultat = pending.poll().expect("resultatet ska nu vara hämtbart");
        assert!(resultat.is_none());
        assert!(!pending.is_pending(), "efter hämtat resultat är bygget inte längre ute");
        assert_eq!(pending.take_pinned().as_deref(), Some("EarPods"));
        // Andra hämtningen ger ingenting: resultatet konsumeras exakt en gång.
        assert!(pending.poll().is_none());
    }

    #[test]
    fn en_forsvunnen_byggtrad_raknas_som_misslyckat_bygge() {
        // 🔴 Det farliga utfallet är inte ett fel — det är ett bygge som aldrig svarar.
        // Panikar byggtråden droppas sändaren, och utan den här grenen hade
        // `is_pending()` varit sant för alltid: MÖTET-kanalen byggs då aldrig om, tyst,
        // resten av appens körning. Samma familj som fynden revisionen letade efter.
        let (tx, rx) = crossbeam_channel::bounded::<Option<super::SysCapture>>(1);
        let mut pending = super::PendingSysBuild { rx: Some(rx), pinned: None };
        drop(tx);
        let resultat = pending.poll().expect("nedkopplad kanal måste ge ett resultat");
        assert!(resultat.is_none(), "ett bygge utan svar är ett misslyckat bygge");
        assert!(!pending.is_pending(), "annars fastnar loopen i 'bygger fortfarande'");
    }

    #[test]
    fn generationen_overlever_en_flagga_som_vander_tillbaka() {
        // 🔴 NEGATIVT TEST för motorgenerationen, och det modellerar exakt den
        // kapplöpning som gav två samtidiga motorer: stop() följt av start() innan
        // den gamla loopen hunnit läsa flaggan, vilket är normalfallet när loopen
        // står i ett blockerande enhetsbygge.
        let min_generation = 7u64;
        let mut flagga = true; // is_running
        let mut generation = min_generation;
        // Utgångsläget: motorn kör och är den aktuella.
        assert!(flagga);
        assert!(generation_is_current(generation, min_generation));

        // stop(): flaggan ned, generationen upp. Här är BÅDA mekanismerna ense —
        // hade den gamla tråden läst just nu hade den avslutat sig korrekt.
        flagga = false;
        generation += 1;
        assert!(!flagga);
        assert!(!generation_is_current(generation, min_generation));

        // Men den läser inte just nu: den står i ett blockerande enhetsbygge. start()
        // hinner emellan och sätter flaggan tillbaka.
        flagga = true;
        generation += 1;

        // Den gamla tråden vaknar ur sitt blockerande bygge och läser båda:
        assert!(
            flagga,
            "flaggan säger 'kör vidare' — det ÄR det gamla felet, och testet ska \
             dokumentera att den inte går att lita på"
        );
        assert!(
            !generation_is_current(generation, min_generation),
            "generationen får aldrig säga att en gammal tråd är aktuell"
        );

        // Och den aktuella tråden ska förstås få fortsätta.
        assert!(generation_is_current(generation, generation));
    }

    #[test]
    fn en_fangst_utan_bygge_ar_aldrig_stabil() {
        assert!(!sys_capture_was_stable(None, Instant::now()));
    }

    #[test]
    fn en_fangst_som_foll_direkt_ar_inte_stabil() {
        // 🔴 DET NEGATIVA TESTET. Det här är fallet grinden finns för: bygget
        // returnerade Ok, fångsten satte sin failed-flagga vid nästa 2s-poll, och
        // före ändringen nollställde det "lyckade" bygget felräknaren — så trappan
        // kunde aldrig klättra och ombyggnaden upprepades var annan sekund.
        let byggd = Instant::now();
        assert!(!sys_capture_was_stable(Some(byggd), byggd + Duration::from_secs(2)));
        // Även strax under fönstret ska falla.
        assert!(!sys_capture_was_stable(
            Some(byggd),
            byggd + SYS_STABLE_AFTER - Duration::from_millis(1)
        ));
    }

    #[test]
    fn en_fangst_som_levt_igenom_fonstret_ar_stabil() {
        let byggd = Instant::now();
        // Exakt på gränsen räknas som stabil — annars hamnar en fångst som levt
        // precis fönstret ut i backoffen på grund av en tick.
        assert!(sys_capture_was_stable(Some(byggd), byggd + SYS_STABLE_AFTER));
        assert!(sys_capture_was_stable(Some(byggd), byggd + Duration::from_secs(120)));
    }

    #[test]
    fn en_flappande_fangst_klattrar_i_trappan() {
        // Modellerar loopens bokföring: bygge → fångsten faller vid nästa poll →
        // bokförs som misslyckat försök eftersom den aldrig blev stabil.
        // Före ändringen gav samma sekvens streak = 0 varje varv, alltså 5 s för
        // alltid i bästa fall och 2 s (ingen väntan alls) i praktiken.
        let mut streak: u32 = 0;
        let mut vantetider = Vec::new();
        let mut nu = Instant::now();
        for _ in 0..4 {
            let byggd = nu;
            nu += Duration::from_secs(2); // faller vid nästa 2s-poll
            assert!(
                !sys_capture_was_stable(Some(byggd), nu),
                "en fångst som levt 2 s får aldrig räknas som lyckad"
            );
            streak = streak.saturating_add(1);
            vantetider.push(sys_retry_backoff(streak).as_secs());
        }
        assert_eq!(vantetider, vec![5, 15, 60, 300]);
    }

    #[test]
    fn hangningsdetektorn_faller_pa_det_uppmatta_fallet() {
        // 🔴 NEGATIVT TEST mot verkliga siffror. Den 30 augusti 2026 satt loopen
        // 34,3 s inne i build_mic_capture (13:22:12.684 → 13:22:47.013 i apploggen)
        // utan att skriva en enda rad. Detektorn ska fälla på just det gapet.
        assert!(loop_stalled(Duration::from_millis(34_329)));
        // Och på det ~14 s-gap ett misslyckat CoreAudio-bygge kostar.
        assert!(loop_stalled(Duration::from_secs(14)));
    }

    #[test]
    fn hangningsdetektorn_ar_tyst_i_normal_drift() {
        // Ett normalt varv är ~20 ms (recv_timeout) och det tyngsta planerade
        // arbetet är 2s-pollen. Ingen av dem får ge en falsk hängningsrad — en
        // detektor som varnar varje varv blir bortläst inom en dag.
        assert!(!loop_stalled(Duration::from_millis(20)));
        assert!(!loop_stalled(Duration::from_secs(2)));
        assert!(!loop_stalled(LOOP_STALL_AFTER - Duration::from_millis(1)));
    }

    #[test]
    fn hangningsdetektorn_tiger_om_gap_som_inte_kan_vara_blockeringar() {
        // Taket, och skälet till att det finns: ett gap på timmar är datorn som
        // sovit, inte ett anrop som hängt. Se LOOP_STALL_CEILING — frågan om
        // `Instant` räknar vilotid på macOS gick inte att köra här, och taket gör
        // den betydelselös i stället för gissad.
        assert!(!loop_stalled(LOOP_STALL_CEILING + Duration::from_secs(1)));
        assert!(!loop_stalled(Duration::from_secs(8 * 3600)));
        // Precis på taket är fortfarande en hängning.
        assert!(loop_stalled(LOOP_STALL_CEILING));
    }

    #[test]
    fn livstecknet_ar_tatt_under_inspelning_och_glest_i_vila() {
        // Nivåerna är diagnosen under inspelning; i vila var raden 99,5 % av
        // loggfilen (43 644 av 43 851 rader, uppmätt 2026-09-01).
        assert_eq!(heartbeat_interval(true), Duration::from_secs(1));
        assert!(heartbeat_interval(false) >= Duration::from_secs(30));
    }

    #[test]
    fn backoff_utan_vantan_slapper_igenom() {
        // Normalfallet: ingen backoff satt → ombyggnad tillåten.
        assert!(sys_rebuild_allowed(None, Instant::now()));
    }

    #[test]
    fn backoff_i_framtiden_blockerar() {
        // Det här är felet fixen finns för. Utan den här spärren byggde loopen om
        // var 2:e sekund för alltid, och varje försök kostade ett aggregat och
        // ~14 s CoreAudio-timeout.
        let now = Instant::now();
        assert!(!sys_rebuild_allowed(Some(now + Duration::from_secs(30)), now));
    }

    #[test]
    fn backoff_som_lopt_ut_slapper_igenom() {
        let now = Instant::now();
        assert!(sys_rebuild_allowed(Some(now - Duration::from_secs(1)), now));
        // Exakt på gränsen ska släppa igenom — annars fastnar en fångst som
        // väntat klart tills nästa poll råkar hamna en tick senare.
        let t = now + Duration::from_secs(5);
        assert!(sys_rebuild_allowed(Some(t), t));
    }

    #[test]
    fn backoff_vaxer_och_har_tak() {
        let v: Vec<u64> = (0..8).map(|n| sys_retry_backoff(n).as_secs()).collect();
        // Aldrig minskande — en längre felserie får aldrig ge tätare försök.
        for w in v.windows(2) {
            assert!(w[1] >= w[0], "backoffen minskade: {:?}", v);
        }
        // Taket håller: ett fel som aldrig går över kostar högst ett försök per
        // 5 minuter, inte ett var 14:e sekund.
        assert_eq!(*v.last().unwrap(), 300);
        // Första försöket väntar kort — en tillfällig störning ska inte kosta
        // användaren fem minuter utan mötesljud.
        assert_eq!(v[1], 5);
    }

    #[test]
    fn entiteter_det_uppmatta_fallet() {
        // Ordagrant vad modellen gav 2026-08-30, i två av två körningar.
        assert_eq!(
            avkoda_entiteter("Intäkterna ligger 9&nbsp;% över plan"),
            "Intäkterna ligger 9\u{00A0}% över plan"
        );
    }

    #[test]
    fn entiteter_amp_far_inte_avkodas_i_flera_steg() {
        // 🔴 Testet som motiverar en enda genomgång i stället för kedjade `replace`.
        // `&amp;nbsp;` ÄR den korrekta kodningen av den bokstavliga texten `&nbsp;`.
        // En kedja som avkodar `&amp;` först producerar då `&nbsp;`, och nästa led
        // gör om det till ett mellanslag — alltså tvärtemot vad texten sa.
        assert_eq!(avkoda_entiteter("koden &amp;nbsp; betyder"), "koden &nbsp; betyder");
    }

    #[test]
    fn entiteter_okanda_och_losa_lamnas_ororda() {
        // Transkriptet är användarens ord. Gissa aldrig.
        assert_eq!(avkoda_entiteter("Bolaget &finns; kvar"), "Bolaget &finns; kvar");
        assert_eq!(avkoda_entiteter("Ada & Bertil"), "Ada & Bertil");
        // Ett `;` längre bort än en entitet kan vara får inte sluka meningen.
        assert_eq!(
            avkoda_entiteter("Han sa & sedan tystnade han; sedan gick han"),
            "Han sa & sedan tystnade han; sedan gick han"
        );
    }

    #[test]
    fn entiteter_ovriga_former() {
        assert_eq!(avkoda_entiteter("Ada &amp; Bertil"), "Ada & Bertil");
        assert_eq!(avkoda_entiteter("&quot;citat&quot;"), "\"citat\"");
        assert_eq!(avkoda_entiteter("&lt;taggen&gt;"), "<taggen>");
        assert_eq!(avkoda_entiteter("&#229;&#228;&#246;"), "åäö");
        assert_eq!(avkoda_entiteter("&#xE5;"), "å");
        // Snabbvägen: text utan & ska komma tillbaka oförändrad.
        assert_eq!(avkoda_entiteter("helt vanlig mening"), "helt vanlig mening");
        assert_eq!(avkoda_entiteter(""), "");
    }
}
