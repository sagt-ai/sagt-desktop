use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use tauri::Manager;

#[derive(Debug, Serialize, Deserialize)]
pub struct Recording {
    pub id: Option<i64>,
    pub filename: String,
    pub file_path: String,
    pub duration_sec: f64,
    pub created_at: String,
    pub sync_status: String, // 'local' or 'synced'
    pub cloud_job_id: Option<String>,
    pub analysis_json: Option<String>,
    pub ai_template_used: Option<String>,
    /// KB-Whisper Large-resultat (moln). Lagras separat från de lokala segmenten så
    /// användaren kan växla mellan modellernas resultat för samma inspelning.
    pub cloud_transcript: Option<String>,
    /// Strukturerade molnsegment (Fas 1c) — JSON `[{start_time,end_time,text,speaker}]` med
    /// DU/MÖTET-turer från stereo-omtranskribering. Lagras separat från `cloud_transcript`
    /// (flat text = modellväxlarens fallback) så molnvyn kan rendera turer i stället för en
    /// textblob. serde(default) — `save_recording_to_db` skickar inte fältet vid första sparningen.
    #[serde(default)]
    pub cloud_segments: Option<String>,
    /// Talaridentifiering (Fas 1) — JSON `{ "map": {etikett→namn}, "participants": [...] }`.
    /// Icke-förstörande: segmenten lämnas orörda, UI:t applicerar namnen ovanpå Du/Mötet.
    /// serde(default) — `save_recording_to_db` skickar inte fältet vid första sparningen.
    #[serde(default)]
    pub speaker_map: Option<String>,
    /// Ljudfilen har gallrats (auto-gallring). DB-raden med segment/analys behålls,
    /// men moln-omtranskribering och synk kräver ljudet och inaktiveras i UI.
    /// serde(default) — äldre frontend-anrop (save_recording_to_db) skickar inte fältet.
    #[serde(default)]
    pub audio_deleted: bool,
    /// Härlett vid läsning (EXISTS mot segments) — persisteras aldrig. Driver
    /// "Transkribering & analys"-kolumnen i Inspelningar-vyn.
    #[serde(default)]
    pub has_segments: bool,
    /// Var inspelningen står efter Stopp. `None` = färdig. Se `processing_state`.
    #[serde(default)]
    pub processing_state: Option<String>,
}

/// Värdena i kolumnen `processing_state`. `NULL` betyder att inspelningen är färdig.
///
/// Raden och ljudfilen sparas direkt vid Stopp, innan den lokala transkriberingen hunnit
/// ikapp. Stängs appen under tiden finns inspelningen redan i biblioteket, med den text
/// som hann bli klar.
pub mod processing_state {
    /// Sparad vid Stopp. Segmenten fylls på medan transkriberingen arbetar ikapp.
    pub const PROCESSING: &str = "processing";
    /// Transkriberingen avbröts: av Avbryt, av en ny inspelning, eller av att appen
    /// stängdes. Ljudet är helt, texten kan saknas i slutet.
    pub const INTERRUPTED: &str = "interrupted";
    /// Hittad vid start som en ljudfil utan rad. Ljudet finns, texten saknas.
    pub const RECOVERED: &str = "recovered";
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Segment {
    pub id: Option<i64>,
    pub recording_id: Option<i64>,
    pub start_time: f64,
    pub end_time: f64,
    pub text: String,
    pub speaker: String,
}

/// Diskanvändning för lokal lagring — visas i Inställningar → Lagring.
#[derive(Debug, Serialize)]
pub struct StorageUsage {
    pub recordings_bytes: u64,
    pub db_bytes: u64,
    pub file_count: u32,
}

/// Resultat av en auto-gallring (cleanup_audio). deleted_ids låter frontend
/// uppdatera in-memory-state (t.ex. öppnad inspelning i SplitView) utan DB-omfråga.
#[derive(Debug, Serialize, Clone)]
pub struct CleanupResult {
    pub deleted_count: u32,
    pub freed_bytes: u64,
    pub deleted_ids: Vec<i64>,
}

pub struct DatabaseManager {
    db_path: PathBuf,
    recordings_dir: PathBuf,
}

impl DatabaseManager {
    pub fn new(app_handle: &AppHandle) -> Self {
        let app_data_dir = app_handle.path().app_data_dir().expect("Failed to get app data dir");
        
        if !app_data_dir.exists() {
            fs::create_dir_all(&app_data_dir).expect("Failed to create app data dir");
        }

        let recordings_dir = app_data_dir.join("recordings");
        if !recordings_dir.exists() {
             fs::create_dir_all(&recordings_dir).expect("Failed to create recordings dir");
        }

        let db_path = app_data_dir.join("whisper.db");
        
        let manager = Self { db_path, recordings_dir };
        manager.init_db().expect("Failed to init DB");
        manager
    }

