//! MCP-servern: fem läsverktyg och två prompter över appens lokala möten.
//!
//! Ordningen i varje verktygsanrop är vald så att inget läses utan påslagen MCP och
//! att ett misslyckat anrop inte kostar något:
//!   1. sessionsfilen (utan den läses inga möten),
//!   2. argumenten,
//!   3. läsningen i databasen,
//!   4. kvoten, först när det finns ett resultat att lämna,
//!   5. svaret.

use rmcp::model::{
    CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, GetPromptRequestParams, GetPromptResponse,
    GetPromptResult, Implementation, JsonObject, ListPromptsResult, ListToolsResult, PaginatedRequestParams, Prompt,
    PromptArgument, PromptMessage, Role, ServerCapabilities, ServerConfig, Tool, ToolAnnotations,
};
use rmcp::service::RequestContext;
use rmcp::{ErrorData as McpError, RoleServer, ServerHandler};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use super::quota::{Backend, HttpBackend, Permit, Quota};
use super::session::{self, SessionState};
use super::store::{self, Store, StoreError};
use super::telemetry;

pub const TOOLS: [&str; 5] = [
    "sagt_list_meetings",
    "sagt_search_meetings",
    "sagt_get_transcript",
    "sagt_get_protocol",
    "sagt_list_action_items",
];

const INSTRUCTIONS: &str = "Sagt is a Swedish meeting transcription app. These tools read the user's meetings stored on this computer: transcripts (mostly Swedish) and AI meeting minutes with decisions and action items. All tools are read-only. Prefer sagt_get_protocol for an overview of one meeting and sagt_search_meetings to find meetings, and read full transcripts with sagt_get_transcript only when the details are needed. Each tool call may count against the user's daily quota on the free plan, so avoid unnecessary calls. Cite meetings by title and date.";

fn schema(v: Value) -> Arc<JsonObject> {
    Arc::new(v.as_object().cloned().unwrap_or_default())
}

fn read_only(title: &str) -> ToolAnnotations {
    ToolAnnotations::with_title(title).read_only(true).destructive(false).idempotent(true).open_world(false)
}

pub fn tool_list() -> Vec<Tool> {
    let date = json!({"type": "string", "description": "Date as YYYY-MM-DD (inclusive)."});
    vec![
        Tool::new(
            "sagt_list_meetings",
            "List the user's meetings in Sagt, newest first. Returns id, title (name and time), date, length in minutes, word count and whether AI meeting minutes exist. Use the id with the other tools. Use from/to to limit the period; use sagt_search_meetings instead when looking for a topic.",
            schema(json!({"type": "object", "properties": {
                "limit": {"type": "integer", "minimum": 1, "maximum": 50, "default": 20},
                "offset": {"type": "integer", "minimum": 0, "default": 0},
                "from": date, "to": date}})),
        ).with_annotations(read_only("List meetings")),
        Tool::new(
            "sagt_search_meetings",
            "Search the user's meetings for words in transcripts and meeting minutes. Matching is on words, not meaning, and ignores case (including Swedish å, ä, ö), so search in Swedish and try synonyms if nothing is found. Returns id, title, url, date and a snippet per meeting, ranked by how many of the words match. An empty result means no meeting contains the words.",
            schema(json!({"type": "object", "required": ["query"], "properties": {
                "query": {"type": "string", "description": "One or more words, for example \"budget styrelse\"."},
                "limit": {"type": "integer", "minimum": 1, "maximum": 25, "default": 10}}})),
        ).with_annotations(read_only("Search meetings")),
        Tool::new(
            "sagt_get_transcript",
            "Read the transcript of one meeting as speaker turns (who said what). Long meetings are paged: read `metadata.remaining_turns` and call again with a higher offset to continue. Prefer sagt_get_protocol first, since a full transcript is long. format \"text\" returns only the text, \"turns\" also returns each turn with its start time.",
            schema(json!({"type": "object", "required": ["id"], "properties": {
                "id": {"type": ["string", "integer"], "description": "Meeting id from sagt_list_meetings or sagt_search_meetings."},
                "offset": {"type": "integer", "minimum": 0, "default": 0},
                "limit": {"type": "integer", "minimum": 1, "maximum": store::MAX_TURNS, "default": store::DEFAULT_TURNS},
                "format": {"type": "string", "enum": ["turns", "text"], "default": "text"}}})),
        ).with_annotations(read_only("Get transcript")),
        Tool::new(
            "sagt_get_protocol",
            "Read the AI meeting minutes of one meeting: summary, decisions and action items. This is the shortest way to learn what a meeting was about. Returns protocol: null if the user has not created minutes for the meeting; then read the transcript instead.",
            schema(json!({"type": "object", "required": ["id"], "properties": {
                "id": {"type": ["string", "integer"], "description": "Meeting id."}}})),
        ).with_annotations(read_only("Get meeting minutes")),
        Tool::new(
            "sagt_list_action_items",
            "List action items from the meeting minutes of all meetings in a period, with the meeting each came from. Use this for questions like \"what have I promised to do?\" instead of reading every meeting. Only meetings with minutes have action items.",
            schema(json!({"type": "object", "properties": {
                "from": date, "to": date,
                "limit": {"type": "integer", "minimum": 1, "maximum": 200, "default": 50}}})),
        ).with_annotations(read_only("List action items")),
    ]
}

