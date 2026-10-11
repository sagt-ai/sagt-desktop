//! Sessionsfilen som binder MCP-processen till appens inloggning.
//!
//! Appen skriver `mcp-session.json` i sin datakatalog när användaren slår på MCP och
//! skriver om den vid varje förnyad inloggning. Den raderas när MCP slås av eller
//! användaren loggar ut. MCP-processen läser filen vid varje verktygsanrop, så en
//! utloggning eller en avstängning slår igenom utan att assistenten startas om.
//!
//! Filen är också grinden för läsningen: utan en giltig fil läser MCP-processen inga
//! möten alls. Det är så "av som standard" upprätthålls i processen, oberoende av vad
//! assistentens konfiguration säger.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const SESSION_FILE: &str = "mcp-session.json";
pub const LEDGER_FILE: &str = "mcp-ledger.json";
pub const DB_FILE: &str = "whisper.db";

/// Appens datakatalog, samma som Tauris `app_data_dir` (datakatalogen + identifieraren).
/// `SAGT_DATA_DIR` ersätter den i tester och vid felsökning.
pub fn data_dir() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("SAGT_DATA_DIR") {
        return Some(PathBuf::from(d));
    }
    dirs::data_dir().map(|d| d.join("com.sagt.ai"))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Session {
    pub user_id: String,
    pub token: String,
    /// "free" eller "pro" enligt appens senaste förnyelse. Pro-status kontrolleras
    /// dessutom mot servern vid första anropet i processen (se quota.rs).
    pub plan: String,
    /// Inloggningens sista giltiga sekund (Unix-tid).
    pub exp: i64,
    /// API-basen, till exempel `https://api.sagt.ai/api/v1`.
    pub api_base: String,
    #[serde(default)]
    pub posthog_key: Option<String>,
    #[serde(default)]
    pub posthog_host: Option<String>,
    #[serde(default)]
    pub app_version: Option<String>,
}

impl Session {
    pub fn is_pro(&self) -> bool {
        self.plan == "pro"
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum SessionState {
    /// Ingen fil: MCP är av i appen, eller användaren är utloggad.
    Missing,
    /// Filen finns men går inte att läsa som en session.
    Invalid,
    /// Inloggningen har gått ut; appen förnyar den när den öppnas.
    Expired,
    Valid(Session),
}

pub fn load(dir: &Path, now: i64) -> SessionState {
    let raw = match std::fs::read_to_string(dir.join(SESSION_FILE)) {
        Ok(r) => r,
        Err(_) => return SessionState::Missing,
    };
    let s: Session = match serde_json::from_str(&raw) {
        Ok(s) => s,
        Err(_) => return SessionState::Invalid,
    };
    if s.user_id.is_empty() || s.token.is_empty() || s.api_base.is_empty() {
        return SessionState::Invalid;
    }
    if now >= s.exp {
        return SessionState::Expired;
    }
    SessionState::Valid(s)
}

/// Texten assistenten får när sessionen inte duger. Den återges för användaren.
pub fn refusal(state: &SessionState) -> Option<&'static str> {
    match state {
        SessionState::Valid(_) => None,
        SessionState::Missing => Some(
            "MCP är inte påslaget i Sagt. Öppna Sagt, logga in och slå på \"Låt min AI-assistent läsa mina möten\" under Inställningar.",
        ),
        SessionState::Invalid => Some(
            "Sagt kunde inte läsa sin MCP-inställning. Slå av och på MCP under Inställningar i Sagt.",
        ),
        SessionState::Expired => Some(
            "Inloggningen i Sagt har gått ut. Öppna Sagt så förnyas den, och försök sedan igen.",
        ),
    }
}

pub fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sagt-mcp-session-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write(dir: &Path, v: serde_json::Value) {
        std::fs::write(dir.join(SESSION_FILE), v.to_string()).unwrap();
    }

    #[test]
    fn missing_file_is_missing() {
        assert_eq!(load(&tmp("missing"), 100), SessionState::Missing);
    }

    #[test]
    fn garbage_and_empty_fields_are_invalid() {
        let d = tmp("invalid");
        std::fs::write(d.join(SESSION_FILE), "inte json").unwrap();
        assert_eq!(load(&d, 100), SessionState::Invalid);
        write(&d, serde_json::json!({"user_id": "", "token": "t", "plan": "free", "exp": 200, "api_base": "x"}));
        assert_eq!(load(&d, 100), SessionState::Invalid);
    }

    #[test]
    fn expiry_is_checked_at_the_boundary() {
        let d = tmp("expiry");
        write(&d, serde_json::json!({"user_id": "u", "token": "t", "plan": "free", "exp": 200, "api_base": "x"}));
        assert!(matches!(load(&d, 199), SessionState::Valid(_)));
        assert_eq!(load(&d, 200), SessionState::Expired);
    }

    #[test]
    fn every_non_valid_state_has_a_refusal() {
        for s in [SessionState::Missing, SessionState::Invalid, SessionState::Expired] {
            assert!(refusal(&s).is_some());
        }
    }
}