    /// Samma som `new`, men i en given katalog och utan appen. För tester.
    #[cfg(test)]
    pub fn new_in(app_data_dir: PathBuf) -> Result<Self, String> {
        let recordings_dir = app_data_dir.join("recordings");
        fs::create_dir_all(&recordings_dir).map_err(|e| e.to_string())?;
        let manager = Self { db_path: app_data_dir.join("whisper.db"), recordings_dir };
        manager.init_db().map_err(|e| e.to_string())?;
        Ok(manager)
    }

    fn get_connection(&self) -> Result<Connection> {
        Connection::open(&self.db_path)
    }

    fn init_db(&self) -> Result<()> {
        let conn = self.get_connection()?;
        
        conn.execute(
            "CREATE TABLE IF NOT EXISTS recordings (
                id INTEGER PRIMARY KEY,
                filename TEXT NOT NULL,
                file_path TEXT NOT NULL,
                duration_sec REAL NOT NULL,
                created_at TEXT NOT NULL,
                sync_status TEXT DEFAULT 'local',
                cloud_job_id TEXT
            )",
            [],
        )?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS segments (
                id INTEGER PRIMARY KEY,
                recording_id INTEGER NOT NULL,
                start_time REAL NOT NULL,
                end_time REAL NOT NULL,
                text TEXT NOT NULL,
                speaker TEXT NOT NULL,
                FOREIGN KEY(recording_id) REFERENCES recordings(id) ON DELETE CASCADE
            )",
            [],
        )?;