// ─── Argument ──────────────────────────────────────────────────────────────

fn arg_usize(args: &JsonObject, key: &str, default: usize, max: usize) -> usize {
    args.get(key).and_then(|v| v.as_u64()).map(|n| (n as usize).min(max)).unwrap_or(default)
}

fn arg_date(args: &JsonObject, key: &str) -> Result<Option<String>, String> {
    match args.get(key).and_then(|v| v.as_str()) {
        None => Ok(None),
        Some(s) if s.len() == 10 && s.as_bytes()[4] == b'-' && s.as_bytes()[7] == b'-' && s.chars().filter(|c| c.is_ascii_digit()).count() == 8 => Ok(Some(s.to_string())),
        Some(s) => Err(format!("{key} ska vara ett datum som ÅÅÅÅ-MM-DD, fick \"{s}\".")),
    }
}

fn arg_id(args: &JsonObject) -> Result<i64, String> {
    match args.get("id") {
        Some(Value::Number(n)) => n.as_i64().ok_or_else(|| "id ska vara ett heltal.".to_string()),
        Some(Value::String(s)) => s.trim().parse().map_err(|_| format!("id ska vara ett mötes-id, fick \"{s}\".")),
        _ => Err("id saknas. Hämta id med sagt_list_meetings eller sagt_search_meetings.".into()),
    }
}

/// Läs i databasen. Ok(None) betyder ett giltigt men tomt svar som inte ska kosta något.
pub fn run_tool(store: &Store, name: &str, args: &JsonObject) -> Result<Option<Value>, String> {
    let r = match name {
        "sagt_list_meetings" => {
            let (from, to) = (arg_date(args, "from")?, arg_date(args, "to")?);
            store.list_meetings(arg_usize(args, "limit", 20, 50), arg_usize(args, "offset", 0, usize::MAX), from.as_deref(), to.as_deref())
        }
        "sagt_search_meetings" => {
            let q = args.get("query").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            if q.split_whitespace().all(|w| w.chars().count() < 2) {
                return Err("Ange minst ett sökord med två eller fler bokstäver.".into());
            }
            store.search(&q, arg_usize(args, "limit", 10, 25))
        }
        "sagt_get_transcript" => {
            let id = arg_id(args)?;
            let as_text = args.get("format").and_then(|v| v.as_str()) != Some("turns");
            store.get_transcript(id, arg_usize(args, "offset", 0, usize::MAX), arg_usize(args, "limit", store::DEFAULT_TURNS, store::MAX_TURNS), as_text)
        }
        "sagt_get_protocol" => store.get_protocol(arg_id(args)?),
        "sagt_list_action_items" => {
            let (from, to) = (arg_date(args, "from")?, arg_date(args, "to")?);
            store.list_action_items(from.as_deref(), to.as_deref(), arg_usize(args, "limit", 50, 200))
        }
        other => return Err(format!("Okänt verktyg: {other}")),
    };
    match r {
        Ok(v) => {
            let empty = ["meetings", "results", "action_items"].iter().any(|k| v.get(*k).and_then(|x| x.as_array()).map_or(false, |a| a.is_empty()))
                || v.pointer("/metadata/total_turns").and_then(|n| n.as_u64()) == Some(0);
            Ok(if empty { None } else { Some(v) })
        }
        Err(e) => {
            if let StoreError::Sql(detail) = &e {
                eprintln!("sagt --mcp: databasfel: {detail}");
            }
            Err(e.to_string())
        }
    }
}

