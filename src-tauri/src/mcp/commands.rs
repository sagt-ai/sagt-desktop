//! Appens sida av MCP: skriva och radera sessionsfilen, och visa kommandot som
//! assistenten ska starta.

use std::path::{Path, PathBuf};
use tauri::Manager;

use super::session::{self, Session, SESSION_FILE};

fn app_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| format!("hittar ingen datakatalog: {e}"))?;
    // MCP-processen räknar fram katalogen utan Tauri. Skiljer de sig åt hade appen skrivit
    // en fil som processen aldrig hittar, och MCP hade sett påslaget ut men vägrat allt.
    if std::env::var_os("SAGT_DATA_DIR").is_none() {
        if let Some(theirs) = session::data_dir() {
            if theirs != dir {
                return Err(format!("datakatalogerna skiljer sig åt: {} och {}", dir.display(), theirs.display()));
            }
        }
    }
    Ok(dir)
}

pub fn write_session_file(dir: &Path, raw: &str) -> Result<(), String> {
    let s: Session = serde_json::from_str(raw).map_err(|e| format!("ogiltig session: {e}"))?;
    if s.user_id.is_empty() || s.token.is_empty() || s.api_base.is_empty() || (s.plan != "free" && s.plan != "pro") {
        return Err("ogiltig session: tomt fält eller okänd plan".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(SESSION_FILE);
    let tmp = dir.join(format!("{SESSION_FILE}.tmp"));
    std::fs::write(&tmp, serde_json::to_string(&s).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    // Inloggningen ligger i filen: bara användaren själv får läsa den.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub fn clear_session_file(dir: &Path) -> Result<(), String> {
    match std::fs::remove_file(dir.join(SESSION_FILE)) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn mcp_write_session(app: tauri::AppHandle, session: String) -> Result<(), String> {
    write_session_file(&app_dir(&app)?, &session)
}

#[tauri::command]
pub fn mcp_clear_session(app: tauri::AppHandle) -> Result<(), String> {
    clear_session_file(&app_dir(&app)?)
}

/// Sökvägen till appens körbara fil, som assistenten startar med `--mcp`.
#[tauri::command]
pub fn mcp_server_command() -> Result<String, String> {
    std::env::current_exe().map(|p| p.to_string_lossy().into_owned()).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sagt-mcp-cmd-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    fn valid() -> String {
        serde_json::json!({"user_id": "u", "token": "t", "plan": "free", "exp": 9_999_999_999i64, "api_base": "https://x/api/v1"}).to_string()
    }

    #[test]
    fn written_session_is_read_back_by_the_mcp_process() {
        let d = dir("roundtrip");
        write_session_file(&d, &valid()).unwrap();
        assert!(matches!(session::load(&d, 1), session::SessionState::Valid(_)));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(d.join(SESSION_FILE)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
        clear_session_file(&d).unwrap();
        assert_eq!(session::load(&d, 1), session::SessionState::Missing);
        clear_session_file(&d).unwrap(); // redan borta: inget fel
    }

    #[test]
    fn invalid_sessions_are_refused_and_nothing_is_written() {
        let d = dir("invalid");
        for raw in [
            "inte json".to_string(),
            serde_json::json!({"user_id": "", "token": "t", "plan": "free", "exp": 1, "api_base": "x"}).to_string(),
            serde_json::json!({"user_id": "u", "token": "t", "plan": "gratis", "exp": 1, "api_base": "x"}).to_string(),
        ] {
            assert!(write_session_file(&d, &raw).is_err(), "{raw}");
        }
        assert!(!d.join(SESSION_FILE).exists());
    }
}
