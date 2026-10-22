//! Inspelningar som aldrig sparades: ljudfiler i temp-katalogen utan rad i databasen.
//!
//! Sessionens ljud skrivs till `session_<mikrosekunder>.wav` i temp-katalogen medan
//! inspelningen pågår, och flyttas till inspelningskatalogen när raden sparas vid Stopp.
//! Ligger en sådan fil kvar när appen startar dog appen innan raden hann sparas: under
//! inspelningen, eller mellan Stopp och sparandet.
//!
//! En fil från en inspelning som aldrig stoppades har ett ofullständigt huvud. Ljudet
//! skrivs löpande, men storleksfälten i huvudet skrivs först när filen avslutas, så de
//! står kvar på sina startvärden. `repair_session_wav` räknar om dem ur filens längd.

use std::fs::OpenOptions;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use crate::database::{DatabaseManager, Recording};

/// Sessionsfilens format: stereo (mikrofon och mötesljud), 16 kHz, 16 bitar.
const CHANNELS: u16 = 2;
const SAMPLE_RATE: u32 = 16_000;
const BITS: u16 = 16;
const BLOCK_ALIGN: u16 = CHANNELS * BITS / 8;

/// Kortare än så här, och utan text, sparas inte (samma gräns som vid Stopp).
pub const MIN_RECOVERED_SEC: f64 = 3.0;

/// Hur nära markörens starttid filens tidsstämpel måste ligga för att vara samma
/// inspelning. Samma gräns som i markören i gränssnittet.
const SAME_RECORDING_MS: u64 = 2_000;

#[derive(Debug)]
pub enum RepairError {
    /// Inte en sessionsfil från appen: fel format eller inget ljudblock. Lämnas orörd.
    NotOurs,
    Io(io::Error),
}

impl From<io::Error> for RepairError {
    fn from(e: io::Error) -> Self {
        RepairError::Io(e)
    }
}

#[derive(Debug, PartialEq)]
pub struct Repaired {
    /// Antal byte ljud efter reparationen, en hel ram i taget.
    pub data_bytes: u64,
    /// Sant om huvudet skrevs om eller en halv ram i slutet kortades bort.
    pub changed: bool,
}

impl Repaired {
    pub fn duration_sec(&self) -> f64 {
        self.data_bytes as f64 / (SAMPLE_RATE as f64 * BLOCK_ALIGN as f64)
    }
}

fn u16_at(b: &[u8], i: usize) -> u16 {
    u16::from_le_bytes([b[i], b[i + 1]])
}

fn u32_at(b: &[u8], i: usize) -> u32 {
    u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]])
}

/// Räknar om storleksfälten i en sessionsfils huvud ur filens faktiska längd, och kortar
/// bort en ofullständig ram i slutet. En fil som redan är hel lämnas orörd.
///
/// Filen måste ha exakt sessionsfilens format. Allt annat ger `NotOurs` och rörs inte:
/// temp-katalogen delas med andra program.
pub fn repair_session_wav(path: &Path) -> Result<Repaired, RepairError> {
    let mut f = OpenOptions::new().read(true).write(true).open(path)?;
    let len = f.metadata()?.len();

    let mut riff = [0u8; 12];
    if len < 12 {
        return Err(RepairError::NotOurs);
    }
    f.read_exact(&mut riff)?;
    if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        return Err(RepairError::NotOurs);
    }
    let riff_size = u32_at(&riff, 4);

    let mut format_ok = false;
    let mut off: u64 = 12;
    loop {
        if off + 8 > len {
            return Err(RepairError::NotOurs);
        }
        f.seek(SeekFrom::Start(off))?;
        let mut head = [0u8; 8];
        f.read_exact(&mut head)?;
        let size = u32_at(&head, 4) as u64;

        if &head[0..4] == b"fmt " {
            if size < 16 || off + 8 + 16 > len {
                return Err(RepairError::NotOurs);
            }
            let mut fmt = [0u8; 16];
            f.read_exact(&mut fmt)?;
            // 1 = PCM, 0xFFFE = utökat format (används av vissa skrivare även för PCM).
            let tag = u16_at(&fmt, 0);
            format_ok = (tag == 1 || tag == 0xFFFE)
                // Antalet kanaler följer av ramstorleken när bitdjupet är 16.
                && u32_at(&fmt, 4) == SAMPLE_RATE
                && u16_at(&fmt, 12) == BLOCK_ALIGN
                && u16_at(&fmt, 14) == BITS;
        } else if &head[0..4] == b"data" {
            if !format_ok {
                return Err(RepairError::NotOurs);
            }
            let data_start = off + 8;
            let available = len - data_start;
            // Storleksfälten är 32 bitar. En sessionsfil når aldrig dit (fyra timmar är
            // under 1 GB), men en fil som gör det kortas hellre än skrivs med fel storlek.
            let max_data = (u32::MAX as u64).saturating_sub(data_start);
            let mut data_bytes = available.min(max_data);
            data_bytes -= data_bytes % BLOCK_ALIGN as u64;

            let want_riff = (data_start + data_bytes - 8) as u32;
            let changed = size != data_bytes || riff_size != want_riff || available != data_bytes;
            if changed {
                if available != data_bytes {
                    f.set_len(data_start + data_bytes)?;
                }
                f.seek(SeekFrom::Start(4))?;
                f.write_all(&want_riff.to_le_bytes())?;
                f.seek(SeekFrom::Start(off + 4))?;
                f.write_all(&(data_bytes as u32).to_le_bytes())?;
                f.sync_all()?;
            }
            return Ok(Repaired { data_bytes, changed });
        }
        // Block har jämn längd; ett udda block följs av en utfyllnadsbyte.
        off += 8 + size + (size & 1);
    }
}

