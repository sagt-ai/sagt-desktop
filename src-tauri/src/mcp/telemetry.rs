//! Ett event per verktygsanrop till samma produktanalys som appen använder.
//!
//! Bara verktygets namn, plan, utfall, tid och om anropet gjordes utan nätverk.
//! Aldrig frågan, söktermer, mötesinnehåll eller id:n. Eventet heter `mcp_call`
//! eftersom analysverktygets egna MCP-event har namn som `mcp_tool_call`.

use serde_json::{json, Value};

use super::session::Session;

pub fn event_body(s: &Session, key: &str, tool: &str, plan: &str, outcome: &str, duration_ms: u128, offline: bool) -> Value {
    json!({
        "api_key": key,
        "event": "mcp_call",
        "distinct_id": s.user_id,
        "properties": {
            "tool": tool,
            "plan": plan,
            "outcome": outcome,
            "duration_ms": duration_ms as u64,
            "offline": offline,
            "platform": "desktop_mcp",
            "app_version": s.app_version,
        },
    })
}

/// Skicka eventet utan att vänta på det. Fel ignoreras: analys får aldrig stoppa ett anrop.
pub fn capture(client: &reqwest::Client, s: &Session, tool: &str, plan: &str, outcome: &str, duration_ms: u128, offline: bool) {
    let Some(key) = s.posthog_key.as_deref().filter(|k| !k.is_empty()) else { return };
    let host = s.posthog_host.clone().unwrap_or_else(|| "https://eu.i.posthog.com".into());
    let body = event_body(s, key, tool, plan, outcome, duration_ms, offline);
    let req = client.post(format!("{}/capture/", host.trim_end_matches('/'))).json(&body);
    tokio::spawn(async move {
        let _ = req.send().await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_carries_no_content() {
        let s = Session { user_id: "u1".into(), token: "hemlig-token".into(), plan: "free".into(), exp: 1, api_base: "x".into(), posthog_key: Some("k".into()), posthog_host: None, app_version: Some("0.12.0".into()) };
        let v = event_body(&s, "k", "sagt_search_meetings", "free", "ok", 12, false);
        let t = v.to_string();
        assert_eq!(v["event"], "mcp_call");
        assert!(!t.contains("hemlig-token"));
        let props: Vec<&String> = v["properties"].as_object().unwrap().keys().collect();
        assert_eq!(props.len(), 7, "nya egenskaper ska granskas mot innehåll: {props:?}");
    }
}
