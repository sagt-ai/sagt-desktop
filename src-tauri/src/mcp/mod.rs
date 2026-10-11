//! MCP-läget: `sagt --mcp` kör en lokal MCP-server på stdin/stdout i stället för appen.
//!
//! En AI-assistent på samma dator (till exempel Claude Desktop eller Claude Code)
//! startar processen med kommandot som appen visar när MCP slås på. Processen läser
//! bara möten när appen har slagit på MCP (sessionsfilen), läser aldrig ljud, och
//! skriver ingenting i databasen.
//!
//! Läget grenar av innan Tauri startar. Appens loggning omdirigerar stdout till en
//! loggfil när fönstret startas, och stdout är här protokollets kanal: allt som inte
//! är protokoll skrivs till stderr.

pub mod commands;
pub mod quota;
pub mod server;
pub mod session;
pub mod store;
pub mod telemetry;

use rmcp::ServiceExt;

pub fn is_mcp_invocation(args: impl IntoIterator<Item = String>) -> bool {
    args.into_iter().skip(1).any(|a| a == "--mcp")
}

/// HTTP-klienterna använder rustls utan inbyggd kryptoleverantör. I appen installeras
/// den av uppdateraren, som inte startar i MCP-läget; utan den panikar första anropet.
/// Anropas där klienterna byggs, så att ingen väg kan glömma den.
pub fn ensure_crypto_provider() {
    let _ = rustls::crypto::ring::default_provider().install_default();
}

pub fn run_stdio() -> i32 {
    let Some(dir) = session::data_dir() else {
        eprintln!("sagt --mcp: hittar ingen datakatalog");
        return 2;
    };
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("sagt --mcp: kunde inte starta: {e}");
            return 1;
        }
    };
    rt.block_on(async move {
        match server::SagtMcp::new(dir).serve(rmcp::transport::stdio()).await {
            Ok(running) => {
                let _ = running.waiting().await;
                0
            }
            Err(e) => {
                eprintln!("sagt --mcp: {e}");
                1
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_flag_after_the_program_name_counts() {
        let v = |xs: &[&str]| xs.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(is_mcp_invocation(v(&["sagt", "--mcp"])));
        assert!(!is_mcp_invocation(v(&["sagt"])));
        assert!(!is_mcp_invocation(v(&["--mcp"])));
        assert!(!is_mcp_invocation(v(&["sagt", "--mcpx"])));
    }
}