        // SQLite indexerar inte FK-kolumner automatiskt. Utan detta gör EXISTS-kollen
        // i get_all_recordings (och get_segments/DELETE-kaskaden) en full skanning av
        // segments per inspelningsrad — O(inspelningar × segment) vid stora bibliotek.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_segments_recording_id ON segments(recording_id)",
            [],
        )?;

        // Migration: Check if analysis_json column exists
        let analysis_col_exists: bool = conn.query_row(
            "SELECT count(*) FROM pragma_table_info('recordings') WHERE name='analysis_json'",
            [],
            |row| row.get(0),
        ).unwrap_or(0) > 0;

        if !analysis_col_exists {
            let _ = conn.execute("ALTER TABLE recordings ADD COLUMN analysis_json TEXT", []);
        }

        // Migration: Check if ai_template_used column exists
        let template_col_exists: bool = conn.query_row(
            "SELECT count(*) FROM pragma_table_info('recordings') WHERE name='ai_template_used'",
            [],
            |row| row.get(0),
        ).unwrap_or(0) > 0;

        if !template_col_exists {
            let _ = conn.execute("ALTER TABLE recordings ADD COLUMN ai_template_used TEXT", []);
        }

        // Migration: cloud_transcript — molnresultat per inspelning (växla lokal/moln-modell)
        let cloud_transcript_col_exists: bool = conn.query_row(
            "SELECT count(*) FROM pragma_table_info('recordings') WHERE name='cloud_transcript'",
            [],
            |row| row.get(0),
        ).unwrap_or(0) > 0;

        if !cloud_transcript_col_exists {
            let _ = conn.execute("ALTER TABLE recordings ADD COLUMN cloud_transcript TEXT", []);
        }

        // Migration: audio_deleted — ljudfil gallrad men transkript/analys behållna
        let audio_deleted_col_exists: bool = conn.query_row(
            "SELECT count(*) FROM pragma_table_info('recordings') WHERE name='audio_deleted'",
            [],
            |row| row.get(0),
        ).unwrap_or(0) > 0;

        if !audio_deleted_col_exists {
            let _ = conn.execute("ALTER TABLE recordings ADD COLUMN audio_deleted INTEGER NOT NULL DEFAULT 0", []);
        }

        // Migration: speaker_map — talaridentifiering (tilltalsnamn ovanpå Du/Mötet, Fas 1)
        let speaker_map_col_exists: bool = conn.query_row(
            "SELECT count(*) FROM pragma_table_info('recordings') WHERE name='speaker_map'",
            [],
            |row| row.get(0),
        ).unwrap_or(0) > 0;

        if !speaker_map_col_exists {
            let _ = conn.execute("ALTER TABLE recordings ADD COLUMN speaker_map TEXT", []);
        }

        // Migration: cloud_segments — strukturerade molnsegment (DU/MÖTET-turer, Fas 1c)
        let cloud_segments_col_exists: bool = conn.query_row(
            "SELECT count(*) FROM pragma_table_info('recordings') WHERE name='cloud_segments'",
            [],
            |row| row.get(0),
        ).unwrap_or(0) > 0;

        if !cloud_segments_col_exists {
            let _ = conn.execute("ALTER TABLE recordings ADD COLUMN cloud_segments TEXT", []);
        }

        // Migration: processing_state — inspelningen sparas vid Stopp och blir färdig senare.
        // NULL för alla befintliga rader: de sparades först när de var färdiga.
        let processing_state_col_exists: bool = conn.query_row(
            "SELECT count(*) FROM pragma_table_info('recordings') WHERE name='processing_state'",
            [],
            |row| row.get(0),
        ).unwrap_or(0) > 0;

        if !processing_state_col_exists {
            let _ = conn.execute("ALTER TABLE recordings ADD COLUMN processing_state TEXT", []);
        }

        Ok(())
    }

    pub fn save_recording(&self, mut recording: Recording, segments: Vec<Segment>) -> Result<Recording, String> {
        // 1. Move file to persistent storage
        let (new_path_str, filename_str) = {
            let temp_path = Path::new(&recording.file_path);
            if temp_path.exists() {
                let filename = temp_path.file_name().ok_or("Invalid filename")?;
                let new_path = self.recordings_dir.join(filename);

                // Flytt först: på samma volym är den omedelbar, och sparandet vid Stopp
                // ska inte behöva kopiera en timslång inspelning medan appen kan stängas.
                // Ligger temp-katalogen på en annan volym misslyckas flytten, och då
                // kopieras filen som förut.
                move_file(temp_path, &new_path).map_err(|e| format!("Failed to copy file: {}", e))?;
                
                (new_path.to_string_lossy().to_string(), filename.to_string_lossy().to_string())
            } else {
                 return Err(format!("Source Audio File not found: {}", recording.file_path));
            }
        };

        let original_path = std::mem::replace(&mut recording.file_path, new_path_str);
        recording.filename = filename_str;

        match self.insert_recording(&mut recording, segments) {
            Ok(()) => Ok(recording),
            Err(e) => {
                // Utan rad hittas filen aldrig i inspelningskatalogen: gallringen och
                // återställningen utgår från raderna respektive temp-katalogen. Den
                // flyttas därför tillbaka, så att nästa försök, eller återställningen
                // vid nästa start, hittar den där den låg.
                if let Err(back) = move_file(Path::new(&recording.file_path), Path::new(&original_path)) {
                    eprintln!("Warning: could not move {:?} back after failed save: {}", recording.file_path, back);
                }
                Err(e)
            }
        }
    }

    fn insert_recording(&self, recording: &mut Recording, segments: Vec<Segment>) -> Result<(), String> {
        let mut conn = self.get_connection().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        // 2. Insert Recording
        tx.execute(
            "INSERT INTO recordings (filename, file_path, duration_sec, created_at, sync_status, cloud_job_id, analysis_json, ai_template_used, cloud_transcript, audio_deleted, speaker_map, cloud_segments, processing_state)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                recording.filename,
                recording.file_path,
                recording.duration_sec,
                recording.created_at,
                recording.sync_status,
                recording.cloud_job_id,
                recording.analysis_json,
                recording.ai_template_used,
                recording.cloud_transcript,
                recording.audio_deleted,
                recording.speaker_map,
                recording.cloud_segments,
                recording.processing_state
            ],
        ).map_err(|e| e.to_string())?;

        let recording_id = tx.last_insert_rowid();
        recording.id = Some(recording_id);

        // 3. Insert Segments
        Self::insert_segments(&tx, recording_id, &segments)?;

        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_all_recordings(&self) -> Result<Vec<Recording>, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT id, filename, file_path, duration_sec, created_at, sync_status, cloud_job_id, analysis_json, ai_template_used, cloud_transcript, audio_deleted, speaker_map, cloud_segments, EXISTS(SELECT 1 FROM segments WHERE segments.recording_id = recordings.id), processing_state FROM recordings ORDER BY created_at DESC").map_err(|e| e.to_string())?;

        let recordings_iter = stmt.query_map([], Self::map_recording).map_err(|e| e.to_string())?;

        let mut recordings = Vec::new();
        for recording in recordings_iter {
            recordings.push(recording.map_err(|e| e.to_string())?);
        }
        Ok(recordings)
    }

    /// En rad, med samma kolumner som `get_all_recordings`.
    pub fn get_recording(&self, id: i64) -> Result<Recording, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id, filename, file_path, duration_sec, created_at, sync_status, cloud_job_id, analysis_json, ai_template_used, cloud_transcript, audio_deleted, speaker_map, cloud_segments, EXISTS(SELECT 1 FROM segments WHERE segments.recording_id = recordings.id), processing_state FROM recordings WHERE id = ?1",
            params![id],
            Self::map_recording,
        ).map_err(|e| e.to_string())
    }

    fn map_recording(row: &rusqlite::Row) -> rusqlite::Result<Recording> {
            Ok(Recording {
                id: Some(row.get(0)?),
                filename: row.get(1)?,
                file_path: row.get(2)?,
                duration_sec: row.get(3)?,
                created_at: row.get(4)?,
                sync_status: row.get(5)?,
                cloud_job_id: row.get(6)?,
                analysis_json: row.get(7)?,
                ai_template_used: row.get(8)?,
                cloud_transcript: row.get(9)?,
                audio_deleted: row.get(10)?,
                speaker_map: row.get(11)?,
                cloud_segments: row.get(12)?,
                has_segments: row.get(13)?,
                processing_state: row.get(14)?,
            })
    }

    /// Avslutar en inspelning som sparades vid Stopp: ersätter segmenten och sätter
    /// slutläget (`None` = färdig, eller `INTERRUPTED`).
    ///
    /// Rör bara en rad som fortfarande står på `PROCESSING`. Har användaren raderat den,
    /// eller har den redan avslutats, returneras `Ok(None)` och ingenting skrivs: en sen
    /// transkribering får inte återuppliva en raderad inspelning.
    pub fn finish_processing(&self, id: i64, segments: &[Segment], end_state: Option<&str>) -> Result<Option<Recording>, String> {
        let mut conn = self.get_connection().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let changed = tx.execute(
            "UPDATE recordings SET processing_state = ?1 WHERE id = ?2 AND processing_state = ?3",
            params![end_state, id, processing_state::PROCESSING],
        ).map_err(|e| e.to_string())?;
        if changed == 0 {
            return Ok(None);
        }
        Self::replace_segments(&tx, id, segments)?;
        tx.commit().map_err(|e| e.to_string())?;
        self.get_recording(id).map(Some)
    }

    /// Lägger till segment som blivit klara för en inspelning som fortfarande bearbetas.
    /// Bara de nya: segmenten kommer i den ordning de blir klara och läggs alltid till
    /// sist, så det som redan står i raden ändras aldrig. Samma vakt som
    /// `finish_processing`: en raderad eller avslutad rad rörs inte.
    pub fn append_processing_segments(&self, id: i64, new_segments: &[Segment]) -> Result<bool, String> {
        let mut conn = self.get_connection().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let still_processing: bool = tx.query_row(
            "SELECT count(*) FROM recordings WHERE id = ?1 AND processing_state = ?2",
            params![id, processing_state::PROCESSING],
            |row| row.get::<_, i64>(0),
        ).map_err(|e| e.to_string())? > 0;
        if !still_processing {
            return Ok(false);
        }
        Self::insert_segments(&tx, id, new_segments)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(true)
    }

    /// Finns en rad vars ljudfil har det här namnet? Sessionsfilens namn behålls när den
    /// flyttas till inspelningskatalogen.
    pub fn has_recording_named(&self, filename: &str) -> Result<bool, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT count(*) FROM recordings WHERE filename = ?1",
            params![filename],
            |row| row.get::<_, i64>(0),
        )
        .map(|n| n > 0)
        .map_err(|e| e.to_string())
    }

    /// Rader som stod på `PROCESSING` när appen startade: appen stängdes medan
    /// transkriberingen arbetade ikapp. Ljudet och texten fram till dess finns kvar.
    /// Returnerar antalet.
    pub fn mark_interrupted_processing(&self) -> Result<usize, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE recordings SET processing_state = ?1 WHERE processing_state = ?2",
            params![processing_state::INTERRUPTED, processing_state::PROCESSING],
        ).map_err(|e| e.to_string())
    }

    fn replace_segments(tx: &rusqlite::Transaction, recording_id: i64, segments: &[Segment]) -> Result<(), String> {
        tx.execute("DELETE FROM segments WHERE recording_id = ?1", params![recording_id])
            .map_err(|e| e.to_string())?;
        Self::insert_segments(tx, recording_id, segments)
    }

    fn insert_segments(tx: &rusqlite::Transaction, recording_id: i64, segments: &[Segment]) -> Result<(), String> {
        let mut stmt = tx.prepare(
            "INSERT INTO segments (recording_id, start_time, end_time, text, speaker)
             VALUES (?1, ?2, ?3, ?4, ?5)"
        ).map_err(|e| e.to_string())?;
        for segment in segments {
            stmt.execute(params![
                recording_id,
                segment.start_time,
                segment.end_time,
                segment.text,
                segment.speaker
            ]).map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn get_recording_segments(&self, recording_id: i64) -> Result<Vec<Segment>, String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare("SELECT id, recording_id, start_time, end_time, text, speaker FROM segments WHERE recording_id = ?1 ORDER BY start_time ASC").map_err(|e| e.to_string())?;
        
        let segments_iter = stmt.query_map(params![recording_id], |row| {
            Ok(Segment {
                id: Some(row.get(0)?),
                recording_id: Some(row.get(1)?),
                start_time: row.get(2)?,
                end_time: row.get(3)?,
                text: row.get(4)?,
                speaker: row.get(5)?,
            })
        }).map_err(|e| e.to_string())?;

        let mut segments = Vec::new();
        for segment in segments_iter {
            segments.push(segment.map_err(|e| e.to_string())?);
        }
        Ok(segments)
    }

    /// Ersätt segmenten för en inspelning (idempotent). Används för PRO-molnströmning där
    /// segmenten kommer succesivt och måste persisteras post-stop så historik/återöppning
    /// visar samma Du/Mötet-vy som live (annars sparas inspelningen utan segment).
    pub fn update_recording_segments(&self, recording_id: i64, segments: Vec<Segment>) -> Result<(), String> {
        let mut conn = self.get_connection().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        Self::replace_segments(&tx, recording_id, &segments)?;
        mark_text_complete(&tx, recording_id)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn delete_recording(&self, id: i64) -> Result<(), String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        
        // Get file path first
        let path: String = conn.query_row(
            "SELECT file_path FROM recordings WHERE id = ?1",
            params![id],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;

        // Delete from DB (Cascade deletes segments)
        conn.execute("DELETE FROM recordings WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;

        // Delete file
        let file_path = Path::new(&path);
        if file_path.exists() {
            fs::remove_file(file_path).map_err(|e| format!("Failed to delete file: {}", e))?;
        }

        Ok(())
    }

    pub fn update_recording_status(&self, id: i64, status: String, cloud_job_id: Option<String>) -> Result<(), String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;
        
        conn.execute(
            "UPDATE recordings SET sync_status = ?1, cloud_job_id = ?2 WHERE id = ?3",
            params![status, cloud_job_id, id]
        ).map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn save_analysis(&self, id: i64, analysis: String, template: String) -> Result<(), String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;

        conn.execute(
            "UPDATE recordings SET analysis_json = ?1, ai_template_used = ?2 WHERE id = ?3",
            params![analysis, template, id]
        ).map_err(|e| e.to_string())?;

        Ok(())
    }

    /// Persistera molnresultatet (KB-Whisper Large) för en inspelning. De lokala
    /// segmenten lämnas orörda — vyn växlar mellan modellresultaten i frontend.
    pub fn save_cloud_transcript(&self, id: i64, transcript: String) -> Result<(), String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;

        conn.execute(
            "UPDATE recordings SET cloud_transcript = ?1 WHERE id = ?2",
            params![transcript, id]
        ).map_err(|e| e.to_string())?;
        // Texten är sparad. Går märket inte att nollställa ska det inte se ut som att
        // sparandet misslyckades; det rättas vid nästa skrivning.
        if let Err(e) = mark_text_complete(&conn, id) {
            eprintln!("Warning: could not clear interrupted state for recording {}: {}", id, e);
        }

        Ok(())
    }

    /// Persistera strukturerade molnsegment (DU/MÖTET-turer från stereo-omtranskribering)
    /// Används också när talare döps om i molnturerna; då är läget redan nollställt.
    /// Skriver en framtida väg här delvisa molnsegment måste den få en egen metod, annars
    /// märks en ofullständig text som komplett.
    /// som JSON. Lokala segment + `cloud_transcript` lämnas orörda — molnvyn renderar
    /// dessa turer i stället för den flata textblobben (Fas 1c).
    pub fn save_cloud_segments(&self, id: i64, cloud_segments: String) -> Result<(), String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;

        conn.execute(
            "UPDATE recordings SET cloud_segments = ?1 WHERE id = ?2",
            params![cloud_segments, id]
        ).map_err(|e| e.to_string())?;
        // Texten är sparad. Går märket inte att nollställa ska det inte se ut som att
        // sparandet misslyckades; det rättas vid nästa skrivning.
        if let Err(e) = mark_text_complete(&conn, id) {
            eprintln!("Warning: could not clear interrupted state for recording {}: {}", id, e);
        }

        Ok(())
    }

    /// Persistera talaridentifieringen (JSON: namnmappning + deltagarlista) för en
    /// inspelning. Segmenten lämnas orörda — namnen appliceras ovanpå i frontend.
    pub fn save_speaker_map(&self, id: i64, speaker_map: String) -> Result<(), String> {
        let conn = self.get_connection().map_err(|e| e.to_string())?;

        conn.execute(
            "UPDATE recordings SET speaker_map = ?1 WHERE id = ?2",
            params![speaker_map, id]
        ).map_err(|e| e.to_string())?;

        Ok(())
    }

    /// Sökvägen till inspelningskatalogen, för "Öppna mapp" i gränssnittet. Att bara visa
    /// antal byte utan att kunna nå filerna gör det lokala löftet abstrakt — användaren
    /// ska kunna se sina egna inspelningar i Utforskaren.
    pub fn recordings_dir(&self) -> &PathBuf {
        &self.recordings_dir
    }

    /// Summera diskanvändningen: alla filer i recordings-katalogen + databasen
    /// (inkl. ev. -wal/-shm-sidofiler). Endast lokal filsystemåtkomst — offline-säkert.
    pub fn get_storage_usage(&self) -> Result<StorageUsage, String> {
        let mut recordings_bytes: u64 = 0;
        let mut file_count: u32 = 0;

        let entries = fs::read_dir(&self.recordings_dir)
            .map_err(|e| format!("Kunde inte läsa inspelningskatalogen: {}", e))?;
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    recordings_bytes += meta.len();
                    file_count += 1;
                }
            }
        }

        let mut db_bytes: u64 = 0;
        for suffix in ["", "-wal", "-shm"] {
            let mut os_path = self.db_path.clone().into_os_string();
            os_path.push(suffix);
            if let Ok(meta) = fs::metadata(PathBuf::from(os_path)) {
                db_bytes += meta.len();
            }
        }

        Ok(StorageUsage { recordings_bytes, db_bytes, file_count })
    }

    /// Auto-gallring av ljudfiler. Raderar äldsta först, men behåller DB-raden med
    /// segment/transkript/analys och markerar `audio_deleted = 1`.
    ///
    /// Säkerhet:
    /// - Endast filer vars canonicaliserade sökväg ligger i recordings-katalogen raderas
    ///   (samma mönster som read_audio_file i lib.rs). Aktiv sessions WAV ligger i %TEMP%
    ///   tills den sparas och kan därför aldrig träffas.
    /// - `max_age_days` jämför filens mtime (created_at är TEXT — undviker datumparsning).
    /// - `max_total_bytes` raderar äldst-först tills totalen ryms inom kvoten.
    pub fn cleanup_audio(&self, max_age_days: Option<u32>, max_total_bytes: Option<u64>) -> Result<CleanupResult, String> {
        let recordings_dir = fs::canonicalize(&self.recordings_dir)
            .map_err(|e| format!("Kunde inte normalisera inspelningskatalogen: {}", e))?;

        let conn = self.get_connection().map_err(|e| e.to_string())?;
        let mut stmt = conn
            // En inspelning som bearbetas är aldrig en kandidat: den är den nyaste, och ljudet
            // behövs tills transkriberingen är klar.
            .prepare("SELECT id, file_path FROM recordings WHERE audio_deleted = 0 AND processing_state IS NOT 'processing' ORDER BY created_at ASC")
            .map_err(|e| e.to_string())?;
        let rows: Vec<(i64, String)> = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);

        // Kandidater äldst-först: (id, canonicaliserad sökväg, bytes, mtime).
        // Rader vars fil redan saknas reconcilieras direkt till audio_deleted = 1.
        let mut deleted_count: u32 = 0;
        let mut freed_bytes: u64 = 0;
        let mut deleted_ids: Vec<i64> = Vec::new();
        let mut candidates: Vec<(i64, PathBuf, u64, std::time::SystemTime)> = Vec::new();

        for (id, path_str) in rows {
            let Ok(path) = fs::canonicalize(&path_str) else {
                // Filen finns inte längre (eller är oåtkomlig) — markera som gallrad.
                // Räknas inte i deleted_count/freed_bytes (inget frigjordes), men tas med
                // i deleted_ids så UI-badges uppdateras.
                if conn.execute("UPDATE recordings SET audio_deleted = 1 WHERE id = ?1", params![id]).is_ok() {
                    deleted_ids.push(id);
                }
                continue;
            };
            if !path.starts_with(&recordings_dir) {
                continue; // rör aldrig filer utanför recordings-katalogen
            }
            let Ok(meta) = fs::metadata(&path) else { continue };
            let mtime = meta.modified().unwrap_or(std::time::SystemTime::now());
            candidates.push((id, path, meta.len(), mtime));
        }

        let mut total_bytes: u64 = candidates.iter().map(|(_, _, size, _)| size).sum();

        let age_cutoff = max_age_days.map(|days| {
            std::time::SystemTime::now() - std::time::Duration::from_secs(days as u64 * 86_400)
        });

        for (id, path, size, mtime) in candidates {
            let too_old = age_cutoff.map_or(false, |cutoff| mtime < cutoff);
            let over_quota = max_total_bytes.map_or(false, |quota| total_bytes > quota);
            if !too_old && !over_quota {
                if age_cutoff.is_none() {
                    break; // ren kvotgallring: resten är nyare och totalen ryms redan
                }
                continue;
            }

            match fs::remove_file(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => {
                    eprintln!("Warning: kunde inte radera {:?}: {}", path, e);
                    continue; // raden behåller audio_deleted = 0 → nytt försök nästa gallring
                }
            }

            conn.execute("UPDATE recordings SET audio_deleted = 1 WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;
            deleted_count += 1;
            freed_bytes += size;
            deleted_ids.push(id);
            total_bytes = total_bytes.saturating_sub(size);
        }

        Ok(CleanupResult { deleted_count, freed_bytes, deleted_ids })
    }
}