// ─── Servern ───────────────────────────────────────────────────────────────

pub struct SagtMcp<B: Backend + Send + Sync + 'static> {
    dir: PathBuf,
    quota: Quota<B>,
    http: reqwest::Client,
    /// Ett verktygsanrop i taget mot kvoten, så att liggaren inte skrivs samtidigt.
    quota_lock: tokio::sync::Mutex<()>,
}

impl SagtMcp<HttpBackend> {
    pub fn new(dir: PathBuf) -> Self {
        let quota = Quota::new(HttpBackend::new(), &dir);
        SagtMcp::with_quota(dir, quota)
    }
}

impl<B: Backend + Send + Sync + 'static> SagtMcp<B> {
    pub fn with_quota(dir: PathBuf, quota: Quota<B>) -> Self {
        super::ensure_crypto_provider();
        let http = reqwest::Client::builder().timeout(std::time::Duration::from_secs(3)).build().expect("HTTP-klienten går att bygga");
        SagtMcp { dir, quota, http, quota_lock: tokio::sync::Mutex::new(()) }
    }

    pub async fn handle(&self, name: &str, args: JsonObject) -> CallToolResult {
        let started = Instant::now();
        let state = session::load(&self.dir, session::now_unix());
        let s = match &state {
            SessionState::Valid(s) => s.clone(),
            other => return CallToolResult::error(vec![ContentBlock::text(session::refusal(other).unwrap_or(""))]),
        };
        let plan = if s.is_pro() { "pro" } else { "free" };
        let store_path = self.dir.clone();
        let tool = name.to_string();
        let ran = tokio::task::spawn_blocking(move || run_tool(&Store::in_dir(&store_path), &tool, &args))
            .await
            .unwrap_or_else(|_| Err("Sagt kunde inte läsa mötena just nu.".into()));
        let finish = |outcome: &str, offline: bool| {
            telemetry::capture(&self.http, &s, name, plan, outcome, started.elapsed().as_millis(), offline);
        };
        let value = match ran {
            Err(msg) => {
                finish("invalid", false);
                return CallToolResult::error(vec![ContentBlock::text(msg)]);
            }
            Ok(None) => {
                finish("empty", false);
                return CallToolResult::structured(json!({"results": [], "note": "Inget matchade. Det här anropet räknades inte."}));
            }
            Ok(Some(v)) => v,
        };
        let key = format!("mcp-{}", uuid::Uuid::new_v4());
        let permit = {
            let _guard = self.quota_lock.lock().await;
            self.quota.permit(&s, &key, session::now_unix()).await
        };
        match permit {
            Permit::Allowed { offline } => {
                finish("ok", offline);
                CallToolResult::structured(value)
            }
            Permit::Exhausted { message, used, limit, resets_at } => {
                finish("quota_exhausted", false);
                CallToolResult::structured_error(json!({"code": "quota_exhausted", "message": message, "used": used, "limit": limit, "resets_at": resets_at}))
            }
            Permit::Denied(msg) => {
                finish("denied", false);
                CallToolResult::error(vec![ContentBlock::text(msg)])
            }
        }
    }
}

fn prompts() -> Vec<Prompt> {
    vec![
        Prompt::new(
            "sagt_vad_har_jag_lovat",
            Some("Sammanställ åtgärdspunkterna från dina möten under en period."),
            Some(vec![PromptArgument::new("period").with_description("Till exempel \"den här veckan\" eller \"sedan 1 oktober\". Utelämnas: senaste 14 dagarna.").with_required(false)]),
        )
        .with_title("Vad har jag lovat att göra?"),
        Prompt::new(
            "sagt_uppfoljningsmejl",
            Some("Skriv ett uppföljningsmejl efter ett möte, med beslut och åtgärder."),
            Some(vec![PromptArgument::new("mote").with_description("Mötets namn, datum eller id.").with_required(true)]),
        )
        .with_title("Skriv ett uppföljningsmejl"),
    ]
}

