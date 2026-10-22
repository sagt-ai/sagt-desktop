//! Läsning av möten ur appens lokala databas för MCP-verktygen.
//!
//! Anslutningen öppnas skrivskyddad och med väntetid, eftersom appen kan skriva i
//! samma databas medan en inspelning sparas. Inget här returnerar ljudfilens sökväg
//! eller läser ljudet: MCP når bara text.

use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Så länge en läsning väntar på att appen ska skriva klart.
const BUSY_TIMEOUT: Duration = Duration::from_secs(5);
pub const DEFAULT_TURNS: usize = 120;
pub const MAX_TURNS: usize = 400;
const SNIPPET_CHARS: usize = 220;

#[derive(Debug)]
pub enum StoreError {
    /// Databasen saknas: appen har inte spelat in något på den här datorn.
    NoDatabase,
    NotFound(i64),
    Sql(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::NoDatabase => write!(f, "Det finns inga möten i Sagt på den här datorn ännu."),
            StoreError::NotFound(id) => write!(f, "Inget möte med id {id} finns i Sagt. Använd sagt_list_meetings eller sagt_search_meetings för att hitta rätt id."),
            StoreError::Sql(_) => write!(f, "Sagt kunde inte läsa mötena just nu. Försök igen om en stund."),
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(e: rusqlite::Error) -> Self {
        StoreError::Sql(e.to_string())
    }
}

pub type StoreResult<T> = Result<T, StoreError>;

pub struct Store {
    path: PathBuf,
    /// Tidszonen för titlar och datumfilter. None = datorns lokala tid (appen); tester låser den.
    tz: Option<chrono::FixedOffset>,
}

/// Ett möte som raden i databasen, utan ljudets sökväg.
struct Row {
    id: i64,
    filename: String,
    created_at: String,
    duration_sec: f64,
    analysis_json: Option<String>,
    template: Option<String>,
    cloud_transcript: Option<String>,
    cloud_segments: Option<String>,
    speaker_map: Option<String>,
    /// `processing_state`: `None` för ett färdigt möte. Saknas kolumnen (en databas som
    /// appen inte hunnit uppdatera) läses den som `None`.
    state: Option<String>,
}

/// Om mötets text är komplett, och i så fall varför inte. Assistenten ska inte
/// sammanfatta ett möte vars slut kan saknas som om det vore helt.
fn completeness(state: Option<&str>) -> (bool, Option<&'static str>) {
    match state {
        None => (true, None),
        Some("processing") => (false, Some("Mötet transkriberas fortfarande. Slutet av texten kan saknas.")),
        Some("interrupted") => (false, Some("Transkriberingen avbröts. Slutet av texten kan saknas.")),
        Some("recovered") => (false, Some("Inspelningen återställdes efter att appen stängts. Ljudet kan sluta innan mötet gjorde det.")),
        Some(_) => (false, Some("Mötets text är inte komplett.")),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Turn {
    pub speaker: String,
    pub start: f64,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Protocol {
    pub summary: String,
    pub decisions: Vec<String>,
    pub actions: Vec<String>,
    pub template: Option<String>,
}

pub fn meeting_url(id: i64) -> String {
    format!("sagt://meeting/{id}")
}

const MONTHS: [&str; 12] = ["jan", "feb", "mars", "apr", "maj", "juni", "juli", "aug", "sep", "okt", "nov", "dec"];

/// Mötets titel för assistenten. Appen namnger inspelningar automatiskt (`session_<tid>.wav`),
/// och ett sådant filnamn säger ingenting: då blir titeln "Möte 6 okt 2026, 22:15" i lokal tid.
/// Ett annat namn behålls, utan filändelse, med tiden efter.
fn title_at(filename: &str, created_at: &str, local: Option<chrono::DateTime<chrono::FixedOffset>>) -> String {
    use chrono::{Datelike, Timelike};
    let when = match local {
        Some(t) => format!("{} {} {}, {:02}:{:02}", t.day(), MONTHS[t.month0() as usize], t.year(), t.hour(), t.minute()),
        None => created_at.get(..16).unwrap_or(created_at).replace('T', " "),
    };
    let stem = filename.rsplit_once('.').map(|(s, _)| s).unwrap_or(filename);
    let auto = stem.strip_prefix("session_").map_or(false, |rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()));
    if auto || stem.trim().is_empty() {
        format!("Möte {when}")
    } else {
        format!("{} ({when})", stem.trim())
    }
}

/// Mötets datum i samma tidszon som titeln. Datumfiltren jämför mot det, så att ett möte
/// 00:30 den 2 okt (22:30 UTC den 1 okt) hittas med from=2026-10-02.
fn date_in(created_at: &str, local: Option<chrono::DateTime<chrono::FixedOffset>>) -> String {
    match local {
        Some(t) => t.format("%Y-%m-%d").to_string(),
        None => created_at.get(..10).unwrap_or(created_at).to_string(),
    }
}

/// Kanonisk talare: kanalnamnen från ljudvägen blir Du/Mötet-nycklarna.
fn speaker_key(raw: &str) -> String {
    match raw {
        "mic" | "DU" => "DU".to_string(),
        "sys" | "MÖTET" => "MÖTET".to_string(),
        other => other.to_string(),
    }
}

/// Namnen användaren gett talarna. Två former finns: `{map: {...}, ...}` och en platt karta.
fn speaker_names(raw: Option<&str>) -> HashMap<String, String> {
    let v: Value = match raw.and_then(|r| serde_json::from_str(r).ok()) {
        Some(v) => v,
        None => return HashMap::new(),
    };
    let map = v.get("map").unwrap_or(&v);
    map.as_object()
        .map(|o| {
            o.iter()
                .filter_map(|(k, v)| v.as_str().filter(|s| !s.trim().is_empty()).map(|s| (speaker_key(k), s.trim().to_string())))
                .collect()
        })
        .unwrap_or_default()
}

fn speaker_label(raw: &str, names: &HashMap<String, String>) -> String {
    let key = speaker_key(raw);
    if let Some(n) = names.get(&key) {
        return n.clone();
    }
    match key.as_str() {
        "DU" => "Du".to_string(),
        "MÖTET" => "Mötet".to_string(),
        _ => key,
    }
}

/// Protokollet ur `analysis_json`. Både appens form (decisions/actions) och den äldre
/// (key_decisions/action_items) förekommer.
pub fn parse_protocol(raw: Option<&str>, template: Option<&str>) -> Option<Protocol> {
    let v: Value = serde_json::from_str(raw?).ok()?;
    let list = |a: &str, b: &str| -> Vec<String> {
        v.get(a)
            .or_else(|| v.get(b))
            .and_then(|x| x.as_array())
            .map(|xs| xs.iter().filter_map(|x| x.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect())
            .unwrap_or_default()
    };
    let summary = v.get("summary").and_then(|s| s.as_str()).unwrap_or("").trim().to_string();
    let p = Protocol {
        summary,
        decisions: list("decisions", "key_decisions"),
        actions: list("actions", "action_items"),
        template: v.get("template_used").and_then(|t| t.as_str()).map(String::from).or_else(|| template.map(String::from)),
    };
    if p.summary.is_empty() && p.decisions.is_empty() && p.actions.is_empty() {
        return None;
    }
    Some(p)
}

/// Sammanhängande turer: segment i rad från samma talare slås ihop.
fn merge_turns(segments: Vec<(String, f64, String)>, names: &HashMap<String, String>) -> Vec<Turn> {
    let mut out: Vec<Turn> = Vec::new();
    for (speaker, start, text) in segments {
        let text = text.trim();
        if text.is_empty() || speaker == "MOLN" {
            continue;
        }
        let label = speaker_label(&speaker, names);
        match out.last_mut() {
            Some(t) if t.speaker == label => {
                t.text.push(' ');
                t.text.push_str(text);
            }
            _ => out.push(Turn { speaker: label, start, text: text.to_string() }),
        }
    }
    out
}

fn lower(s: &str) -> String {
    s.to_lowercase()
}

/// Ett utdrag runt första träffen, kapat på teckengränser.
fn snippet(text: &str, needle_lower: &str) -> String {
    let hay = lower(text);
    let chars: Vec<char> = text.chars().collect();
    let hay_chars: Vec<char> = hay.chars().collect();
    // to_lowercase kan ändra antalet tecken; faller tillbaka på början om positionen inte går att mappa.
    let pos = if hay_chars.len() == chars.len() {
        hay.find(needle_lower).map(|b| hay[..b].chars().count()).unwrap_or(0)
    } else {
        0
    };
    let start = pos.saturating_sub(SNIPPET_CHARS / 3);
    let end = (start + SNIPPET_CHARS).min(chars.len());
    let mut s: String = chars[start..end].iter().collect();
    if start > 0 {
        s = format!("…{s}");
    }
    if end < chars.len() {
        s.push('…');
    }
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

impl Store {
    pub fn new(path: PathBuf) -> Self {
        Store { path, tz: None }
    }

    #[cfg(test)]
    pub fn with_tz(mut self, tz: chrono::FixedOffset) -> Self {
        self.tz = Some(tz);
        self
    }

    /// Tidpunkten i den tidszon titlar och filter använder, eller None om den inte går att läsa.
    fn local(&self, created_at: &str) -> Option<chrono::DateTime<chrono::FixedOffset>> {
        let t = chrono::DateTime::parse_from_rfc3339(created_at).ok()?;
        Some(match self.tz {
            Some(tz) => t.with_timezone(&tz),
            None => t.with_timezone(&chrono::Local).fixed_offset(),
        })
    }

    fn title(&self, filename: &str, created_at: &str) -> String {
        title_at(filename, created_at, self.local(created_at))
    }

    fn in_range(&self, created_at: &str, from: Option<&str>, to: Option<&str>) -> bool {
        let d = date_in(created_at, self.local(created_at));
        from.map_or(true, |f| d.as_str() >= f) && to.map_or(true, |t| d.as_str() <= t)
    }

    pub fn in_dir(dir: &Path) -> Self {
        Store::new(dir.join(super::session::DB_FILE))
    }

    fn conn(&self) -> StoreResult<Connection> {
        if !self.path.exists() {
            return Err(StoreError::NoDatabase);
        }
        let c = Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)?;
        c.busy_timeout(BUSY_TIMEOUT)?;
        Ok(c)
    }

    const COLUMNS: &'static str = "id, filename, created_at, duration_sec, analysis_json, ai_template_used, cloud_transcript, cloud_segments, speaker_map";

    /// Kolumnlistan, med `processing_state` om databasen har den och annars `NULL`.
    /// MCP-läget är samma program som appen men kan köras innan appen startat efter en
    /// uppdatering, och då har databasen ännu inte fått kolumnen.
    fn columns(c: &Connection) -> StoreResult<String> {
        let has_state: bool = c.query_row(
            "SELECT COUNT(*) > 0 FROM pragma_table_info('recordings') WHERE name = 'processing_state'",
            [],
            |r| r.get(0),
        )?;
        Ok(format!("{}, {}", Self::COLUMNS, if has_state { "processing_state" } else { "NULL" }))
    }

    fn map_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
        Ok(Row {
            id: r.get(0)?,
            filename: r.get(1)?,
            created_at: r.get(2)?,
            duration_sec: r.get(3)?,
            analysis_json: r.get(4)?,
            template: r.get(5)?,
            cloud_transcript: r.get(6)?,
            cloud_segments: r.get(7)?,
            speaker_map: r.get(8)?,
            state: r.get(9)?,
        })
    }

    /// Möten för listning och sökning. Ett möte som fortfarande transkriberas tas inte
    /// med: dess text växer ännu, och en sammanfattning av halva mötet vore missvisande.
    /// Det går fortfarande att läsa med sitt id, märkt som ofullständigt.
    fn rows(&self, c: &Connection) -> StoreResult<Vec<Row>> {
        let mut st = c.prepare(&format!("SELECT {} FROM recordings ORDER BY created_at DESC, id DESC", Self::columns(c)?))?;
        let rows = st.query_map([], Self::map_row)?.collect::<Result<Vec<_>, _>>()?;
        Ok(rows.into_iter().filter(|r| r.state.as_deref() != Some("processing")).collect())
    }

    fn row(&self, c: &Connection, id: i64) -> StoreResult<Row> {
        c.query_row(&format!("SELECT {} FROM recordings WHERE id = ?1", Self::columns(c)?), [id], Self::map_row)
            .optional()?
            .ok_or(StoreError::NotFound(id))
    }

    fn local_segments(c: &Connection, id: i64) -> StoreResult<Vec<(String, f64, String)>> {
        let mut st = c.prepare("SELECT speaker, start_time, text FROM segments WHERE recording_id = ?1 ORDER BY start_time, id")?;
        let v = st.query_map([id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?.collect::<Result<Vec<_>, _>>()?;
        Ok(v)
    }

    /// Turerna för ett möte och vilken text de kommer från. Molnsegment (bättre modell)
    /// går före den lokala texten när de finns, som i appens visning.
    fn turns_for(c: &Connection, row: &Row) -> StoreResult<(Vec<Turn>, &'static str)> {
        let names = speaker_names(row.speaker_map.as_deref());
        if let Some(cs) = row.cloud_segments.as_deref().filter(|s| !s.trim().is_empty()) {
            if let Ok(Value::Array(items)) = serde_json::from_str::<Value>(cs) {
                let segs: Vec<(String, f64, String)> = items
                    .iter()
                    .map(|s| {
                        (
                            s.get("speaker").and_then(|x| x.as_str()).unwrap_or("MÖTET").to_string(),
                            s.get("start_time").and_then(|x| x.as_f64()).unwrap_or(0.0),
                            s.get("text").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                        )
                    })
                    .collect();
                let turns = merge_turns(segs, &names);
                if !turns.is_empty() {
                    return Ok((turns, "cloud"));
                }
            }
        }
        let local = merge_turns(Self::local_segments(c, row.id)?, &names);
        if !local.is_empty() {
            return Ok((local, "local"));
        }
        if let Some(t) = row.cloud_transcript.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
            return Ok((vec![Turn { speaker: "Mötet".into(), start: 0.0, text: t.to_string() }], "cloud_text"));
        }
        Ok((Vec::new(), "none"))
    }

    fn word_count(turns: &[Turn]) -> usize {
        turns.iter().map(|t| t.text.split_whitespace().count()).sum()
    }

    pub fn list_meetings(&self, limit: usize, offset: usize, from: Option<&str>, to: Option<&str>) -> StoreResult<Value> {
        let c = self.conn()?;
        let rows: Vec<Row> = self.rows(&c)?.into_iter().filter(|r| self.in_range(&r.created_at, from, to)).collect();
        let total = rows.len();
        let mut items = Vec::new();
        for r in rows.into_iter().skip(offset).take(limit) {
            let (turns, source) = Self::turns_for(&c, &r)?;
            items.push(json!({
                "id": r.id.to_string(),
                "title": self.title(&r.filename, &r.created_at),
                "url": meeting_url(r.id),
                "date": r.created_at,
                "duration_minutes": (r.duration_sec / 60.0).round() as i64,
                "word_count": Self::word_count(&turns),
                "transcript_source": source,
                "complete": completeness(r.state.as_deref()).0,
                "has_protocol": parse_protocol(r.analysis_json.as_deref(), r.template.as_deref()).is_some(),
            }));
        }
        let shown = items.len();
        Ok(json!({ "meetings": items, "total": total, "offset": offset, "remaining": total.saturating_sub(offset + shown) }))
    }

    /// Ordsökning i transkript och protokoll, utan hänsyn till stora och små bokstäver
    /// (även å, ä och ö). Rangordnas på antal olika sökord som träffar, sedan antal träffar.
    pub fn search(&self, query: &str, limit: usize) -> StoreResult<Value> {
        let words: Vec<String> = lower(query).split_whitespace().filter(|w| w.chars().count() >= 2).map(String::from).collect();
        let c = self.conn()?;
        let mut scored: Vec<(usize, usize, Value)> = Vec::new();
        for r in self.rows(&c)? {
            let (turns, _) = Self::turns_for(&c, &r)?;
            let mut text: String = turns.iter().map(|t| t.text.as_str()).collect::<Vec<_>>().join(" ");
            if let Some(p) = parse_protocol(r.analysis_json.as_deref(), r.template.as_deref()) {
                text.push(' ');
                text.push_str(&p.summary);
                for x in p.decisions.iter().chain(p.actions.iter()) {
                    text.push(' ');
                    text.push_str(x);
                }
            }
            let hay = lower(&text);
            let mut distinct = 0;
            let mut hits = 0;
            let mut first: Option<&str> = None;
            for w in &words {
                let n = hay.matches(w.as_str()).count();
                if n > 0 {
                    distinct += 1;
                    hits += n;
                    first.get_or_insert(w.as_str());
                }
            }
            if distinct == 0 {
                continue;
            }
            scored.push((distinct, hits, json!({
                "id": r.id.to_string(),
                "title": self.title(&r.filename, &r.created_at),
                "url": meeting_url(r.id),
                "date": r.created_at,
                "snippet": snippet(&text, first.unwrap_or("")),
                "matches": hits,
            })));
        }
        scored.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
        let results: Vec<Value> = scored.into_iter().take(limit).map(|s| s.2).collect();
        Ok(json!({ "results": results, "query": query }))
    }

    pub fn get_transcript(&self, id: i64, offset: usize, limit: usize, as_text: bool) -> StoreResult<Value> {
        let c = self.conn()?;
        let r = self.row(&c, id)?;
        let (turns, source) = Self::turns_for(&c, &r)?;
        let total = turns.len();
        let page: Vec<&Turn> = turns.iter().skip(offset).take(limit).collect();
        let text = page.iter().map(|t| format!("{}: {}", t.speaker, t.text)).collect::<Vec<_>>().join("\n");
        let mut out = json!({
            "id": r.id.to_string(),
            "title": self.title(&r.filename, &r.created_at),
            "url": meeting_url(r.id),
            "text": text,
            "metadata": {
                "date": r.created_at,
                "duration_minutes": (r.duration_sec / 60.0).round() as i64,
                "transcript_source": source,
                "total_turns": total,
                "offset": offset,
                "remaining_turns": total.saturating_sub(offset + page.len()),
            },
        });
        let (complete, note) = completeness(r.state.as_deref());
        out["metadata"]["complete"] = json!(complete);
        if let Some(note) = note {
            out["metadata"]["note"] = json!(note);
        }
        if !as_text {
            out["turns"] = Value::Array(page.iter().map(|t| json!({"speaker": t.speaker, "start_seconds": t.start.round() as i64, "text": t.text})).collect());
        }
        Ok(out)
    }

    pub fn get_protocol(&self, id: i64) -> StoreResult<Value> {
        let c = self.conn()?;
        let r = self.row(&c, id)?;
        let base = json!({"id": r.id.to_string(), "title": self.title(&r.filename, &r.created_at), "url": meeting_url(r.id), "date": r.created_at, "complete": completeness(r.state.as_deref()).0});
        Ok(match parse_protocol(r.analysis_json.as_deref(), r.template.as_deref()) {
            Some(p) => {
                let mut v = base;
                v["protocol"] = json!({"summary": p.summary, "decisions": p.decisions, "action_items": p.actions, "template": p.template});
                v
            }
            None => {
                let mut v = base;
                v["protocol"] = Value::Null;
                v["note"] = json!("Mötet har inget protokoll. Skapa ett i Sagt, eller läs transkriptet med sagt_get_transcript.");
                v
            }
        })
    }

    pub fn list_action_items(&self, from: Option<&str>, to: Option<&str>, limit: usize) -> StoreResult<Value> {
        let c = self.conn()?;
        let mut items = Vec::new();
        let mut meetings = 0;
        for r in self.rows(&c)?.into_iter().filter(|r| self.in_range(&r.created_at, from, to)) {
            if let Some(p) = parse_protocol(r.analysis_json.as_deref(), r.template.as_deref()) {
                if !p.actions.is_empty() {
                    meetings += 1;
                }
                for a in p.actions {
                    items.push(json!({"action": a, "meeting_id": r.id.to_string(), "meeting_title": self.title(&r.filename, &r.created_at), "date": r.created_at, "url": meeting_url(r.id), "meeting_complete": completeness(r.state.as_deref()).0}));
                }
            }
        }
        let total = items.len();
        items.truncate(limit);
        Ok(json!({"action_items": items, "total": total, "meetings_with_actions": meetings}))
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// En databas med samma schema som appens, i en egen katalog.
    pub fn fixture(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sagt-mcp-store-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let c = Connection::open(dir.join(super::super::session::DB_FILE)).unwrap();
        c.execute_batch(
            "CREATE TABLE recordings (id INTEGER PRIMARY KEY, filename TEXT NOT NULL, file_path TEXT NOT NULL,
               duration_sec REAL NOT NULL, created_at TEXT NOT NULL, sync_status TEXT DEFAULT 'local', cloud_job_id TEXT,
               analysis_json TEXT, ai_template_used TEXT, cloud_transcript TEXT, audio_deleted INTEGER NOT NULL DEFAULT 0,
               speaker_map TEXT, cloud_segments TEXT);
             CREATE TABLE segments (id INTEGER PRIMARY KEY, recording_id INTEGER NOT NULL, start_time REAL NOT NULL,
               end_time REAL NOT NULL, text TEXT NOT NULL, speaker TEXT NOT NULL);
             INSERT INTO recordings (id, filename, file_path, duration_sec, created_at, analysis_json, speaker_map) VALUES
               (1, 'Styrelsemöte', '/hemlig/sokvag/ljud-1.wav', 3600, '2026-10-01T09:00:00+02:00',
                '{\"summary\":\"Budgeten för Ängelholm godkändes.\",\"decisions\":[\"Godkänn budget\"],\"actions\":[\"Anna skickar protokollet\",\"Erik bokar lokal\"]}',
                '{\"map\":{\"DU\":\"Anna\"},\"participants\":[],\"auto\":[]}'),
               (2, 'Kundmöte', '/hemlig/sokvag/ljud-2.wav', 1800, '2026-10-05T14:00:00+02:00',
                '{\"summary\":\"Kunden vill ha offert.\",\"key_decisions\":[],\"action_items\":[\"Skicka offert\"]}', NULL),
               (3, 'Tomt', '/hemlig/sokvag/ljud-3.wav', 10, '2026-10-06T08:00:00+02:00', NULL, NULL);
             UPDATE recordings SET cloud_segments = '[{\"start_time\":0,\"end_time\":2,\"text\":\"Molntext om offerten\",\"speaker\":\"MÖTET\"}]' WHERE id = 2;
             INSERT INTO segments (recording_id, start_time, end_time, text, speaker) VALUES
               (1, 0, 2, 'Välkomna till mötet.', 'mic'),
               (1, 2, 4, 'Vi tittar på budgeten.', 'DU'),
               (1, 4, 6, 'ÄNGELHOLM behöver mer pengar.', 'sys'),
               (2, 0, 2, 'Lokal text som inte ska visas', 'sys');",
        )
        .unwrap();
        dir
    }

    /// Fixturen med kolumnen `processing_state`, som appen lägger till: möte 1 transkriberas
    /// fortfarande och möte 2 avbröts.
    fn store_with_state(name: &str) -> Store {
        let dir = fixture(name);
        let c = Connection::open(dir.join(super::super::session::DB_FILE)).unwrap();
        c.execute_batch(
            "ALTER TABLE recordings ADD COLUMN processing_state TEXT;
             UPDATE recordings SET processing_state = 'processing' WHERE id = 1;
             UPDATE recordings SET processing_state = 'interrupted' WHERE id = 2;",
        )
        .unwrap();
        Store::in_dir(&dir).with_tz(chrono::FixedOffset::east_opt(2 * 3600).unwrap())
    }

    #[test]
    fn meeting_still_transcribing_is_left_out_of_list_and_search() {
        let s = store_with_state("processing");
        let v = s.list_meetings(10, 0, None, None).unwrap();
        let ids: Vec<&str> = v["meetings"].as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["3", "2"], "ett möte som transkriberas fortfarande syntes i listan");
        // Ordet finns bara i möte 1.
        let r = s.search("Ängelholm", 10).unwrap();
        assert!(r["results"].as_array().unwrap().is_empty(), "ett möte som transkriberas fortfarande gav träff");
    }

    #[test]
    fn incomplete_meetings_are_marked_as_such() {
        let s = store_with_state("incomplete");
        let v = s.list_meetings(10, 0, None, None).unwrap();
        let m: Vec<(&str, bool)> = v["meetings"].as_array().unwrap().iter()
            .map(|m| (m["id"].as_str().unwrap(), m["complete"].as_bool().unwrap())).collect();
        assert_eq!(m, [("3", true), ("2", false)]);
        let t = s.get_transcript(2, 0, 100, true).unwrap();
        assert_eq!(t["metadata"]["complete"], false);
        assert!(t["metadata"]["note"].as_str().unwrap().contains("avbröts"));
        assert_eq!(s.get_protocol(2).unwrap()["complete"], false);
        let a = s.list_action_items(None, None, 10).unwrap();
        assert_eq!(a["action_items"][0]["meeting_complete"], false, "{a}");
        // Med sitt id går ett möte som transkriberas fortfarande att läsa, märkt.
        let t = s.get_transcript(1, 0, 100, true).unwrap();
        assert_eq!(t["metadata"]["complete"], false);
        assert!(t["metadata"]["note"].as_str().unwrap().contains("fortfarande"));
    }

    #[test]
    fn database_without_the_state_column_reads_as_complete() {
        // Fixturen saknar kolumnen, som en databas appen inte hunnit uppdatera.
        let v = store("nostate").list_meetings(10, 0, None, None).unwrap();
        assert_eq!(v["total"], 3);
        assert!(v["meetings"].as_array().unwrap().iter().all(|m| m["complete"] == true));
    }

    /// Testerna låser tidszonen, så att datumfilter och titlar inte beror på datorn de körs på.
    fn store(name: &str) -> Store {
        Store::in_dir(&fixture(name)).with_tz(chrono::FixedOffset::east_opt(2 * 3600).unwrap())
    }

    #[test]
    fn titles_use_local_time_and_hide_automatic_file_names() {
        let cet = chrono::FixedOffset::east_opt(2 * 3600).unwrap();
        let t = |name: &str, at: &str| {
            title_at(name, at, chrono::DateTime::parse_from_rfc3339(at).ok().map(|x| x.with_timezone(&cet)))
        };
        assert_eq!(t("session_1791317728796044.wav", "2026-10-06T20:15:28.732+00:00"), "Möte 6 okt 2026, 22:15");
        assert_eq!(t("Styrelsemöte.wav", "2026-10-01T07:00:00+00:00"), "Styrelsemöte (1 okt 2026, 09:00)");
        assert_eq!(t("session_abc.wav", "2026-01-31T23:30:00+00:00"), "session_abc (1 feb 2026, 01:30)");
        // Datumet som filtren använder följer samma lokala tid som titeln.
        let at = "2026-10-01T22:30:00+00:00";
        assert_eq!(date_in(at, chrono::DateTime::parse_from_rfc3339(at).ok().map(|x| x.with_timezone(&cet))), "2026-10-02");
        assert_eq!(date_in("igår", None), "igår");
        // Oläslig tid: faller tillbaka på texten i stället för att krascha.
        assert_eq!(title_at("session_1.wav", "igår", None), "Möte igår");
    }

    #[test]
    fn missing_database_is_reported_not_crashed() {
        let dir = std::env::temp_dir().join(format!("sagt-mcp-nodb-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        assert!(matches!(Store::in_dir(&dir).list_meetings(10, 0, None, None), Err(StoreError::NoDatabase)));
    }

    #[test]
    fn list_is_newest_first_with_paging_and_range() {
        let s = store("list");
        let v = s.list_meetings(2, 0, None, None).unwrap();
        let ids: Vec<&str> = v["meetings"].as_array().unwrap().iter().map(|m| m["id"].as_str().unwrap()).collect();
        assert_eq!(ids, ["3", "2"]);
        assert_eq!(v["remaining"], 1);
        let r = s.list_meetings(10, 0, Some("2026-10-02"), Some("2026-10-05")).unwrap();
        assert_eq!(r["total"], 1);
        assert_eq!(r["meetings"][0]["url"], "sagt://meeting/2");
        assert_eq!(r["meetings"][0]["has_protocol"], true);
    }

    #[test]
    fn transcript_merges_turns_and_uses_names() {
        let v = store("turns").get_transcript(1, 0, 10, false).unwrap();
        let turns = v["turns"].as_array().unwrap();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[0]["speaker"], "Anna");
        assert_eq!(turns[0]["text"], "Välkomna till mötet. Vi tittar på budgeten.");
        assert_eq!(turns[1]["speaker"], "Mötet");
        assert_eq!(v["metadata"]["transcript_source"], "local");
        assert!(v["text"].as_str().unwrap().starts_with("Anna: Välkomna"));
    }

    #[test]
    fn cloud_segments_take_precedence_over_local_text() {
        let v = store("cloud").get_transcript(2, 0, 10, true).unwrap();
        assert_eq!(v["metadata"]["transcript_source"], "cloud");
        assert!(v["text"].as_str().unwrap().contains("Molntext"));
        assert!(!v["text"].as_str().unwrap().contains("Lokal text"));
        assert!(v.get("turns").is_none());
    }

    #[test]
    fn transcript_pages_with_remaining_count() {
        let v = store("page").get_transcript(1, 1, 1, false).unwrap();
        assert_eq!(v["turns"].as_array().unwrap().len(), 1);
        assert_eq!(v["metadata"]["remaining_turns"], 0);
        assert_eq!(v["metadata"]["total_turns"], 2);
    }

    #[test]
    fn unknown_id_is_not_found() {
        assert!(matches!(store("nf").get_protocol(99), Err(StoreError::NotFound(99))));
    }

    #[test]
    fn search_is_case_insensitive_for_swedish_letters() {
        let v = store("search").search("ängelholm", 10).unwrap();
        let r = v["results"].as_array().unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0]["id"], "1");
        assert!(r[0]["snippet"].as_str().unwrap().to_lowercase().contains("ängelholm"));
        assert_eq!(r[0]["matches"], 2);
    }

    #[test]
    fn search_ranks_by_distinct_words_and_finds_nothing_cleanly() {
        let s = store("rank");
        let v = s.search("offert budgeten", 10).unwrap();
        assert_eq!(v["results"].as_array().unwrap().len(), 2);
        assert!(s.search("zzzqqq", 10).unwrap()["results"].as_array().unwrap().is_empty());
    }

    #[test]
    fn protocol_reads_both_formats_and_null_without() {
        let s = store("proto");
        assert_eq!(s.get_protocol(1).unwrap()["protocol"]["decisions"][0], "Godkänn budget");
        assert_eq!(s.get_protocol(2).unwrap()["protocol"]["action_items"][0], "Skicka offert");
        assert!(s.get_protocol(3).unwrap()["protocol"].is_null());
    }

    #[test]
    fn action_items_across_meetings_in_range() {
        let s = store("actions");
        let v = s.list_action_items(None, None, 10).unwrap();
        assert_eq!(v["total"], 3);
        assert_eq!(v["meetings_with_actions"], 2);
        let r = s.list_action_items(Some("2026-10-02"), None, 10).unwrap();
        assert_eq!(r["total"], 1);
    }

    #[test]
    fn no_response_contains_the_audio_path() {
        let s = store("nopath");
        let all = [
            s.list_meetings(10, 0, None, None).unwrap(),
            s.search("mötet offert budgeten", 10).unwrap(),
            s.get_transcript(1, 0, 50, false).unwrap(),
            s.get_transcript(2, 0, 50, true).unwrap(),
            s.get_protocol(1).unwrap(),
            s.list_action_items(None, None, 50).unwrap(),
        ];
        for v in all {
            let t = v.to_string();
            assert!(!t.contains("hemlig") && !t.contains(".wav") && !t.contains("file_path"), "{t}");
        }
    }

    #[test]
    fn reads_while_the_app_holds_a_write_lock() {
        let dir = fixture("lock");
        let writer = Connection::open(dir.join(super::super::session::DB_FILE)).unwrap();
        // EXCLUSIVE och inte IMMEDIATE: i journalläget släpper en reserverad skrivlåsning
        // fortfarande igenom läsare, så testet hade passerat utan att pröva väntetiden.
        writer.execute_batch("BEGIN EXCLUSIVE; UPDATE recordings SET filename = filename WHERE id = 1;").unwrap();
        let s = Store::in_dir(&dir);
        let h = std::thread::spawn(move || s.list_meetings(10, 0, None, None).map(|v| v["total"].clone()));
        std::thread::sleep(Duration::from_millis(300));
        writer.execute_batch("COMMIT;").unwrap();
        assert_eq!(h.join().unwrap().unwrap(), 3);
    }
}