/// En avbruten inspelning som fått ny text för hela sin ljudfil (omtranskriberad i
/// molnet, eller molnströmningens segment) är inte längre ofullständig.
///
/// 🔴 Anropas av VARJE väg som skriver en hel text: `update_recording_segments`,
/// `save_cloud_transcript` och `save_cloud_segments`. Omtranskriberingen i molnet går
/// genom de två senare. Satt nollställningen bara i den första stod "Ofullständig" kvar
/// efter en lyckad omtranskribering.
///
/// Bara `interrupted`: där är ljudet helt och bara transkriberingen avbröts, så en text
/// för hela filen är hela texten. En `recovered` inspelning kan ha klippts av vid en
/// krasch, och märket säger något sant om ljudet även när texten för filen är komplett.
/// En inspelning som fortfarande bearbetas lokalt rörs inte; den sätter själv sitt
/// slutläge.
fn mark_text_complete(conn: &rusqlite::Connection, id: i64) -> Result<(), String> {
    conn.execute(
        "UPDATE recordings SET processing_state = NULL WHERE id = ?1 AND processing_state = 'interrupted'",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Flyttar en fil, även mellan volymer. På samma volym är det ett namnbyte. Annars
/// kopieras filen och originalet tas bort; går det inte att ta bort är flytten ändå
/// gjord, eftersom kopian är komplett. Används åt båda hållen vid sparandet, så att en
/// misslyckad sparning kan lägga tillbaka filen även när temp-katalogen ligger på en
/// annan volym.
fn move_file(from: &Path, to: &Path) -> std::io::Result<()> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    fs::copy(from, to)?;
    if let Err(e) = fs::remove_file(from) {
        eprintln!("Warning: could not delete {:?} after copying it: {}", from, e);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db(name: &str) -> (DatabaseManager, PathBuf) {
        let dir = std::env::temp_dir().join(format!("sagt-db-test-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        (DatabaseManager::new_in(dir.join("data")).unwrap(), dir)
    }

    fn seg(text: &str, start: f64) -> Segment {
        Segment { id: None, recording_id: None, start_time: start, end_time: start + 1.0, text: text.into(), speaker: "DU".into() }
    }

    fn row(dir: &Path, state: Option<&str>) -> Recording {
        let wav = dir.join("session_1760000000000000.wav");
        fs::write(&wav, vec![0u8; 100]).unwrap();
        Recording {
            id: None,
            filename: "recording.wav".into(),
            file_path: wav.to_string_lossy().to_string(),
            duration_sec: 60.0,
            created_at: "2026-10-15T08:00:00Z".into(),
            sync_status: "local".into(),
            cloud_job_id: None,
            analysis_json: None,
            ai_template_used: None,
            cloud_transcript: None,
            cloud_segments: None,
            speaker_map: None,
            audio_deleted: false,
            has_segments: false,
            processing_state: state.map(str::to_string),
        }
    }

    #[test]
    fn rad_vid_stopp_fylls_pa_och_avslutas() {
        let (db, dir) = db("provisional");
        let saved = db.save_recording(row(&dir, Some(processing_state::PROCESSING)), vec![seg("ett", 0.0)]).unwrap();
        let id = saved.id.unwrap();
        // Filen flyttades redan vid Stopp.
        assert!(saved.file_path.contains("recordings"));
        assert!(Path::new(&saved.file_path).exists());
        assert_eq!(db.get_recording(id).unwrap().processing_state.as_deref(), Some("processing"));

        assert!(db.append_processing_segments(id, &[seg("två", 1.0)]).unwrap());
        assert_eq!(db.get_recording_segments(id).unwrap().len(), 2);

        let done = db.finish_processing(id, &[seg("ett", 0.0), seg("två", 1.0), seg("tre", 2.0)], None).unwrap().unwrap();
        assert_eq!(done.processing_state, None);
        assert!(done.has_segments);
        assert_eq!(db.get_recording_segments(id).unwrap().len(), 3);

        // Avslutad: en sen skrivning rör den inte.
        assert!(!db.append_processing_segments(id, &[seg("sen", 3.0)]).unwrap());
        assert!(db.finish_processing(id, &[], None).unwrap().is_none());
        assert_eq!(db.get_recording_segments(id).unwrap().len(), 3);
    }

    #[test]
    fn ny_text_gor_en_avbruten_inspelning_komplett_via_varje_skrivvag() {
        let (db, dir) = db("new-text");
        // Varje väg som skriver en hel text. Omtranskriberingen i molnet går genom de två
        // sista; det var där märket "Ofullständig" stod kvar.
        let vagar: [(&str, &dyn Fn(&DatabaseManager, i64)); 3] = [
            ("lokala segment", &|db, id| db.update_recording_segments(id, vec![seg("hel", 0.0)]).unwrap()),
            ("molntext", &|db, id| db.save_cloud_transcript(id, "hel text".into()).unwrap()),
            ("molnsegment", &|db, id| db.save_cloud_segments(id, "[]".into()).unwrap()),
        ];
        for (vag, skriv) in vagar {
            for (state, efter) in [
                (processing_state::INTERRUPTED, None),
                // Ljudet kan ha klippts av vid en krasch; märket står kvar.
                (processing_state::RECOVERED, Some("recovered")),
                // Den lokala transkriberingen sätter själv slutläget.
                (processing_state::PROCESSING, Some("processing")),
            ] {
                let id = db.save_recording(row(&dir, Some(state)), vec![seg("halv", 0.0)]).unwrap().id.unwrap();
                skriv(&db, id);
                assert_eq!(
                    db.get_recording(id).unwrap().processing_state.as_deref(),
                    efter,
                    "fel läge efter {vag} för en inspelning som var {state}"
                );
            }
        }
    }

    #[test]
    fn flytt_av_fil_lamnar_bara_malet_kvar() {
        let (_db, dir) = db("move");
        let from = dir.join("fran.wav");
        let to = dir.join("till.wav");
        fs::write(&from, b"ljud").unwrap();
        move_file(&from, &to).unwrap();
        assert!(!from.exists());
        assert_eq!(fs::read(&to).unwrap(), b"ljud");
        // En källa som inte finns är ett fel, inte ett tyst lyckat utfall.
        assert!(move_file(&from, &dir.join("annan.wav")).is_err());
    }

    #[test]
    fn raderad_rad_ateruppstar_inte() {
        let (db, dir) = db("deleted");
        let id = db.save_recording(row(&dir, Some(processing_state::PROCESSING)), vec![]).unwrap().id.unwrap();
        db.delete_recording(id).unwrap();
        assert!(!db.append_processing_segments(id, &[seg("sen", 0.0)]).unwrap());
        assert!(db.finish_processing(id, &[seg("sen", 0.0)], None).unwrap().is_none());
        assert!(db.get_all_recordings().unwrap().is_empty());
        assert!(db.get_recording_segments(id).unwrap().is_empty());
    }

    #[test]
    fn misslyckad_sparning_flyttar_tillbaka_filen() {
        // Utan rad hittas filen aldrig i inspelningskatalogen. Den ska ligga kvar där
        // nästa försök och återställningen letar.
        let (db, dir) = db("failed-insert");
        db.get_connection().unwrap().execute("DROP TABLE segments", []).unwrap();
        let rec = row(&dir, Some(processing_state::PROCESSING));
        let temp = PathBuf::from(&rec.file_path);
        assert!(db.save_recording(rec, vec![seg("ett", 0.0)]).is_err());
        assert!(temp.exists(), "filen flyttades men flyttades inte tillbaka");
        assert!(!dir.join("data").join("recordings").join(temp.file_name().unwrap()).exists());
    }

    #[test]
    fn bearbetning_vid_start_blir_avbruten() {
        let (db, dir) = db("interrupted");
        let id = db.save_recording(row(&dir, Some(processing_state::PROCESSING)), vec![]).unwrap().id.unwrap();
        assert_eq!(db.mark_interrupted_processing().unwrap(), 1);
        assert_eq!(db.get_recording(id).unwrap().processing_state.as_deref(), Some("interrupted"));
        assert_eq!(db.mark_interrupted_processing().unwrap(), 0);
    }

    #[test]
    fn gallringen_ror_inte_en_rad_som_bearbetas() {
        let (db, dir) = db("cleanup");
        let processing = db.save_recording(row(&dir, Some(processing_state::PROCESSING)), vec![]).unwrap();
        // Kvot noll: allt som är en kandidat raderas.
        let result = db.cleanup_audio(None, Some(0)).unwrap();
        assert_eq!(result.deleted_count, 0, "raden som bearbetas gallrades");
        assert!(Path::new(&processing.file_path).exists());

        // Negativ kontroll: samma rad, färdig, gallras.
        db.finish_processing(processing.id.unwrap(), &[], None).unwrap();
        let result = db.cleanup_audio(None, Some(0)).unwrap();
        assert_eq!(result.deleted_count, 1);
    }
}
