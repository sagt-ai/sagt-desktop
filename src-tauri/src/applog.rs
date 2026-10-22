//! Apploggning till fil.
//!
//! # Varför modulen finns
//!
//! Appen hade 90 `println!`/`eprintln!`-anrop och **ingen av dem gick någonstans**.
//! Uppmätt på den installerade appen 2026-08-30 med `lsof -p <pid>`: fd 0, 1 och 2
//! pekade alla på `/dev/null`. En GUI-app startad från Finder ärver inga
//! terminalströmmar, så all instrumentering kastades bort.
//!
//! Följden blev konkret samma dag: en intermittent bugg där mikrofonen tystnade
//! kunde bara diagnosticeras genom att läsa macOS EGNA loggar via `/usr/bin/log` —
//! på utvecklarens maskin, i realtid. Hos en användare hade det inte funnits
//! någonting alls utöver en WAV-fil på 32 044 byte. En app som tiger både när den
//! fungerar och när den fallerar går inte att stödja i fält.
//!
//! # Varför omdirigering i stället för en loggmakro
//!
//! Alternativet var att byta ut 90 anropsplatser mot ett eget makro. Den här vägen
//! fångar dem alla utan att röra en enda rad — och fångar dessutom panics (som
//! skriver till stderr), utdata från bibliotek vi inte äger, och varje framtida
//! `println!` någon lägger till utan att känna till den här modulen.
//!
//! # Varför en pipe och inte `dup2` rakt på filen
//!
//! `dup2` direkt mot filen hade gett en logg UTAN tidsstämplar, eftersom de
//! befintliga anropen inte skriver några. Just tidskorrelationen mot `log show`
//! var det som knäckte buggen ovan, så en logg utan klockslag hade varit
//! halvvärdelös. Vi dup2:ar därför mot skrivänden av en pipe och låter en
//! läsartråd stämpla varje rad innan den når filen.
//!
//! # Windows: samma konstruktion, tre skillnader
//!
//! Windows har samma problem av samma skäl. En GUI-app (subsystem `windows`) får
//! ingen konsol, `GetStdHandle` returnerar NULL, och Rusts std mappar då varje
//! skrivning till `Ok(buf.len())` — `println!` **rapporterar att det gick bra** och
//! kastar bytesen. Tystnaden är alltså inte ens ett fel som går att upptäcka.
//! Konstruktionen är därför densamma — pipe, läsartråd, tidsstämpling, delad
//! `pump` — men tre detaljer skiljer, och alla tre är uppmätta 2026-09-04 med
//! fristående sonder (`rustc`-byggda, körda på den här maskinen) INNAN koden skrevs:
//!
//! 1. **`SetStdHandle` i stället för `dup2`.** Att det räcker för Rusts `println!`
//!    var inte självklart: `std::io::stdout()` är en lat statik, så farhågan var
//!    att handtaget cachas vid första användningen och att omdirigeringen därför
//!    bara skulle bita om den kom först. Det gör den inte — std anropar
//!    `GetStdHandle` vid VARJE skrivning. Sonden skrev därför avsiktligt en rad
//!    före omdirigeringen, och raderna efter hamnade ändå i pipen.
//! 2. **Skrivhandtaget stängs aldrig.** `dup2` skapar självständiga kopior, så
//!    unix-vägen kan stänga originalet efteråt. `SetStdHandle` lagrar bara
//!    handtagsVÄRDET, och stdout och stderr pekas på samma värde — att stänga det
//!    hade lämnat båda hängande. Handtaget läcks därför avsiktligt och lever
//!    processen ut, vilket är exakt lika länge som loggningen behövs.
//! 3. **Handtagen är icke-ärvbara** (`None` som `SECURITY_ATTRIBUTES`; uppmätt
//!    `HANDLE_FLAG_INHERIT = 0`). Den farliga hypotesen var att det skulle få
//!    `CreateProcess` att fälla med `ERROR_INVALID_HANDLE` och **tyst döda
//!    whisper-cli** — en degradering av precis den klass revisionen jagar. Sonden
//!    avfärdade den: `std::process::Command` duplicerar std-handtaget som ärvbart
//!    när `Stdio::inherit()` används, barnet startade, och dess utdata nådde
//!    loggen. Samma beteende som på unix, där fd 0–2 ärvs.

