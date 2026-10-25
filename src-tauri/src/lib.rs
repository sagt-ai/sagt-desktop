// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

// Craten egna utskriftsmakron. De skuggar std:s i hela craten och skriver via
// `applog::write_line`, som efter `init` går direkt till loggen. Skälet står där:
// på Windows tappar std:s `println!` all text när appen startats från Start-menyn.
// 🔴 De måste stå FÖRE `mod`-raderna nedan: ett `macro_rules!` syns bara i det som
// kommer efter det i källtexten.
macro_rules! println {
    () => { $crate::applog::write_line(::std::format_args!(""), true, false) };
    ($($arg:tt)*) => { $crate::applog::write_line(::std::format_args!($($arg)*), true, false) };
}
// Oanvända i dag, men måste finnas: ett framtida print! hade annars gått via std och
// tappats på samma sätt.
#[allow(unused_macros)]
macro_rules! print {
    ($($arg:tt)*) => { $crate::applog::write_line(::std::format_args!($($arg)*), false, false) };
}
macro_rules! eprintln {
    () => { $crate::applog::write_line(::std::format_args!(""), true, true) };
    ($($arg:tt)*) => { $crate::applog::write_line(::std::format_args!($($arg)*), true, true) };
}
#[allow(unused_macros)]
macro_rules! eprint {
    ($($arg:tt)*) => { $crate::applog::write_line(::std::format_args!($($arg)*), false, true) };
}

pub mod applog;
mod audio;
mod audio_meter;
mod cloud_upload;
/// Systemljud via Core Audio Taps. All osäker CoreAudio-FFI är isolerad här,
/// på samma sätt som audio_meter.rs isolerar WASAPI:s COM-kod.
#[cfg(target_os = "macos")]
mod mac_sysaudio;
mod database;
mod recovery;
mod mcp;

use database::{CleanupResult, DatabaseManager, Recording, Segment, StorageUsage};
use tauri::Emitter;
use tauri::Manager;
use std::sync::Mutex;
use std::collections::HashSet;

/// Holds the PID of the active whisper-cli child process.
/// Stored as a PID (u32) rather than Child to avoid Send/ownership issues
/// when stdout is taken and the thread is blocking on it.
pub struct TranscriptionProcess {
    /// PID:er för alla aktiva whisper-cli-processer. cancel_transcription dödar samtliga
    /// (tidigare höll fältet bara EN PID → kön fortsatte efter Avbryt).
    pub pids: Mutex<HashSet<u32>>,
}

// Removed AppState wrapper to allow easier access from audio.rs
// struct AppState {
//    db: Mutex<DatabaseManager>,
// }

#[tauri::command]
fn init_audio_engine(
    state: tauri::State<'_, audio::AudioMonitor>,
    app: tauri::AppHandle,
    device: Option<String>,
) -> Result<(), String> {
    state.start(app, device)
}

#[tauri::command]
fn get_audio_devices(
    state: tauri::State<'_, audio::AudioMonitor>,
) -> Vec<audio::AudioDevice> {
    state.get_input_devices()
}

// Synkront med avsikt, som `stop_recording`: båda körs då på huvudtråden i den ordning
// de kom. Som `async` hade en Stopp direkt efter en start kunnat köras först, och
// starten sedan lämnat motorn inspelande medan gränssnittet visade stoppat. Priset är
// att fönstret står stilla medan den förra inspelningen sparas, vilket bara märks om
// den sparningen är en kopiering mellan volymer.
#[tauri::command]
fn start_recording(
    app: tauri::AppHandle,
    state: tauri::State<'_, audio::AudioMonitor>,
    proc: tauri::State<'_, TranscriptionProcess>,
) -> Result<(), String> {
    // Ny session: bumpa generationen och dränera föregående sessions transkriberingar
    // (döda kvarvarande whisper-cli + invalidera köade) så gammal text inte läcker in
    // i den nya inspelningen.
    audio::bump_session_generation();
    kill_registered(&proc.pids, kill_pid);
    state.start_recording(&app)
}

#[tauri::command]
fn stop_recording(
    state: tauri::State<'_, audio::AudioMonitor>,
) -> Result<(), String> {
    state.stop_recording()
}

// Settings-mikrofontestet: håll micen öppen medan Inställningar visas, släpp vid lämning.
// Tillsammans med is_recording avgör detta `mic_wanted` i motorloopens reconcile.
#[tauri::command]
fn start_mic_preview(state: tauri::State<'_, audio::AudioMonitor>) {
    state.set_mic_preview(true);
}