fn prompt_text(name: &str, args: &serde_json::Map<String, Value>) -> Option<String> {
    let arg = |k: &str| args.get(k).and_then(|v| v.as_str()).map(str::trim).filter(|s| !s.is_empty()).map(String::from);
    match name {
        "sagt_vad_har_jag_lovat" => Some(format!(
            "Använd sagt_list_action_items för perioden {} och sammanställ vad jag har lovat att göra, grupperat per möte med datum. Markera punkter där det framgår att någon annan än jag är ansvarig. Hitta inte på punkter som inte står i protokollen.",
            arg("period").unwrap_or_else(|| "de senaste 14 dagarna".into())
        )),
        "sagt_uppfoljningsmejl" => Some(format!(
            "Hitta mötet \"{}\" med sagt_search_meetings eller sagt_list_meetings, läs protokollet med sagt_get_protocol (och transkriptet bara om protokollet saknas), och skriv ett kort uppföljningsmejl på svenska till deltagarna: tack för mötet, besluten, åtgärderna med ansvarig, och nästa steg. Skriv bara det som står i mötet.",
            arg("mote")?
        )),
        _ => None,
    }
}

impl<B: Backend + Send + Sync + 'static> ServerHandler for SagtMcp<B> {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().enable_prompts().build())
            .with_server_info(Implementation::new("sagt", env!("CARGO_PKG_VERSION")))
            .with_instructions(INSTRUCTIONS)
    }

    async fn list_tools(&self, _request: Option<PaginatedRequestParams>, _context: RequestContext<RoleServer>) -> Result<ListToolsResult, McpError> {
        Ok(ListToolsResult::with_all_items(tool_list()))
    }

    async fn call_tool(&self, request: CallToolRequestParams, _context: RequestContext<RoleServer>) -> Result<CallToolResponse, McpError> {
        if !TOOLS.contains(&request.name.as_ref()) {
            return Err(McpError::invalid_params(format!("okänt verktyg: {}", request.name), None));
        }
        Ok(self.handle(&request.name, request.arguments.unwrap_or_default()).await.into())
    }

    async fn list_prompts(&self, _request: Option<PaginatedRequestParams>, _context: RequestContext<RoleServer>) -> Result<ListPromptsResult, McpError> {
        Ok(ListPromptsResult::with_all_items(prompts()))
    }

    async fn get_prompt(&self, request: GetPromptRequestParams, _context: RequestContext<RoleServer>) -> Result<GetPromptResponse, McpError> {
        let args = request.arguments.clone().unwrap_or_default();
        match prompt_text(&request.name, &args) {
            Some(text) => Ok(GetPromptResult::new(vec![PromptMessage::new_text(Role::User, text)]).into()),
            None => Err(McpError::invalid_params(format!("okänd prompt eller argument saknas: {}", request.name), None)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::quota::{Allowance, Reply};
    use super::super::session::Session;
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[derive(Default)]
    struct Counting {
        consumed: AtomicUsize,
        exhausted: bool,
    }

    impl Backend for Counting {
        async fn consume(&self, _: &Session, _: &str) -> Reply {
            self.consumed.fetch_add(1, Ordering::SeqCst);
            if self.exhausted {
                Reply::Exhausted(json!({"detail": "Du har använt 10 av 10 MCP-anrop i dag.", "used": 10, "limit": 10, "resets_at": "2026-10-11"}))
            } else {
                Reply::Ok(json!({"plan": "free"}))
            }
        }
        async fn reconcile(&self, _: &Session, _: &Allowance, _: &[String]) -> Reply {
            Reply::Unreachable
        }
        async fn entitlements(&self, _: &Session) -> Reply {
            Reply::Unreachable
        }
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    fn with_session(name: &str, plan: &str) -> PathBuf {
        let dir = store::tests::fixture(name);
        let s = Session { user_id: "u1".into(), token: "t".into(), plan: plan.into(), exp: session::now_unix() + 3600, api_base: "http://127.0.0.1:9".into(), posthog_key: None, posthog_host: None, app_version: None };
        std::fs::write(dir.join(session::SESSION_FILE), serde_json::to_string(&s).unwrap()).unwrap();
        dir
    }

    fn args(v: Value) -> JsonObject {
        v.as_object().cloned().unwrap()
    }

    fn server(dir: &PathBuf, exhausted: bool) -> SagtMcp<Counting> {
        SagtMcp::with_quota(dir.clone(), Quota::new(Counting { exhausted, ..Default::default() }, dir))
    }

    fn text_of(r: &CallToolResult) -> String {
        serde_json::to_string(&r.content).unwrap()
    }

    #[test]
    fn without_a_session_nothing_is_read_or_counted() {
        let dir = store::tests::fixture("nosession");
        let s = server(&dir, false);
        let r = rt().block_on(s.handle("sagt_list_meetings", args(json!({}))));
        assert_eq!(r.is_error, Some(true));
        assert!(text_of(&r).contains("inte påslaget"));
        assert!(!text_of(&r).contains("Styrelsemöte"));
        assert_eq!(s.quota_backend_consumed(), 0);
    }

    #[test]
    fn a_successful_call_is_counted_once() {
        let dir = with_session("counted", "free");
        let s = server(&dir, false);
        let r = rt().block_on(s.handle("sagt_get_protocol", args(json!({"id": "1"}))));
        assert_eq!(r.is_error, Some(false));
        assert_eq!(r.structured_content.as_ref().unwrap()["protocol"]["decisions"][0], "Godkänn budget");
        assert_eq!(s.quota_backend_consumed(), 1);
    }

    #[test]
    fn invalid_calls_and_empty_results_cost_nothing() {
        let dir = with_session("free-errors", "free");
        let s = server(&dir, false);
        let r = rt();
        for (tool, a) in [
            ("sagt_get_protocol", json!({"id": "999"})),
            ("sagt_get_transcript", json!({})),
            ("sagt_search_meetings", json!({"query": "x"})),
            ("sagt_search_meetings", json!({"query": "zzzqqq"})),
            ("sagt_list_meetings", json!({"from": "igår"})),
            ("sagt_get_transcript", json!({"id": 3})), // inspelning utan text
        ] {
            r.block_on(s.handle(tool, args(a)));
        }
        assert_eq!(s.quota_backend_consumed(), 0);
    }

    #[test]
    fn quota_exhausted_withholds_the_data() {
        let dir = with_session("exhausted", "free");
        let s = server(&dir, true);
        let r = rt().block_on(s.handle("sagt_get_transcript", args(json!({"id": 1}))));
        assert_eq!(r.is_error, Some(true));
        let sc = r.structured_content.unwrap();
        assert_eq!(sc["code"], "quota_exhausted");
        assert!(!sc.to_string().contains("Välkomna"), "inget mötesinnehåll när kvoten är slut");
    }

    #[test]
    fn tools_are_read_only_and_described() {
        let tools = tool_list();
        assert_eq!(tools.len(), TOOLS.len());
        for t in &tools {
            assert!(TOOLS.contains(&t.name.as_ref()));
            let a = t.annotations.as_ref().unwrap();
            assert_eq!(a.read_only_hint, Some(true));
            assert_eq!(a.destructive_hint, Some(false));
            assert!(t.description.as_ref().unwrap().split(". ").count() >= 3, "{}: minst tre meningar", t.name);
        }
    }

    #[test]
    fn prompts_need_their_required_argument() {
        let mut a = serde_json::Map::new();
        assert!(prompt_text("sagt_uppfoljningsmejl", &a).is_none());
        a.insert("mote".into(), json!("Styrelsemöte"));
        assert!(prompt_text("sagt_uppfoljningsmejl", &a).unwrap().contains("Styrelsemöte"));
        assert!(prompt_text("sagt_vad_har_jag_lovat", &serde_json::Map::new()).unwrap().contains("14 dagarna"));
        assert_eq!(prompts().len(), 2);
    }

    impl SagtMcp<Counting> {
        fn quota_backend_consumed(&self) -> usize {
            self.quota.backend_ref().consumed.load(Ordering::SeqCst)
        }
    }
}