use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};

/// Rotera när filen passerar den här storleken. 5 MB räcker till många sessioner
/// av den ordrika DEBUG-utdata appen redan producerar, och är litet nog att kunna
/// bifogas i ett supportärende.
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// Hur ofta vakten kontrollerar att std-handtagen fortfarande pekar på loggen.
#[cfg(windows)]
const GUARD_INTERVAL: std::time::Duration = std::time::Duration::from_secs(60);

/// Loggens skrivände, satt när omdirigeringen lyckats. Bara Windows sätter den; på
/// unix når fd 1 loggen och std:s egna makron räcker. Handtaget stängs aldrig.
static LOG_PIPE: std::sync::OnceLock<std::mem::ManuallyDrop<File>> = std::sync::OnceLock::new();

/// Kroppen bakom craten egna `println!`, `print!`, `eprintln!` och `eprint!` (överst
/// i `lib.rs`), som skuggar std:s makron i hela craten.
///
/// 🔴 Varför appens utskrifter inte går via std-handtaget på Windows: startas ett
/// GUI-program från Start-menyn eller Utforskaren sätter skalet `STARTF_USEMONITOR`
/// och lägger ett skärmhandtag i stdout-fältet. Windows svarar då NULL på
/// `GetStdHandle(STD_OUTPUT_HANDLE)`, även efter `SetStdHandle`, vid varje anrop.
/// stderr påverkas inte. Rusts `println!` frågar vid varje skrivning, får NULL och
/// kastar texten utan fel. Uppmätt 2026-10-18, dels i appen (stdout-fältet i
/// processens parameterblock stod på pipen medan `GetStdHandle` svarade 0), dels med
/// en sond: ett GUI-program startat med flaggan fick 0x0 efter `SetStdHandle`, utan
/// flaggan pipens värde. Ett konsolprogram fick pipens värde i båda fallen, och
/// därför såg inget test det. Följden var att en app som startats från Start-menyn
/// inte loggade en enda rad.
///
/// Raden formateras först och skrivs med ett anrop, så att rader från olika trådar
/// inte klyvs. Före `init` går utskriften till std, vilket också håller MCP-läget
/// (som aldrig anropar `init`) och testharnessens fångst orörda.
///
/// Kvar: bibliotek som skriver till stdout med std:s egna makron når inte loggen
/// när appen startats från Start-menyn. Deras stderr gör det.
#[doc(hidden)]
pub fn write_line(args: std::fmt::Arguments<'_>, newline: bool, to_stderr: bool) {
    use std::io::Write;
    if let Some(pipe) = LOG_PIPE.get() {
        let mut text = std::fmt::format(args);
        if newline {
            text.push('\n');
        }
        let mut w: &File = pipe;
        let _ = w.write_all(text.as_bytes());
        return;
    }
    // `::std::` uttryckligen: utan prefix hade craten egna makron anropats, och de
    // leder hit igen.
    match (to_stderr, newline) {
        (false, true) => ::std::println!("{args}"),
        (false, false) => ::std::print!("{args}"),
        (true, true) => ::std::eprintln!("{args}"),
        (true, false) => ::std::eprint!("{args}"),
    }
}

/// För enhetstestet av makrona i `lib.rs`: en utskrift inifrån en modul. Makrona måste
/// stå före `mod`-raderna för att nå hit, och det är det testet prövar.
#[cfg(test)]
pub(crate) fn println_from_module(text: &str) {
    println!("{text}");
}

/// För enhetstestet av makrona i `lib.rs`: pekar `write_line` på en fil.
///
/// Processglobal och sätts en gång: efter anropet går varje `println!` i det
/// testbinäret till filen. Ett andra anrop fäller, i stället för att tyst ignoreras.
#[cfg(test)]
pub(crate) fn set_pipe_for_test(file: File) {
    assert!(
        LOG_PIPE.set(std::mem::ManuallyDrop::new(file)).is_ok(),
        "loggens pipe var redan satt i det här testbinäret"
    );
}