#[tauri::command]
fn stop_mic_preview(state: tauri::State<'_, audio::AudioMonitor>) {
    state.set_mic_preview(false);
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn stop_audio_listener(
    state: tauri::State<'_, audio::AudioMonitor>,
) {
    state.stop();
}

/// VAD-inställningarna bor i två världar: Zustand-persist i JS och `AudioSettings` här.
/// JS är sanningskällan och MÅSTE pusha hit vid appstart — inte bara när Inställningar
/// öppnas. Annars kör motorn sina egna defaults (800 ms) medan storen säger något annat.
/// Inget `language` längre: den lokala sidecarn kör alltid svenska (se audio.rs).
#[tauri::command]
fn update_audio_settings(
    state: tauri::State<'_, audio::AudioMonitor>,
    threshold: f32,
    silence_ms: u64,
) {
    state.update_settings(threshold, silence_ms);
}

#[tauri::command]
fn set_cloud_mode(
    state: tauri::State<'_, audio::AudioMonitor>,
    cloud_streaming: bool,
    merge_channels: bool,
) {
    state.set_cloud_mode(cloud_streaming, merge_channels);
}

// Live-diarisering (STEG 3): JS slår på detta när en pyannote Live-1-session mintats och
// stänger av det vid stopp/degradering. På → MÖTET-kanalen emitteras som `live-diarize-pcm`.
#[tauri::command]
fn set_live_diarize_mode(
    state: tauri::State<'_, audio::AudioMonitor>,
    enabled: bool,
) {
    state.set_live_diarize(enabled);
}

// `async`: kommandot kör annars på huvudtråden, och taskkill och sparandet nedan låste
// då fönstret medan de pågick.
#[tauri::command(async)]
fn cancel_transcription(
    app: tauri::AppHandle,
    state: tauri::State<'_, TranscriptionProcess>,
    monitor: tauri::State<'_, audio::AudioMonitor>,
) -> Result<u64, String> {
    // Först av allt, så att ett klick syns i loggen även när det inte fanns något att döda.
    println!("[KillSwitch] Avbryt begärt");
    // Bumpa generationen → köade OCH pågående uppgifter slänger sina resultat (se audio.rs).
    // 🔴 Före tömningen nedan: uppgiften registrerar sitt PID och prövar generationen i
    // omvänd ordning, så att en process som startar under Avbryt inte överlever det.
    let generation = audio::bump_session_generation();
    // Döda ALLA aktiva whisper-cli-processer, inte bara den senast spawnade.
    let (attempted, killed) = kill_registered(&state.pids, kill_pid);
    println!(
        "[KillSwitch] Generation nu {}, {} av {} whisper-cli dödade",
        generation, killed, attempted
    );
    // Spara det som finns. Utan detta väntade sparandet på transkriberingar som just
    // avbrutits, och inspelningen sparades aldrig.
    monitor.cancel_session(&app);
    // Gränssnittet visar bara text från den här generationen och senare.
    Ok(generation)
}

/// Finns en inspelning som inte är färdigsparad? Frågas av stängvakten och uppdateraren.
/// Svaret kommer från ljudmotorn, inte från gränssnittets tillstånd, så att det stämmer
/// även efter en omladdning av gränssnittet.
#[tauri::command]
fn session_busy(monitor: tauri::State<'_, audio::AudioMonitor>) -> bool {
    monitor.session_busy()
}

/// Vid start: inspelningar som aldrig blev färdigsparade får en rad. Körs en gång per
/// körning, och inte medan en inspelning pågår. Asynkront, så att en flytt av en stor
/// ljudfil mellan volymer inte fryser fönstret.
#[tauri::command]
async fn recover_recordings(
    monitor: tauri::State<'_, audio::AudioMonitor>,
    db: tauri::State<'_, Mutex<DatabaseManager>>,
    marker: Option<recovery::LeftoverMarker>,
) -> Result<recovery::RecoveryReport, String> {
    Ok(monitor.recover(&db, marker))
}

/// Tömmer mängden och anropar `kill` för varje PID medan låset hålls. Svarar med
/// (antal försök, antal som lyckades).
///
/// 🔴 Under låset. En uppgift avregistrerar sitt PID innan den skördar processen, så ett
/// PID i mängden tillhör alltid en process som inte skördats. Dödades de efter att låset
/// släppts kunde en process hinna avslutas och dess PID delas ut till en annan process
/// innan kill kom fram. Ett förgiftat lås får inte hindra att processerna dödas.
fn kill_registered(pids: &Mutex<HashSet<u32>>, kill: impl Fn(u32) -> bool) -> (usize, usize) {
    let mut pids = pids.lock().unwrap_or_else(|e| e.into_inner());
    let attempted = pids.len();
    let killed = pids.drain().filter(|&pid| kill(pid)).count();
    (attempted, killed)
}

/// Dödar en whisper-cli-process via OS:ets kill-kommando (best-effort) och svarar om det
/// lyckades. Utfallet loggas: ett misslyckat kill var tidigare osynligt, och en process
/// som överlevt Avbryt gick då inte att skilja från en som aldrig fanns.
fn kill_pid(pid: u32) -> bool {
    println!("[KillSwitch] Killing whisper-cli process PID={}", pid);
    #[cfg(target_os = "windows")]
    let result = {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW, som för whisper-cli: taskkill är ett konsolprogram, och
        // startat från en app utan konsol får det annars ett eget konsolfönster.
        // ⚠️ ANTAGANDE: att det fönstret (och muspekaren som visar att ett program
        // startar) är vad som syntes efter Avbryt. Inte kört i appen.
        std::process::Command::new("taskkill")
            .args(&["/F", "/PID", &pid.to_string()])
            .creation_flags(0x08000000)
            .output()
    };
    #[cfg(not(target_os = "windows"))]
    let result = std::process::Command::new("kill")
        .args(&["-9", &pid.to_string()])
        .output();
    match result {
        Ok(out) if out.status.success() => true,
        Ok(out) => {
            eprintln!(
                "[KillSwitch] Kunde inte döda PID={} ({:?})",
                pid,
                out.status.code()
            );
            false
        }
        Err(e) => {
            eprintln!("[KillSwitch] Kunde inte starta kill för PID={}: {}", pid, e);
            false
        }
    }
}

#[tauri::command]
fn read_audio_file(app: tauri::AppHandle, path: String) -> Result<Vec<u8>, String> {
    let requested = std::fs::canonicalize(&path)
        .map_err(|e| format!("Ogiltig sökväg: {}", e))?;
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Kunde inte bestämma datakatalog: {}", e))?;
    // Canonicalize båda sidor — på Windows ger canonicalize \\?\ UNC-prefix
    // vilket gör att starts_with misslyckas mot icke-canonicaliserad app_data.
    let app_data = std::fs::canonicalize(&app_data)
        .map_err(|e| format!("Kunde inte normalisera datakatalog: {}", e))?;
    if !requested.starts_with(&app_data) {
        return Err("Åtkomst nekad: sökvägen ligger utanför appens datakatalog.".to_string());
    }
    std::fs::read(&requested).map_err(|e| e.to_string())
}

// Database Commands
#[tauri::command]
fn save_recording_to_db(
    state: tauri::State<'_, Mutex<DatabaseManager>>,
    recording: Recording,
    segments: Vec<Segment>,
) -> Result<Recording, String> {
    let db = state.lock().map_err(|e| e.to_string())?;
    db.save_recording(recording, segments)
}

#[tauri::command]
fn get_recordings(
    state: tauri::State<'_, Mutex<DatabaseManager>>,
) -> Result<Vec<Recording>, String> {
    let db = state.lock().map_err(|e| e.to_string())?;
    db.get_all_recordings()
}

#[tauri::command]
fn get_recording_segments(
    state: tauri::State<'_, Mutex<DatabaseManager>>,
    recording_id: i64,
) -> Result<Vec<Segment>, String> {
    let db = state.lock().map_err(|e| e.to_string())?;
    db.get_recording_segments(recording_id)
}

#[tauri::command]
fn update_recording_segments(
    state: tauri::State<'_, Mutex<DatabaseManager>>,
    recording_id: i64,
    segments: Vec<Segment>,
) -> Result<(), String> {
    let db = state.lock().map_err(|e| e.to_string())?;
    db.update_recording_segments(recording_id, segments)
}

#[tauri::command]
fn update_recording_status(
    state: tauri::State<'_, Mutex<DatabaseManager>>,
    id: i64,
    status: String,
    cloud_job_id: Option<String>,
) -> Result<(), String> {
    let db = state.lock().map_err(|e| e.to_string())?;
    db.update_recording_status(id, status, cloud_job_id)
}

#[tauri::command]
fn delete_recording_db(
    state: tauri::State<'_, Mutex<DatabaseManager>>,
    id: i64,
) -> Result<(), String> {
    let db = state.lock().map_err(|e| e.to_string())?;
    db.delete_recording(id)
}

#[tauri::command]
fn save_analysis_to_db(
    state: tauri::State<'_, Mutex<DatabaseManager>>,
    id: i64,
    analysis: String,
    template: String,
) -> Result<(), String> {
    let db = state.lock().map_err(|e| e.to_string())?;
    db.save_analysis(id, analysis, template)
}

#[tauri::command]
fn save_cloud_transcript_to_db(
    state: tauri::State<'_, Mutex<DatabaseManager>>,
    id: i64,
    transcript: String,
) -> Result<(), String> {
    let db = state.lock().map_err(|e| e.to_string())?;
    db.save_cloud_transcript(id, transcript)
}

// JS anropar med camelCase: invoke("save_cloud_segments_to_db", { id, cloudSegments })
#[tauri::command]
fn save_cloud_segments_to_db(
    state: tauri::State<'_, Mutex<DatabaseManager>>,
    id: i64,
    cloud_segments: String,
) -> Result<(), String> {
    let db = state.lock().map_err(|e| e.to_string())?;
    db.save_cloud_segments(id, cloud_segments)
}

// JS anropar med camelCase: invoke("save_speaker_map_to_db", { id, speakerMap })
#[tauri::command]
fn save_speaker_map_to_db(
    state: tauri::State<'_, Mutex<DatabaseManager>>,
    id: i64,
    speaker_map: String,
) -> Result<(), String> {
    let db = state.lock().map_err(|e| e.to_string())?;
    db.save_speaker_map(id, speaker_map)
}

#[tauri::command]
fn get_storage_usage(
    state: tauri::State<'_, Mutex<DatabaseManager>>,
) -> Result<StorageUsage, String> {
    let db = state.lock().map_err(|e| e.to_string())?;
    db.get_storage_usage()
}

/// Sökvägen till inspelningskatalogen. JS öppnar den med plugin-opener så användaren kan
/// se sina egna ljudfiler i Utforskaren — "ljudet stannar på din dator" ska gå att
/// kontrollera, inte bara läsas.
#[tauri::command]
fn get_recordings_dir(
    state: tauri::State<'_, Mutex<DatabaseManager>>,
) -> Result<String, String> {
    let db = state.lock().map_err(|e| e.to_string())?;
    Ok(db.recordings_dir().to_string_lossy().to_string())
}

/// Auto-gallring av ljudfiler (äldst först). DB-rader med transkript/analys behålls
/// och markeras audio_deleted. Anropas från JS med camelCase: maxAgeDays, maxTotalBytes.
#[tauri::command]
fn cleanup_audio_storage(
    state: tauri::State<'_, Mutex<DatabaseManager>>,
    app: tauri::AppHandle,
    max_age_days: Option<u32>,
    max_total_bytes: Option<u64>,
) -> Result<CleanupResult, String> {
    let result = {
        let db = state.lock().map_err(|e| e.to_string())?;
        db.cleanup_audio(max_age_days, max_total_bytes)?
    };
    // Eget event (inte history-updated) — App.tsx kör gallring på history-updated,
    // så att återanvända det eventet skulle ge en loop. deleted_ids kan innehålla
    // reconcilierade rader (fil saknades) även när deleted_count är 0.
    if !result.deleted_ids.is_empty() {
        let _ = app.emit("storage-cleaned", &result);
    }
    Ok(result)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // `sagt --mcp`: lokal MCP-server på stdin/stdout, före allt annat (se src/mcp/mod.rs).
    if mcp::is_mcp_invocation(std::env::args()) {
        std::process::exit(mcp::run_stdio());
    }
    tauri::Builder::default()
        // Först bland pluginen, som dokumentationen kräver: startas appen igen medan
        // den redan körs avslutas den nya processen här, innan den hunnit öppna
        // fönster, mikrofon eller databas, och det fönster som redan finns visas.
        // MCP-läget ovan avslutar före byggaren och berörs inte.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // Raden skrivs av den process som redan körde. Den nya avslutas i pluginet,
            // före `setup` där loggen öppnas, så utan raden lämnar en omstart inget spår.
            // ⚠️ ANTAGANDE: att pluginet avslutar den nya processen före `setup`. Följer
            // av dokumentationen, inte kört och mätt.
            let windows = app.webview_windows();
            println!("DEBUG: Ny start begärd medan appen körde ({} fönster)", windows.len());
            if let Some(window) = windows.into_values().next() {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .setup(|app| {
            // 🔴 FÖRST av allt. Allt som skrivs före den här raden går till /dev/null
            // i en GUI-startad app, inklusive felen från uppstädningen nedan — och
            // det är just uppstartsutskrifterna man vill ha när något går fel tidigt.
            //
            // Ett misslyckande här får inte hindra appen från att starta: en app som
            // vägrar köra för att loggfilen inte gick att öppna vore ett sämre fel än
            // det den ska göra felsökbart. Vi skriver därför bara vidare till den
            // ström som ändå finns.
            match app.path().app_data_dir() {
                Ok(dir) => match applog::init(&dir) {
                    Ok(path) => println!("DEBUG: Loggfil: {}", path.display()),
                    Err(e) => eprintln!("DEBUG: Kunde inte starta filloggning: {e}"),
                },
                Err(e) => eprintln!("DEBUG: Ingen app-datakatalog för loggen: {e}"),
            }

            // Kill any zombie whisper-cli processes from previous runs
            #[cfg(target_os = "windows")]
            {
                use std::process::Command;
                let _ = Command::new("taskkill")
                    .args(&["/F", "/IM", "whisper-cli*"])
                    .output();
            }
            // 🔴 pkill -x, INTE -f. `-x` matchar processNAMNET exakt; `-f` matchar mot
            // hela kommandoraden och hade dödat vilken process som helst som råkar ha
            // strängen i sina argument — inklusive en terminal där någon just skrivit
            // kommandot, eller den här appen själv om sökvägen nämns i argv.
            #[cfg(not(target_os = "windows"))]
            {
                use std::process::Command;
                for name in ["whisper-cli", "whisper-cli-aarch64-apple-darwin"] {
                    let _ = Command::new("pkill").args(["-x", name]).output();
                }
            }

            // Ljudbehörigheten begärs vid START, inte vid första inspelningen.
            // Skälet är rent UX: dialogen dyker upp när användaren precis öppnat
            // appen och förstår varför den frågar, i stället för mitt i ett möte.
            // Utan detta hade FÖRSTA inspelningen alltid tappat systemljudet,
            // eftersom try_sys_capture då ser NotDetermined och degraderar.
            //
            // Vi väntar inte på svaret — dialogen är asynkron och varje inspelning
            // läser statusen på nytt med preflight().
            #[cfg(target_os = "macos")]
            {
                use crate::mac_sysaudio::{self, Permission};
                match mac_sysaudio::preflight() {
                    Permission::NotDetermined => {
                        println!("DEBUG: Ljudbehörighet ej beslutad — begär vid start");
                        mac_sysaudio::request_permission();
                    }
                    p => println!("DEBUG: Ljudbehörighet vid start: {:?}", p),
                }
            }

            app.manage(audio::AudioMonitor::new());
            app.manage(TranscriptionProcess {
                pids: Mutex::new(HashSet::new()),
            });
            
            // Initialize Database
            let db_manager = DatabaseManager::new(app.handle());
            // app.manage(AppState {
            //     db: Mutex::new(db_manager),
            // });
            // Manage Mutex<DatabaseManager> directly
            app.manage(Mutex::new(db_manager));

            Ok(())
        })
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            greet, 
            init_audio_engine, 
            get_audio_devices,
            start_recording,
            stop_recording,
            session_busy,
            recover_recordings,
            start_mic_preview,
            stop_mic_preview,
            stop_audio_listener,
            update_audio_settings,
            set_cloud_mode,
            set_live_diarize_mode,
            read_audio_file,
            cancel_transcription,
            save_recording_to_db,
            get_recordings,
            get_recording_segments,
            update_recording_segments,
            delete_recording_db,
            update_recording_status,
            save_analysis_to_db,
            save_cloud_transcript_to_db,
            save_cloud_segments_to_db,
            save_speaker_map_to_db,
            get_storage_usage,
            get_recordings_dir,
            cleanup_audio_storage,
            audio::extract_meeting_channel,
            audio::delete_diarize_temp,
            cloud_upload::upload_cloud_audio,
            mcp::commands::mcp_write_session,
            mcp::commands::mcp_clear_session,
            mcp::commands::mcp_server_command
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|_app, event| match event {
            // Avslutet syns i loggen. Utan raderna gick en process som levde vidare
            // utan fönster inte att skilja från en som avslutats.
            tauri::RunEvent::ExitRequested { code, .. } => {
                println!("DEBUG: Avslut begärt (kod {:?})", code);
            }
            tauri::RunEvent::Exit => println!("DEBUG: Appen avslutas"),
            _ => {}
        });
}

/// Delat mellan modulernas tester.
#[cfg(test)]
pub(crate) mod test_util {
    /// En process som lever i 30 sekunder om ingen dödar den.
    pub fn langlivad_process() -> std::process::Child {
        #[cfg(target_os = "windows")]
        let mut cmd = std::process::Command::new("ping");
        #[cfg(target_os = "windows")]
        cmd.args(["-n", "30", "127.0.0.1"]);
        #[cfg(not(target_os = "windows"))]
        let mut cmd = std::process::Command::new("sleep");
        #[cfg(not(target_os = "windows"))]
        cmd.arg("30");
        cmd.stdout(std::process::Stdio::null())
            .spawn()
            .expect("kunde inte starta testprocessen")
    }
}

#[cfg(test)]
mod tests {
    use super::{kill_pid, kill_registered};
    use crate::test_util::langlivad_process;
    use std::collections::HashSet;
    use std::sync::Mutex;

    #[test]
    fn println_i_craten_gar_till_loggen_och_inte_via_std() {
        // Kopplingen mellan craten utskrifter och loggen. Saknas makrot, eller står det
        // efter mod-raderna, går println! via std och testharnessens fångst i stället.
        let path = std::env::temp_dir().join(format!("sagt-makro-{}.txt", std::process::id()));
        let file = std::fs::File::create(&path).expect("temporär fil");
        crate::applog::set_pipe_for_test(file);
        println!("MAKRO_NADDE_LOGGEN_8d1e");
        eprintln!("MAKRO_STDERR_8d1e");
        crate::applog::println_from_module("MAKRO_I_MODUL_8d1e");
        let innehall = std::fs::read_to_string(&path).unwrap_or_default();
        let _ = std::fs::remove_file(&path);
        assert!(innehall.contains("MAKRO_NADDE_LOGGEN_8d1e
"), "println! gick inte via loggen: {innehall:?}");
        assert!(innehall.contains("MAKRO_STDERR_8d1e
"), "eprintln! gick inte via loggen: {innehall:?}");
        assert!(
            innehall.contains("MAKRO_I_MODUL_8d1e
"),
            "println! i en modul gick via std; står makrona efter mod-raderna? {innehall:?}"
        );
    }

    #[test]
    fn rakningen_skiljer_forsok_fran_lyckade() {
        let pids = Mutex::new(HashSet::from([4u32, 8, 12]));
        let (forsok, lyckade) = kill_registered(&pids, |pid| pid != 8);
        assert_eq!((forsok, lyckade), (3, 2));
    }

    #[test]
    fn avbryt_dodar_medan_mangden_ar_last() {
        // En uppgift avregistrerar sitt PID innan den skördar processen. Hålls låset under
        // kill kan processen alltså inte ha skördats, och PID:t inte ha delats ut på nytt.
        let pids = Mutex::new(HashSet::from([4u32, 8]));
        let lasta = std::cell::Cell::new(0);
        let (n, _) = kill_registered(&pids, |_| {
            if pids.try_lock().is_err() {
                lasta.set(lasta.get() + 1);
            }
            true
        });
        assert_eq!(n, 2);
        assert_eq!(lasta.get(), 2, "kill anropades utan att mängden var låst");
        assert!(pids.lock().unwrap().is_empty());
    }

    #[test]
    fn kill_pid_dodar_processen_och_svarar_ja() {
        let mut child = langlivad_process();
        assert!(kill_pid(child.id()));
        let status = child.wait().expect("wait");
        assert!(!status.success(), "processen avslutades inte av kill");
    }

    #[test]
    fn kill_pid_svarar_nej_nar_inget_dog() {
        // Svaret ska vara nej när ingenting dödades, inte det tysta ja som det kastade
        // utfallet tidigare motsvarade.
        //
        // 🔴 Ett PID som aldrig kan finnas, inte ett som just avslutats: Windows återanvänder
        // PID:n snabbt, och testet hade då kunnat döda en främmande process. Värdet är
        // ingen multipel av fyra; uppmätt 2026-10-16 var samtliga 283 PID:n på en
        // Windows 11-maskin det, och `taskkill` svarade 128 ("not found") på just det här.
        // Det ryms i ett i32, så att `kill` inte kan tolka det som -1 (alla processer).
        // ⚠️ ANTAGANDE: att det ligger över PID-taket på macOS och Linux. Inte kört där.
        const FINNS_INTE: u32 = 99_999_999;
        assert!(!kill_pid(FINNS_INTE));
    }
}