/// Starttiden i millisekunder ur ett sessionsfilnamn, eller `None` om namnet inte är
/// appens. Samma mönster som i markören i gränssnittet.
pub fn session_start_ms(file_name: &str) -> Option<u64> {
    let digits = file_name.strip_prefix("session_")?.strip_suffix(".wav")?;
    if !(10..=17).contains(&digits.len()) || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse::<u64>().ok().map(|micros| micros / 1000)
}

/// Sessionsfilerna i en katalog, äldst först.
pub fn find_session_wavs(dir: &Path) -> Vec<(PathBuf, u64)> {
    let mut found: Vec<(PathBuf, u64)> = match std::fs::read_dir(dir) {
        Ok(entries) => entries
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .filter_map(|e| {
                let name = e.file_name();
                let start = session_start_ms(name.to_str()?)?;
                Some((e.path(), start))
            })
            .collect(),
        Err(_) => Vec::new(),
    };
    found.sort_by_key(|(_, start)| *start);
    found
}

/// Markören som gränssnittet skriver under en inspelning, i den mån den finns kvar.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
pub struct LeftoverMarker {
    pub started_at: u64,
    /// När Stopp trycktes. Saknas om appen dog under inspelningen.
    pub stopped_at: Option<u64>,
}

#[derive(Debug, Default, PartialEq, serde::Serialize)]
pub struct RecoveryReport {
    /// Ljudfiler utan rad som nu har en rad.
    pub recovered: u32,
    /// Sammanlagd längd för dem, i sekunder.
    pub recovered_seconds: f64,
    /// Rader som stod kvar som "bearbetas" från förra körningen.
    pub interrupted: u32,
    /// Ljudfiler som var för korta för att sparas och därför togs bort.
    pub discarded_short: u32,
    /// Sant om en av de återställda filerna hörde till markören.
    pub marker_matched: bool,
    /// Markörens Stopp fanns: användaren hann trycka Stopp innan appen stängdes.
    pub marker_stopped: bool,
}