/// Startflaggorna processen fick (`STARTF_*`). Läses en gång, för loggen och vakten.
#[cfg(windows)]
fn startup_flags() -> u32 {
    #[repr(C)]
    struct StartupInfoW {
        cb: u32,
        reserved: *mut u16,
        desktop: *mut u16,
        title: *mut u16,
        x: u32,
        y: u32,
        x_size: u32,
        y_size: u32,
        x_count_chars: u32,
        y_count_chars: u32,
        fill_attribute: u32,
        flags: u32,
        show_window: u16,
        reserved2_len: u16,
        reserved2: *mut u8,
        std_input: *mut core::ffi::c_void,
        std_output: *mut core::ffi::c_void,
        std_error: *mut core::ffi::c_void,
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn GetStartupInfoW(si: *mut StartupInfoW);
    }
    // SAFETY: nollad struktur med rätt storlek i `cb`; funktionen fyller i den.
    let mut si: StartupInfoW = unsafe { std::mem::zeroed() };
    si.cb = std::mem::size_of::<StartupInfoW>() as u32;
    unsafe { GetStartupInfoW(&mut si) };
    si.flags
}

/// `STARTF_USEMONITOR`: stdout-fältet bär ett skärmhandtag (se `write_line`).
#[cfg(windows)]
const STARTF_USEMONITOR: u32 = 0x400;

