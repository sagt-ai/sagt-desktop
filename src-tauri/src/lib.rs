// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
pub mod applog;
mod audio;
mod audio_meter;
/// Systemljud via Core Audio Taps. All osäker CoreAudio-FFI är isolerad här,
/// på samma sätt som audio_meter.rs isolerar WASAPI:s COM-kod.
#[cfg(target_os = "macos")]
mod mac_sysaudio;
mod database;

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

#[tauri::command]
fn start_recording(
    state: tauri::State<'_, audio::AudioMonitor>,
    proc: tauri::State<'_, TranscriptionProcess>,
) -> Result<(), String> {
    // Ny session: bumpa generationen och dränera föregående sessions transkriberingar
    // (döda kvarvarande whisper-cli + invalidera köade) så gammal text inte läcker in
    // i den nya inspelningen.
    audio::bump_session_generation();
    if let Ok(mut pids) = proc.pids.lock() {
        for pid in pids.drain() {
            kill_pid(pid);
        }
    }
    state.start_recording()
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

#[tauri::command]
fn cancel_transcription(
    state: tauri::State<'_, TranscriptionProcess>,
) -> Result<(), String> {
    // Bumpa generationen → köade OCH pågående uppgifter slänger sina resultat (se audio.rs).
    audio::bump_session_generation();
    // Döda ALLA aktiva whisper-cli-processer, inte bara den senast spawnade.
    if let Ok(mut pids) = state.pids.lock() {
        for pid in pids.drain() {
            kill_pid(pid);
        }
    }
    Ok(())
}

/// Dödar en whisper-cli-process via OS:ets kill-kommando (best-effort).
fn kill_pid(pid: u32) {
    println!("[KillSwitch] Killing whisper-cli process PID={}", pid);
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("taskkill")
            .args(&["/F", "/PID", &pid.to_string()])
            .output();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("kill")
            .args(&["-9", &pid.to_string()])
            .output();
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
    tauri::Builder::default()
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
        .invoke_handler(tauri::generate_handler![
            greet, 
            init_audio_engine, 
            get_audio_devices,
            start_recording,
            stop_recording,
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
            audio::delete_diarize_temp
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
