//! Kvoten för MCP-anrop: servern räknar, processen frågar före varje verktygsanrop.
//!
//! Samma mönster som exporten i appen. Ett gratiskonto drar en enhet hos servern per
//! verktygsanrop, med en ny nyckel per anrop. Når processen inte servern dras anropet
//! från serverns signerade förskott, och nyckeln skrivs i en liggare som skickas till
//! servern nästa gång den svarar. Pro räknas aldrig. Signaturen hindrar ett påhittat
//! förskott; den hindrar inte en ändrad klient från att låta bli att stämma av.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::future::Future;
use std::path::{Path, PathBuf};

use super::session::{Session, LEDGER_FILE};

pub const KIND: &str = "mcp_tool_call";
/// Så många nycklar tar servern emot per avstämning.
pub const RECONCILE_CHUNK: usize = 100;
/// Så länge ett besked om Pro från servern gäller innan det hämtas igen.
pub const PRO_RECHECK_SECS: i64 = 30 * 60;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Allowance {
    pub kind: String,
    pub n: i64,
    pub period: String,
    pub exp: i64,
    pub token: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Batch {
    pub allowance: Allowance,
    pub keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct Ledger {
    pub user_id: String,
    pub allowance: Option<Allowance>,
    pub batches: Vec<Batch>,
}

impl Ledger {
    pub fn load(path: &Path, user_id: &str) -> Ledger {
        let l: Ledger = std::fs::read_to_string(path).ok().and_then(|r| serde_json::from_str(&r).ok()).unwrap_or_default();
        if l.user_id == user_id {
            l
        } else {
            // Ett annat konto: dess liggare hör inte hit och skickas inte i det här kontots namn.
            Ledger { user_id: user_id.to_string(), ..Default::default() }
        }
    }

    pub fn save(&self, path: &Path) {
        let tmp = path.with_extension("json.tmp");
        if let Ok(raw) = serde_json::to_string(self) {
            if std::fs::write(&tmp, raw).is_ok() {
                let _ = std::fs::rename(&tmp, path);
            }
        }
    }

    pub fn pending_in(&self, period: &str) -> usize {
        self.batches.iter().filter(|b| b.allowance.period == period).map(|b| b.keys.len()).sum()
    }

    /// Anrop kvar utan nätverk: förskottet minus det som ännu inte stämts av.
    pub fn offline_remaining(&self, now: i64) -> i64 {
        match &self.allowance {
            Some(a) if now < a.exp => (a.n - self.pending_in(&a.period) as i64).max(0),
            _ => 0,
        }
    }

    pub fn draw_offline(&mut self, key: &str, now: i64) -> bool {
        if self.offline_remaining(now) <= 0 {
            return false;
        }
        let a = self.allowance.clone().expect("förskott finns när något återstår");
        match self.batches.iter_mut().find(|b| b.allowance.token == a.token) {
            Some(b) => b.keys.push(key.to_string()),
            None => self.batches.push(Batch { allowance: a, keys: vec![key.to_string()] }),
        }
        true
    }

    pub fn has_pending(&self) -> bool {
        self.batches.iter().any(|b| !b.keys.is_empty())
    }
}

/// Utfallet av ett anrop mot servern.
#[derive(Debug, Clone, PartialEq)]
pub enum Reply {
    Ok(Value),
    Exhausted(Value),
    Unauthorized,
    Error(u16),
    /// Servern gick inte att nå (nätfel, tidsgräns).
    Unreachable,
}

/// Det processen behöver av servern. Byts ut i tester.
pub trait Backend {
    fn consume(&self, s: &Session, key: &str) -> impl Future<Output = Reply> + Send;
    fn reconcile(&self, s: &Session, a: &Allowance, keys: &[String]) -> impl Future<Output = Reply> + Send;
    fn entitlements(&self, s: &Session) -> impl Future<Output = Reply> + Send;
}

#[derive(Debug, Clone, PartialEq)]
pub enum Permit {
    Allowed { offline: bool },
    Exhausted { message: String, used: Option<i64>, limit: Option<i64>, resets_at: Option<String> },
    Denied(String),
}

pub fn allowance_from(body: &Value) -> Option<Allowance> {
    serde_json::from_value(body.get("offline_allowances")?.get(KIND)?.clone()).ok()
}

fn exhausted_from(body: &Value) -> Permit {
    let s = |k: &str| body.get(k).and_then(|v| v.as_str()).map(String::from);
    let i = |k: &str| body.get(k).and_then(|v| v.as_i64());
    let limit = i("limit");
    let detail = s("detail").unwrap_or_else(|| "Dagens MCP-anrop är slut.".into());
    let message = format!(
        "{detail}{} Med Sagt Pro finns inget tak. Uppgradera i appen under Konto.",
        s("resets_at").map(|r| format!(" Kvoten börjar om {r} (UTC).")).unwrap_or_default()
    );
    Permit::Exhausted { message, used: i("used"), limit, resets_at: s("resets_at") }
}

pub struct Quota<B: Backend> {
    backend: B,
    ledger_path: PathBuf,
    /// Pro-status kontrollerad mot servern: (besked, när i Unix-tid). Assistenter håller
    /// processen igång i dagar, så beskedet gäller bara PRO_RECHECK_SECS.
    pro_verified: std::sync::Mutex<Option<(bool, i64)>>,
}

impl<B: Backend> Quota<B> {
    pub fn new(backend: B, dir: &Path) -> Self {
        Quota { backend, ledger_path: dir.join(LEDGER_FILE), pro_verified: std::sync::Mutex::new(None) }
    }

    #[cfg(test)]
    pub fn backend_ref(&self) -> &B {
        &self.backend
    }

    /// Är kontot Pro? Sessionsfilen kan vara upp till en inloggningsperiod gammal, så
    /// planen kontrolleras mot servern en gång per process när servern svarar.
    async fn is_pro(&self, s: &Session, now: i64) -> bool {
        if !s.is_pro() {
            return false;
        }
        if let Some((v, at)) = *self.pro_verified.lock().unwrap() {
            if now - at < PRO_RECHECK_SECS {
                return v;
            }
        }
        let verified = match self.backend.entitlements(s).await {
            Reply::Ok(body) => Some(body.get("plan").and_then(|p| p.as_str()) == Some("pro")),
            _ => None, // går inte att avgöra: lita på appens senaste besked
        };
        if let Some(v) = verified {
            *self.pro_verified.lock().unwrap() = Some((v, now));
            return v;
        }
        // Går inte att avgöra: ett äldre besked från servern går före appens.
        self.pro_verified.lock().unwrap().map(|(v, _)| v).unwrap_or(true)
    }

    async fn reconcile_pending(&self, s: &Session, ledger: &mut Ledger) {
        let batches = ledger.batches.clone();
        for b in batches {
            for chunk in b.keys.chunks(RECONCILE_CHUNK) {
                match self.backend.reconcile(s, &b.allowance, chunk).await {
                    Reply::Ok(body) => {
                        for bb in ledger.batches.iter_mut().filter(|x| x.allowance.token == b.allowance.token) {
                            bb.keys.retain(|k| !chunk.contains(k));
                        }
                        if let Some(a) = allowance_from(&body) {
                            ledger.allowance = Some(a);
                        }
                    }
                    // Nätfel, utgången inloggning eller serverfel: försök igen nästa gång.
                    Reply::Unreachable | Reply::Unauthorized => return,
                    Reply::Error(code) if code >= 500 => return,
                    // Servern avvisade posten (t.ex. ett förskott den inte godtar): släpp
                    // den, annars stoppar den alla senare avstämningar.
                    _ => {
                        for bb in ledger.batches.iter_mut().filter(|x| x.allowance.token == b.allowance.token) {
                            bb.keys.retain(|k| !chunk.contains(k));
                        }
                    }
                }
            }
        }
        ledger.batches.retain(|b| !b.keys.is_empty());
    }

    /// Får verktygsanropet göras? Anropas först när verktyget har ett resultat att lämna,
    /// så att ett felaktigt anrop (okänt id, tom sökning) inte kostar något.
    pub async fn permit(&self, s: &Session, key: &str, now: i64) -> Permit {
        if self.is_pro(s, now).await {
            return Permit::Allowed { offline: false };
        }
        let mut ledger = Ledger::load(&self.ledger_path, &s.user_id);
        if ledger.has_pending() {
            self.reconcile_pending(s, &mut ledger).await;
        }
        let permit = match self.backend.consume(s, key).await {
            Reply::Ok(body) => {
                if let Some(a) = allowance_from(&body) {
                    ledger.allowance = Some(a);
                }
                Permit::Allowed { offline: false }
            }
            Reply::Exhausted(body) => exhausted_from(&body),
            Reply::Unauthorized => Permit::Denied("Inloggningen i Sagt har gått ut. Öppna Sagt så förnyas den, och försök sedan igen.".into()),
            // Ett fel i servern släpps inte igenom på förskottet: det hade gett fria anrop.
            Reply::Error(_) => Permit::Denied("Sagt kunde inte kontrollera kvoten just nu. Försök igen om en stund.".into()),
            Reply::Unreachable => {
                if ledger.draw_offline(key, now) {
                    Permit::Allowed { offline: true }
                } else if ledger.allowance.as_ref().map_or(false, |a| now < a.exp) {
                    Permit::Exhausted {
                        message: "Dagens MCP-anrop utan nätverk är slut. Anslut datorn till internet, eller uppgradera till Sagt Pro som saknar tak.".into(),
                        used: None,
                        limit: None,
                        resets_at: None,
                    }
                } else {
                    Permit::Denied("Sagt når inte servern och har inget sparat utrymme för anrop utan nätverk. Anslut datorn till internet och försök igen.".into())
                }
            }
        };
        ledger.save(&self.ledger_path);
        permit
    }
}

// ─── HTTP ──────────────────────────────────────────────────────────────────

pub struct HttpBackend {
    client: reqwest::Client,
}

impl HttpBackend {
    pub fn new() -> Self {
        super::ensure_crypto_provider();
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .connect_timeout(std::time::Duration::from_secs(4))
            .build()
            .expect("HTTP-klienten går att bygga");
        HttpBackend { client }
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Reply {
        let resp = match req.send().await {
            Ok(r) => r,
            Err(_) => return Reply::Unreachable,
        };
        let status = resp.status().as_u16();
        let body: Value = resp.json().await.unwrap_or(Value::Null);
        match status {
            200 => Reply::Ok(body),
            402 => Reply::Exhausted(body),
            401 => Reply::Unauthorized,
            other => Reply::Error(other),
        }
    }
}

impl Backend for HttpBackend {
    async fn consume(&self, s: &Session, key: &str) -> Reply {
        let req = self.client.post(format!("{}/entitlements/consume", s.api_base)).bearer_auth(&s.token).json(&serde_json::json!({"kind": KIND, "key": key}));
        self.send(req).await
    }

    async fn reconcile(&self, s: &Session, a: &Allowance, keys: &[String]) -> Reply {
        let req = self.client.post(format!("{}/entitlements/reconcile", s.api_base)).bearer_auth(&s.token).json(&serde_json::json!({"allowance": a, "keys": keys}));
        self.send(req).await
    }

    async fn entitlements(&self, s: &Session) -> Reply {
        self.send(self.client.get(format!("{}/entitlements", s.api_base)).bearer_auth(&s.token)).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    struct Fake {
        consume: Mutex<Vec<Reply>>,
        reconcile: Mutex<Vec<Reply>>,
        entitlements: Mutex<Vec<Reply>>,
        log: Mutex<Vec<String>>,
    }

    impl Fake {
        fn new(consume: Vec<Reply>) -> Self {
            Fake { consume: Mutex::new(consume), reconcile: Mutex::new(vec![]), entitlements: Mutex::new(vec![]), log: Mutex::new(vec![]) }
        }
        fn pop(v: &Mutex<Vec<Reply>>) -> Reply {
            let mut v = v.lock().unwrap();
            if v.is_empty() { Reply::Unreachable } else { v.remove(0) }
        }
    }

    impl Backend for Fake {
        async fn consume(&self, _: &Session, key: &str) -> Reply {
            self.log.lock().unwrap().push(format!("consume {key}"));
            Fake::pop(&self.consume)
        }
        async fn reconcile(&self, _: &Session, _: &Allowance, keys: &[String]) -> Reply {
            self.log.lock().unwrap().push(format!("reconcile {}", keys.len()));
            Fake::pop(&self.reconcile)
        }
        async fn entitlements(&self, _: &Session) -> Reply {
            self.log.lock().unwrap().push("entitlements".into());
            Fake::pop(&self.entitlements)
        }
    }

    fn session(plan: &str) -> Session {
        Session { user_id: "u1".into(), token: "t".into(), plan: plan.into(), exp: 10_000, api_base: "http://x".into(), posthog_key: None, posthog_host: None, app_version: None }
    }

    fn dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("sagt-mcp-quota-{}-{}", name, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn ok_with_allowance(n: i64, exp: i64) -> Reply {
        Reply::Ok(json!({"plan": "free", "offline_allowances": {"mcp_tool_call": {"kind": "mcp_tool_call", "n": n, "period": "2026-10-09", "exp": exp, "token": format!("tok{n}")}}}))
    }

    fn rt() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap()
    }

    #[test]
    fn free_online_consumes_and_stores_the_allowance() {
        let d = dir("online");
        let q = Quota::new(Fake::new(vec![ok_with_allowance(9, 5_000)]), &d);
        assert_eq!(rt().block_on(q.permit(&session("free"), "k1", 100)), Permit::Allowed { offline: false });
        let l = Ledger::load(&d.join(LEDGER_FILE), "u1");
        assert_eq!(l.allowance.unwrap().n, 9);
    }

    #[test]
    fn exhausted_carries_the_server_text_and_fields() {
        let d = dir("exhausted");
        let body = json!({"detail": "Du har använt 10 av 10 MCP-anrop i dag.", "used": 10, "limit": 10, "resets_at": "2026-10-10"});
        let q = Quota::new(Fake::new(vec![Reply::Exhausted(body)]), &d);
        match rt().block_on(q.permit(&session("free"), "k1", 100)) {
            Permit::Exhausted { message, used, limit, .. } => {
                assert!(message.starts_with("Du har använt 10 av 10 MCP-anrop i dag."));
                assert!(message.contains("Pro"));
                assert_eq!((used, limit), (Some(10), Some(10)));
            }
            p => panic!("{p:?}"),
        }
    }

    #[test]
    fn offline_draws_from_the_allowance_until_it_is_used_up() {
        let d = dir("offline");
        let q = Quota::new(Fake::new(vec![ok_with_allowance(2, 5_000)]), &d);
        let r = rt();
        assert_eq!(r.block_on(q.permit(&session("free"), "k0", 100)), Permit::Allowed { offline: false });
        // Servern svarar inte längre.
        assert_eq!(r.block_on(q.permit(&session("free"), "k1", 100)), Permit::Allowed { offline: true });
        assert_eq!(r.block_on(q.permit(&session("free"), "k2", 100)), Permit::Allowed { offline: true });
        assert!(matches!(r.block_on(q.permit(&session("free"), "k3", 100)), Permit::Exhausted { .. }));
        let l = Ledger::load(&d.join(LEDGER_FILE), "u1");
        assert_eq!(l.pending_in("2026-10-09"), 2);
    }

    #[test]
    fn expired_allowance_or_none_denies_offline() {
        let d = dir("expired");
        let q = Quota::new(Fake::new(vec![ok_with_allowance(5, 200)]), &d);
        let r = rt();
        r.block_on(q.permit(&session("free"), "k0", 100));
        assert!(matches!(r.block_on(q.permit(&session("free"), "k1", 200)), Permit::Denied(_)));
        let d2 = dir("none");
        let q2 = Quota::new(Fake::new(vec![]), &d2);
        assert!(matches!(r.block_on(q2.permit(&session("free"), "k1", 100)), Permit::Denied(_)));
    }

    #[test]
    fn server_error_is_not_let_through_on_the_allowance() {
        let d = dir("servererr");
        let q = Quota::new(Fake::new(vec![ok_with_allowance(5, 5_000), Reply::Error(500)]), &d);
        let r = rt();
        r.block_on(q.permit(&session("free"), "k0", 100));
        assert!(matches!(r.block_on(q.permit(&session("free"), "k1", 100)), Permit::Denied(_)));
        assert_eq!(Ledger::load(&d.join(LEDGER_FILE), "u1").pending_in("2026-10-09"), 0);
    }

    #[test]
    fn pending_keys_are_reconciled_before_the_next_consume() {
        let d = dir("reconcile");
        let fake = Fake::new(vec![ok_with_allowance(3, 5_000), Reply::Unreachable, ok_with_allowance(1, 5_000)]);
        *fake.reconcile.lock().unwrap() = vec![ok_with_allowance(2, 5_000)];
        let q = Quota::new(fake, &d);
        let r = rt();
        r.block_on(q.permit(&session("free"), "k0", 100));
        assert_eq!(r.block_on(q.permit(&session("free"), "k1", 100)), Permit::Allowed { offline: true });
        assert_eq!(r.block_on(q.permit(&session("free"), "k2", 100)), Permit::Allowed { offline: false });
        let log = q.backend.log.lock().unwrap().clone();
        assert_eq!(log, ["consume k0", "consume k1", "reconcile 1", "consume k2"]);
        assert!(!Ledger::load(&d.join(LEDGER_FILE), "u1").has_pending());
    }

    #[test]
    fn unreachable_reconcile_keeps_the_keys() {
        let d = dir("keepkeys");
        let q = Quota::new(Fake::new(vec![ok_with_allowance(3, 5_000)]), &d);
        let r = rt();
        r.block_on(q.permit(&session("free"), "k0", 100));
        r.block_on(q.permit(&session("free"), "k1", 100));
        r.block_on(q.permit(&session("free"), "k2", 100));
        assert_eq!(Ledger::load(&d.join(LEDGER_FILE), "u1").pending_in("2026-10-09"), 2);
    }

    #[test]
    fn pro_is_verified_once_and_never_consumes() {
        let d = dir("pro");
        let fake = Fake::new(vec![]);
        *fake.entitlements.lock().unwrap() = vec![Reply::Ok(json!({"plan": "pro"}))];
        let q = Quota::new(fake, &d);
        let r = rt();
        for k in ["a1", "a2", "a3"] {
            assert_eq!(r.block_on(q.permit(&session("pro"), k, 100)), Permit::Allowed { offline: false });
        }
        assert_eq!(q.backend.log.lock().unwrap().clone(), ["entitlements"]);
    }

    #[test]
    fn pro_is_checked_again_after_the_recheck_interval() {
        let d = dir("prorecheck");
        let fake = Fake::new(vec![Reply::Exhausted(json!({"detail": "slut", "limit": 10, "used": 10}))]);
        *fake.entitlements.lock().unwrap() = vec![Reply::Ok(json!({"plan": "pro"})), Reply::Ok(json!({"plan": "free"}))];
        let q = Quota::new(fake, &d);
        let r = rt();
        assert_eq!(r.block_on(q.permit(&session("pro"), "a1", 100)), Permit::Allowed { offline: false });
        assert_eq!(r.block_on(q.permit(&session("pro"), "a2", 100 + PRO_RECHECK_SECS - 1)), Permit::Allowed { offline: false });
        // Prenumerationen har sagts upp: nästa kontroll ger free, och anropet räknas.
        assert!(matches!(r.block_on(q.permit(&session("pro"), "a3", 100 + PRO_RECHECK_SECS)), Permit::Exhausted { .. }));
    }

    #[test]
    fn stale_pro_in_the_session_file_is_counted_as_free() {
        let d = dir("stalepro");
        let fake = Fake::new(vec![Reply::Exhausted(json!({"detail": "slut", "limit": 10, "used": 10}))]);
        *fake.entitlements.lock().unwrap() = vec![Reply::Ok(json!({"plan": "free"}))];
        let q = Quota::new(fake, &d);
        assert!(matches!(rt().block_on(q.permit(&session("pro"), "k1", 100)), Permit::Exhausted { .. }));
    }

    #[test]
    fn another_accounts_ledger_is_ignored() {
        let d = dir("otheruser");
        let p = d.join(LEDGER_FILE);
        let mut l = Ledger { user_id: "other".into(), allowance: None, batches: vec![] };
        l.allowance = Some(Allowance { kind: KIND.into(), n: 5, period: "p".into(), exp: 9_999, token: "t".into() });
        l.save(&p);
        assert_eq!(Ledger::load(&p, "u1").offline_remaining(100), 0);
    }
}