/// Satt: vakten avslutas vid nästa varv och rör inte std-handtagen mer.
#[cfg(windows)]
static GUARD_STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Stoppar vakten. Finns för testet, som måste kunna återställa konsolens handtag
/// utan att vakten pekar om dem till loggen igen före assertionerna.
#[cfg(windows)]
#[doc(hidden)]
pub fn stop_guard() {
    GUARD_STOP.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// Startar filloggningen och returnerar sökvägen till den aktiva loggfilen.
///
/// Anropas så tidigt som möjligt i `setup`, så att även uppstartens utskrifter
/// fångas. Fel här får ALDRIG hindra appen från att starta — en app som vägrar
/// köra för att den inte kunde öppna sin loggfil vore ett sämre fel än det den
/// försöker göra felsökbart. Därför `Result` som anroparen får logga och släppa.
pub fn init(app_data_dir: &Path) -> std::io::Result<PathBuf> {
    #[cfg(windows)]
    return init_with_guard(app_data_dir, GUARD_INTERVAL, None);
    #[cfg(not(windows))]
    return init_with_guard(app_data_dir, std::time::Duration::ZERO, None);
}

/// `init` med ett valbart intervall för vakten och, för testerna, ett påtvingat svar
/// på om stdout maskeras (`None` = läs processens startflaggor). Bara Windows använder
/// dem. Finns för att testerna ska kunna köra vakten på en bråkdel av en sekund och
/// pröva båda lägena, eftersom ett testbinär aldrig får skalets flagga.
#[doc(hidden)]
pub fn init_with_guard(
    app_data_dir: &Path,
    guard_interval: std::time::Duration,
    stdout_masked: Option<bool>,
) -> std::io::Result<PathBuf> {
    // Läses en gång och delas av loggraden och vakten, så att de inte kan vara oense.
    #[cfg(windows)]
    let flags = startup_flags();
    #[cfg(windows)]
    let stdout_masked = stdout_masked.unwrap_or(flags & STARTF_USEMONITOR != 0);
    #[cfg(not(windows))]
    let stdout_masked = stdout_masked.unwrap_or(false);

    let dir = app_data_dir.join("logs");
    fs::create_dir_all(&dir)?;
    let path = dir.join("sagt.log");

    // En generation bakåt sparas. Skälet att spara någon alls: felet man vill läsa
    // om har ofta redan hänt när användaren hör av sig, och en rotation mitt i
    // sessionen skulle annars radera just det.
    if fs::metadata(&path).map(|m| m.len() >= MAX_LOG_BYTES).unwrap_or(false) {
        let _ = fs::rename(&path, dir.join("sagt.log.1"));
    }

    let file = OpenOptions::new().create(true).append(true).open(&path)?;
    spawn_redirect(path.clone(), file, guard_interval, stdout_masked)?;

    println!(
        "=== Sagt.ai {} ({}) startad {} ===",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f")
    );
    #[cfg(windows)]
    {
        println!(
            "DEBUG: Startflaggor {flags:#x}{}",
            if stdout_masked {
                " (startad från skalet: stdout maskeras av Windows, appens utskrifter går direkt till loggen)"
            } else {
                ""
            }
        );
    }
    Ok(path)
}

/// Läsartrådens kropp: läser rader ur pipen, stämplar dem och skriver till `file`.
///
/// 🔴 **Delad mellan unix och Windows med avsikt.** Det enda som skiljer
/// plattformarna är hur pipen skapas och hur std-strömmarna pekas om; allt
/// härifrån och ned — UTF-8-skyddet, att aldrig avbryta vid fel, rotationen — är
/// identiskt. Kopierat i två exemplar hade en framtida rättelse i den ena armen
/// tyst missat den andra, och det är en felform repot redan betalat för: en
/// plattformsgrind som gjorde två anropsställen oense (2026-09-03). En generisk `BufRead` kostar ingenting och tar bort möjligheten.
#[cfg(any(unix, windows))]
fn pump<R: std::io::BufRead>(mut reader: R, path: PathBuf, mut file: File, mut written: u64) {
    use std::io::Write;

    let mut buf: Vec<u8> = Vec::with_capacity(1024);
    loop {
        buf.clear();
        // 🔴 `read_until` på BYTES, inte `lines()`. `lines()` ger
        // Err(InvalidData) på en enda icke-UTF-8-byte, och att avsluta
        // tråden på det hade varit ett självmål av värsta slag: pipen
        // fylls då till sitt tak och VARJE println! i appen blockerar
        // i kärnan för alltid. Loggningen som infördes för att göra
        // hängningar felsökbara hade själv blivit en hängning.
        // Ett bibliotek vi inte äger räcker för att utlösa det.
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) => break, // EOF: skrivänden stängd, processen avslutas
            Ok(_) => {}
            Err(_) => {
                // Aldrig break. Sov kort så ett ihållande fel inte blir
                // en varvande tråd, och fortsätt läsa.
                std::thread::sleep(std::time::Duration::from_millis(100));
                continue;
            }
        }
        let line = String::from_utf8_lossy(&buf);
        let line = line.trim_end_matches(['\n', '\r']);
        let rad = format!("{} {}\n", chrono::Local::now().format("%H:%M:%S%.3f"), line);
        // Skrivfel ignoreras av samma skäl som läsfel: en full disk får
        // inte frysa appen. Att tappa loggrader är alltid billigare.
        if file.write_all(rad.as_bytes()).is_ok() {
            written += rad.len() as u64;
            let _ = file.flush();
        }

        // Rotationen måste ske HÄR, inte bara i init: den session man vill
        // läsa är just den som loggar tätt, och en kontroll som bara körs
        // vid start hade låtit den växa fritt hela dagen.
        if written >= MAX_LOG_BYTES {
            let _ = fs::rename(&path, path.with_extension("log.1"));
            match OpenOptions::new().create(true).append(true).open(&path) {
                Ok(f) => {
                    file = f;
                    written = 0;
                }
                // Gick den inte att öppna: fortsätt skriva i den gamla
                // (nu omdöpta) filen hellre än att tappa loggningen helt.
                Err(_) => written = 0,
            }
        }
    }
}