/// Skapar en rad för en ljudfil som aldrig fick någon, och flyttar filen till
/// inspelningskatalogen. Filens ändringstid sätts till nu, så att den automatiska
/// gallringen inte tar en nyss återställd inspelning för en gammal.
pub fn save_unprocessed_wav(
    db: &DatabaseManager,
    path: &Path,
    start_ms: u64,
    duration_sec: f64,
    state: &str,
) -> Result<Recording, String> {
    let created_at = chrono::DateTime::<chrono::Utc>::from(
        std::time::UNIX_EPOCH + std::time::Duration::from_millis(start_ms),
    )
    .to_rfc3339();
    let recording = Recording {
        id: None,
        filename: "recording.wav".to_string(),
        file_path: path.to_string_lossy().to_string(),
        duration_sec,
        created_at,
        cloud_job_id: None,
        analysis_json: None,
        ai_template_used: None,
        cloud_transcript: None,
        cloud_segments: None,
        sync_status: "local".to_string(),
        audio_deleted: false,
        speaker_map: None,
        has_segments: false,
        processing_state: Some(state.to_string()),
    };
    let saved = db.save_recording(recording, Vec::new())?;
    if let Ok(f) = OpenOptions::new().write(true).open(&saved.file_path) {
        let _ = f.set_modified(std::time::SystemTime::now());
    }
    Ok(saved)
}