/// Kopplar processens stdout och stderr till en pipe vars läsände stämplas och
/// skrivs till `file`.
#[cfg(unix)]
fn spawn_redirect(
    path: PathBuf,
    mut file: File,
    _guard_interval: std::time::Duration,
    _stdout_masked: bool,
) -> std::io::Result<()> {
    // Importerna bor HÄR, inte på modulnivå: de används bara i den unix-gatade
    // vägen, och på Windows kompileras funktionen bort — då blir de oanvända och
    // `Desktop Rust (release warnings)` fäller bygget. Fångat av just den grinden
    // på första releasen efter att den lagades, 2026-08-30.
    use std::io::{BufReader, Seek};
    use std::os::unix::io::FromRawFd;

    let mut fds = [0i32; 2];
    // SAFETY: `fds` är en giltig array om två i32. pipe() skriver exakt två fd:n.
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let (read_fd, write_fd) = (fds[0], fds[1]);

    let written = file.stream_position().unwrap_or(0);

    // 🔴 LÄSARTRÅDEN STARTAS FÖRE dup2, och ordningen är hela poängen.
    //
    // Tvärtom — dup2 först, spawn sedan — lämnar processens stdout och stderr
    // pekande in i en pipe som ingen läser om spawn failar. Felet returneras
    // visserligen, men anroparen loggar det och låter appen starta (avsiktligt,
    // se doc-kommentaren på `init`), och då fylls pipen till sina 64 KB varefter
    // VARJE println! i appen blockerar i kärnan för alltid. Det är exakt samma
    // hängning som `read_until`-valet i `pump` finns för att undvika, via en
    // annan dörr: modulen som skulle göra hängningar felsökbara blir själv
    // hängningen.
    //
    // Med den här ordningen är ett misslyckat spawn ofarligt — ingenting är
    // omdirigerat ännu, och båda fd:n stängs innan vi returnerar.
    let spawned = std::thread::Builder::new()
        .name("applog".into())
        .spawn(move || {
            // SAFETY: read_fd ägs härifrån och stängs när File droppas.
            let f = unsafe { File::from_raw_fd(read_fd) };
            pump(BufReader::new(f), path, file, written);
        });
    if let Err(e) = spawned {
        // SAFETY: båda fd:n är öppna och ägs fortfarande här — tråden som skulle
        // ha tagit över read_fd startade aldrig.
        unsafe {
            libc::close(read_fd);
            libc::close(write_fd);
        }
        return Err(e);
    }

    // SAFETY: write_fd är öppen och giltig. dup2 stänger målets tidigare fd.
    // Både 1 och 2 pekas om, så eprintln! hamnar i samma ström och därmed i samma
    // tidsordning som println! — de var tidigare två oberoende strömmar.
    for target in [libc::STDOUT_FILENO, libc::STDERR_FILENO] {
        if unsafe { libc::dup2(write_fd, target) } < 0 {
            let err = std::io::Error::last_os_error();
            // Stäng skrivänden så läsartråden får EOF och avslutar sig själv i
            // stället för att ligga kvar och hålla loggfilen öppen.
            unsafe { libc::close(write_fd) };
            return Err(err);
        }
    }
    // SAFETY: write_fd är duplicerad till 1 och 2 och behövs inte längre separat.
    unsafe { libc::close(write_fd) };

    Ok(())
}

/// Windows-motsvarigheten: `CreatePipe` + `SetStdHandle` i stället för `pipe` +
/// `dup2`. Se modulens doc-kommentar för de tre skillnader som spelar roll, och
/// för vad som mättes upp för att belägga var och en av dem.
#[cfg(windows)]
fn spawn_redirect(
    path: PathBuf,
    mut file: File,
    guard_interval: std::time::Duration,
    stdout_masked: bool,
) -> std::io::Result<()> {
    // Samma skäl som i unix-armen: importerna bor här därför att funktionen
    // kompileras bort på andra plattformar och de annars blir oanvända, vilket
    // fäller `Desktop Rust (release warnings)`.
    use std::io::{BufReader, Seek};
    use std::os::windows::io::FromRawHandle;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Console::{SetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE};
    use windows::Win32::System::Pipes::CreatePipe;

    let mut read_handle = HANDLE::default();
    let mut write_handle = HANDLE::default();
    // SAFETY: båda pekarna pekar på giltiga HANDLE-variabler på stacken.
    // `None` = inga SECURITY_ATTRIBUTES, vilket ger ICKE-ärvbara handtag (se
    // modulkommentaren punkt 3 — mätt, inte antaget). `0` = systemets
    // standardbuffertstorlek.
    unsafe { CreatePipe(&mut read_handle, &mut write_handle, None, 0) }
        .map_err(|e| std::io::Error::other(format!("CreatePipe: {e}")))?;

    let written = file.stream_position().unwrap_or(0);

    // Läsänden görs om till en File HÄR, före spawn, och inte inne i tråden som i
    // unix-armen. Asymmetrin är påtvingad, inte en smaksak: `HANDLE` är en nyputs
    // runt `*mut c_void` och är därför inte `Send`, så den kan inte flyttas in i
    // en closure. Ett rått `i32`-fd kan. `File` äger handtaget, är `Send`, och
    // stänger det i sin `Drop` — vilket dessutom gör felvägen nedan enklare än
    // unix motsvarighet.
    //
    // SAFETY: read_handle kommer från ett CreatePipe som just lyckats, och
    // ägandet lämnas över till File i och med det här anropet. Ingen annan kopia
    // av handtaget finns kvar.
    let reader = BufReader::new(unsafe { File::from_raw_handle(read_handle.0) });

    // 🔴 LÄSARTRÅDEN STARTAS FÖRE SetStdHandle, av exakt samma skäl som i
    // unix-armen — och skälet väger TYNGRE här. Uppmätt 2026-09-04 med
    // `GetNamedPipeInfo` på en pipe skapad precis som nedan (anonyma pipes är
    // internt named pipes, så den svarar): **4 096 byte**, mot unix 65 536. En
    // oläst pipe fylls alltså sexton gånger fortare, och avståndet mellan "spawn
    // failade" och "appen hänger i sin första println!" är i motsvarande grad
    // kortare.
    let spawned = std::thread::Builder::new()
        .name("applog".into())
        .spawn(move || pump(reader, path, file, written));
    if let Err(e) = spawned {
        // Läsänden är REDAN stängd här: closuren droppades när spawn failade, och
        // med den vår File. Att stänga read_handle igen hade varit en dubbelstängning.
        // Kvar är bara skrivänden, som ingen äger. Ingenting är omdirigerat ännu.
        //
        // SAFETY: write_handle är öppet, ägs här, och har inte lämnats vidare.
        unsafe {
            let _ = CloseHandle(write_handle);
        }
        return Err(e);
    }

    // Både stdout och stderr pekas på SAMMA handtag, så eprintln! hamnar i samma
    // ström och därmed i samma tidsordning som println!.
    //
    // 🔴 write_handle stängs ALDRIG härefter. Till skillnad från dup2 duplicerar
    // SetStdHandle ingenting — den lagrar värdet. Ett CloseHandle här hade lämnat
    // både stdout och stderr pekande på ett rivet handtag.
    //
    // 🔴 De två strömmarna behandlas OLIKA vid fel, med avsikt. En loop över båda
    // med `?` såg symmetrisk ut men ljög: lyckas stdout och failar stderr har vi
    // en fungerande logg som bara saknar panics, och ett `Err` därifrån hade fått
    // `init` att hoppa över sin egen versionsrubrik och anroparen att rapportera
    // "kunde inte starta filloggning" om en logg som i själva verket skriver.
    // stdout bär alla 90 println! och är därför den som avgör utfallet; stderr är
    // en förbättring vi noterar i loggen om den uteblir.

    // SAFETY: write_handle är öppet och giltigt, och lever processen ut.
    unsafe { SetStdHandle(STD_OUTPUT_HANDLE, write_handle) }
        .map_err(|e| std::io::Error::other(format!("SetStdHandle(stdout): {e}")))?;

    // Appens egna utskrifter går härefter direkt till pipen (se `write_line`).
    // SAFETY: handtaget är öppet och stängs aldrig; ManuallyDrop hindrar File från
    // att stänga det.
    let _ = LOG_PIPE.set(std::mem::ManuallyDrop::new(unsafe {
        File::from_raw_handle(write_handle.0)
    }));

    // SAFETY: samma handtag, fortfarande öppet och giltigt.
    if let Err(e) = unsafe { SetStdHandle(STD_ERROR_HANDLE, write_handle) } {
        // println! och inte eprintln!: stdout är omdirigerad sedan raden ovan, så
        // det HÄR hamnar i loggfilen. Ett eprintln! hade gått till den ström vi
        // just misslyckades med att peka om, alltså ingenstans.
        println!("VARNING: stderr kunde inte omdirigeras, panics når inte loggen: {e}");
    }

    // Noll betyder ingen vakt. En vakt med intervallet noll hade snurrat utan paus.
    if !guard_interval.is_zero() {
        spawn_guard(write_handle.0 as isize, guard_interval, stdout_masked);
    }
    Ok(())
}