/// Ger varje sessionsfil i `temp_dir` en rad. Rör bara filer med appens namn och format.
pub fn recover_session_wavs(
    db: &DatabaseManager,
    temp_dir: &Path,
    marker: Option<LeftoverMarker>,
    report: &mut RecoveryReport,
) {
    for (path, file_start) in find_session_wavs(temp_dir) {
        // En kopia som blev kvar: filen sparades, men temp-filen gick inte att ta bort
        // efter kopieringen (till exempel för att ett annat program hade den öppen).
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or_default();
        if db.has_recording_named(name).unwrap_or(false) {
            if let Err(e) = std::fs::remove_file(&path) {
                eprintln!("RECOVERY: kunde inte ta bort kvarlämnad kopia {:?}: {}", path, e);
            }
            continue;
        }
        let repaired = match repair_session_wav(&path) {
            Ok(r) => r,
            Err(RepairError::NotOurs) => {
                eprintln!("RECOVERY: {:?} har inte inspelningens format, lämnas orörd", path);
                continue;
            }
            Err(RepairError::Io(e)) => {
                eprintln!("RECOVERY: kunde inte läsa {:?}: {}", path, e);
                continue;
            }
        };
        let duration = repaired.duration_sec();
        if duration < MIN_RECOVERED_SEC {
            match std::fs::remove_file(&path) {
                Ok(()) => report.discarded_short += 1,
                Err(e) => eprintln!("RECOVERY: kunde inte ta bort kort fil {:?}: {}", path, e),
            }
            continue;
        }
        let matched = marker.filter(|m| m.started_at.abs_diff(file_start) <= SAME_RECORDING_MS);
        let start_ms = matched.map(|m| m.started_at).unwrap_or(file_start);
        match save_unprocessed_wav(
            db,
            &path,
            start_ms,
            duration,
            crate::database::processing_state::RECOVERED,
        ) {
            Ok(_) => {
                println!(
                    "RECOVERY: återställde {:?} ({:.0} s, huvud {})",
                    path,
                    duration,
                    if repaired.changed { "reparerat" } else { "helt" }
                );
                report.recovered += 1;
                report.recovered_seconds += duration;
                if let Some(m) = matched {
                    report.marker_matched = true;
                    report.marker_stopped = m.stopped_at.is_some();
                }
            }
            Err(e) => eprintln!("RECOVERY: kunde inte spara {:?}: {}", path, e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> hound::WavSpec {
        hound::WavSpec {
            channels: CHANNELS,
            sample_rate: SAMPLE_RATE,
            bits_per_sample: BITS,
            sample_format: hound::SampleFormat::Int,
        }
    }

    fn tmp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "sagt-recovery-test-{}-{}",
            name,
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// Skriver `frames` stereoramar och dör sedan utan att avsluta filen, som appen
    /// gör när den stängs mitt i en inspelning. `forget` hoppar över både avslutningen
    /// och tömningen av skrivbufferten, så slutet av ljudet kan saknas, precis som vid
    /// en krasch. Returnerar antalet hela ramar som nådde disken.
    ///
    /// Skrivaren glöms på en egen fil som sedan kopieras: dess filhandtag lever kvar till
    /// processens slut, och på Windows kan en fil med ett öppet handtag finnas kvar
    /// efter att den tagits bort.
    fn write_unfinished(path: &Path, frames: u32) -> u64 {
        let source = path.with_extension("src");
        let mut w = hound::WavWriter::create(&source, spec()).unwrap();
        for i in 0..frames {
            w.write_sample((i % 1000) as i16).unwrap();
            w.write_sample(-((i % 1000) as i16)).unwrap();
        }
        std::mem::forget(w);
        std::fs::copy(&source, path).unwrap();
        (std::fs::metadata(path).unwrap().len() - 44) / 4
    }

    fn read_frames(path: &Path) -> u32 {
        hound::WavReader::open(path).unwrap().duration()
    }

    #[test]
    fn hounds_huvud_star_pa_startvarden_tills_filen_avslutas() {
        // Det reparationen bygger på, mätt i stället för antaget: en fil som skrivs utan
        // flush och aldrig avslutas har ett huvud som säger att den saknar ljud.
        let dir = tmp_dir("placeholder");
        let p = dir.join("session_1760000000000000.wav");
        let mut w = hound::WavWriter::create(&p, spec()).unwrap();
        for _ in 0..(SAMPLE_RATE * 2) {
            w.write_sample(1i16).unwrap();
            w.write_sample(1i16).unwrap();
        }
        // Skrivaren buffrar; en krasch tappar bufferten men inte det som nått disken.
        // `forget` hoppar över både avslutningen och tömningen av bufferten.
        std::mem::forget(w);
        let bytes = std::fs::read(&p).unwrap();
        let data_size = u32_at(&bytes, 40);
        assert!(bytes.len() > 44, "inget ljud nådde disken alls ({} byte)", bytes.len());
        assert_ne!(data_size as usize, bytes.len() - 44, "huvudet stämde redan: testet mäter inget");
        // Och läsaren litar på huvudet, så filen ser tom eller trasig ut.
        let read = hound::WavReader::open(&p).map(|r| r.duration()).unwrap_or(0);
        assert!(read < SAMPLE_RATE, "läsaren såg {} ramar trots trasigt huvud", read);
    }

    #[test]
    fn ofullstandig_fil_far_ratt_langd() {
        let dir = tmp_dir("repair");
        let p = dir.join("session_1760000000000000.wav");
        let mut w = hound::WavWriter::create(&p, spec()).unwrap();
        for _ in 0..(SAMPLE_RATE * 5) {
            w.write_sample(7i16).unwrap();
            w.write_sample(-7i16).unwrap();
        }
        std::mem::forget(w);
        let before = std::fs::read(&p).unwrap().len() as u64;
        let r = repair_session_wav(&p).unwrap();
        assert!(r.changed);
        assert_eq!(r.data_bytes, before - 44);
        // Läsaren ser nu exakt de ramar som nådde disken.
        assert_eq!(read_frames(&p) as u64, (before - 44) / 4);
        // En gång till: filen är hel och lämnas orörd.
        assert!(!repair_session_wav(&p).unwrap().changed);
    }

    #[test]
    fn halv_ram_i_slutet_kortas_bort() {
        let dir = tmp_dir("halfframe");
        let p = dir.join("session_1760000000000000.wav");
        let on_disk = write_unfinished(&p, SAMPLE_RATE);
        // Tre byte till: en ofullständig ram, som när processen dör mitt i en skrivning.
        std::fs::OpenOptions::new().append(true).open(&p).unwrap().write_all(&[1, 2, 3]).unwrap();
        let r = repair_session_wav(&p).unwrap();
        assert_eq!(r.data_bytes, on_disk * 4);
        assert_eq!(std::fs::metadata(&p).unwrap().len(), 44 + on_disk * 4);
        assert_eq!(read_frames(&p) as u64, on_disk);
    }

    #[test]
    fn hel_fil_rors_inte() {
        let dir = tmp_dir("whole");
        let p = dir.join("session_1760000000000000.wav");
        let mut w = hound::WavWriter::create(&p, spec()).unwrap();
        for _ in 0..800 {
            w.write_sample(3i16).unwrap();
            w.write_sample(3i16).unwrap();
        }
        w.finalize().unwrap();
        let before = std::fs::read(&p).unwrap();
        let r = repair_session_wav(&p).unwrap();
        assert!(!r.changed);
        assert_eq!(r.data_bytes, 3200);
        assert_eq!(std::fs::read(&p).unwrap(), before);
    }

    #[test]
    fn annat_format_rors_inte() {
        // Temp-katalogen delas med andra program. En fil med appens namn men ett annat
        // format får varken repareras eller flyttas.
        let dir = tmp_dir("foreign");
        let p = dir.join("session_1760000000000000.wav");
        let mono = hound::WavSpec { channels: 1, ..spec() };
        let mut w = hound::WavWriter::create(&p, mono).unwrap();
        for _ in 0..(SAMPLE_RATE * 5) {
            w.write_sample(1i16).unwrap();
        }
        std::mem::forget(w);
        let before = std::fs::read(&p).unwrap();
        assert!(matches!(repair_session_wav(&p), Err(RepairError::NotOurs)));
        assert_eq!(std::fs::read(&p).unwrap(), before);

        let q = dir.join("session_1760000000000001.wav");
        std::fs::write(&q, b"inte en ljudfil alls, bara text").unwrap();
        assert!(matches!(repair_session_wav(&q), Err(RepairError::NotOurs)));
    }

    #[test]
    fn filnamnet_ger_starttiden() {
        assert_eq!(session_start_ms("session_1760000000123456.wav"), Some(1_760_000_000_123));
        assert_eq!(session_start_ms("session_.wav"), None);
        assert_eq!(session_start_ms("session_12ab.wav"), None);
        assert_eq!(session_start_ms("session_1760000000123456.wav.tmp"), None);
        assert_eq!(session_start_ms("chunk_1760000000123456.wav"), None);
        assert_eq!(session_start_ms("session_123.wav"), None);
    }

    fn db_in(dir: &Path) -> DatabaseManager {
        DatabaseManager::new_in(dir.join("data")).unwrap()
    }

    #[test]
    fn aterstallning_ger_rad_och_flyttar_filen() {
        let dir = tmp_dir("recover");
        let temp = dir.join("temp");
        std::fs::create_dir_all(&temp).unwrap();
        let db = db_in(&dir);

        let long = temp.join("session_1760000000000000.wav");
        let long_frames = write_unfinished(&long, SAMPLE_RATE * 10);
        assert!(long_frames > SAMPLE_RATE as u64 * 9, "för lite ljud nådde disken: {}", long_frames);
        let short = temp.join("session_1760000100000000.wav");
        write_unfinished(&short, SAMPLE_RATE);
        let foreign = temp.join("session_1760000200000000.wav");
        std::fs::write(&foreign, b"annat program").unwrap();
        let unrelated = temp.join("other.wav");
        std::fs::write(&unrelated, b"x").unwrap();

        let marker = LeftoverMarker { started_at: 1_760_000_000_400, stopped_at: Some(1_760_000_010_000) };
        let mut report = RecoveryReport::default();
        recover_session_wavs(&db, &temp, Some(marker), &mut report);

        assert_eq!(report.recovered, 1);
        assert_eq!(report.discarded_short, 1);
        assert!(report.marker_matched);
        assert!(report.marker_stopped);
        assert_eq!(report.recovered_seconds, long_frames as f64 / SAMPLE_RATE as f64);

        let rows = db.get_all_recordings().unwrap();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.processing_state.as_deref(), Some("recovered"));
        assert!(!row.has_segments);
        assert!(row.created_at.starts_with("2025-10-09T08:53:20.4"), "{}", row.created_at);
        assert!(Path::new(&row.file_path).exists());
        assert!(!long.exists() && !short.exists());
        assert!(foreign.exists() && unrelated.exists(), "främmande filer rördes");
        assert_eq!(read_frames(Path::new(&row.file_path)) as u64, long_frames);

        // En kvarlämnad kopia av en sparad inspelning blir ingen dubblett.
        std::fs::copy(&row.file_path, &long).unwrap();
        let mut copy = RecoveryReport::default();
        recover_session_wavs(&db, &temp, None, &mut copy);
        assert_eq!(copy.recovered, 0);
        assert!(!long.exists(), "kopian låg kvar");

        // En andra körning hittar inget nytt.
        let mut again = RecoveryReport::default();
        recover_session_wavs(&db, &temp, None, &mut again);
        assert_eq!(again.recovered, 0);
        assert_eq!(db.get_all_recordings().unwrap().len(), 1);
    }
}