/// Skriver en rad rakt till loggens pipe, förbi std-handtagen och Rusts stdout. Det
/// är vaktens enda väg att rapportera när just de vägarna inte fungerar.
#[cfg(windows)]
fn write_direct(pipe: isize, text: &str) {
    use std::io::Write;
    use std::os::windows::io::FromRawHandle;
    // SAFETY: `pipe` är loggens skrivhandtag, som aldrig stängs (se ovan).
    // ManuallyDrop: File får inte stänga det när funktionen är klar.
    let mut f = std::mem::ManuallyDrop::new(unsafe {
        File::from_raw_handle(pipe as std::os::windows::io::RawHandle)
    });
    let _ = f.write_all(text.as_bytes());
}

/// Startar vakten, som var `interval` kontrollerar att std-handtagen fortfarande pekar
/// på loggen. Appens egna utskrifter behöver dem inte längre (se `write_line`), men
/// panics och bibliotekens utskrifter går via dem. Har ett handtag ändrats skrivs de
/// gamla och nya värdena direkt till pipen, och handtagen återställs.
///
/// stdout kontrolleras inte när `stdout_masked`: Windows svarar då alltid NULL för
/// den, och vakten hade larmat varje minut om något som inte går att ändra.
///
/// Avvägning: återställningen skriver över varje ändring av std-handtagen, även en
/// avsiktlig. Ingen del av appen pekar om dem i dag. Gör någon det i framtiden måste
/// vakten få veta det, annars förlorar den delen sin omdirigering inom en minut.
/// Det gamla värdet står alltid i rapporten.
#[cfg(windows)]
fn spawn_guard(pipe: isize, interval: std::time::Duration, stdout_masked: bool) {
    use std::sync::atomic::Ordering;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::Console::{
        GetStdHandle, SetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE,
    };

    let _ = std::thread::Builder::new().name("applog-vakt".into()).spawn(move || {
        // SAFETY: GetStdHandle läser bara processens std-handtagstabell.
        let current = |id| unsafe { GetStdHandle(id) }.map(|h| h.0 as isize).unwrap_or(0);
        loop {
            std::thread::sleep(interval);
            if GUARD_STOP.load(Ordering::SeqCst) {
                return;
            }
            let (out, err) = (current(STD_OUTPUT_HANDLE), current(STD_ERROR_HANDLE));
            if err != pipe || (!stdout_masked && out != pipe) {
                write_direct(
                    pipe,
                    &format!(
                        "[applog] std-handtagen har ändrats (stdout={out:#x}, stderr={err:#x}, \
                         loggen={pipe:#x}). Återställer.\n"
                    ),
                );
                let h = HANDLE(pipe as *mut core::ffi::c_void);
                // SAFETY: loggens skrivhandtag, öppet så länge processen lever.
                unsafe {
                    let _ = SetStdHandle(STD_OUTPUT_HANDLE, h);
                    let _ = SetStdHandle(STD_ERROR_HANDLE, h);
                }
            }
        }
    });
}

/// Övriga plattformar. Ingen av dem byggs idag — appen levereras för Windows och
/// macOS — så armen finns för att `cfg`-täckningen ska vara total, inte för att
/// någon ska falla hit.
#[cfg(not(any(unix, windows)))]
fn spawn_redirect(
    _path: PathBuf,
    _file: File,
    _guard_interval: std::time::Duration,
    _stdout_masked: bool,
) -> std::io::Result<()> {
    Ok(())
}
