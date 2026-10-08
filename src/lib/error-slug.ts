import { AnalyzeHttpError } from "./entitlements";

// Stabil slug-vokabulär — DELAD med frontend (frontend/lib/analytics.ts) och backend
// (error_shown-events). Ren funktion utan Tauri-/store-beroenden → enhetstestbar i node.
//
// Matchar på MEDDELANDEINNEHÅLL, inte bara prefix: api.ts-fel kastas som strängar och
// statuskoden är borta efter throw. En 429 från uploadJob kommer t.ex. som
// "Kunde inte ladda upp: Hastighetsgräns nådd..." UTAN Quota-prefix → måste matchas på texten.
export function errorSlug(error: unknown): string {
    // Gratiskvoten slut: servern säger det i svarets fält, inte i en text att matcha på.
    // Före texterna, eftersom 402-meddelandet också börjar med "Payment Required".
    if (error instanceof AnalyzeHttpError && error.quota) return "quota_exhausted";
    const msg = error instanceof Error ? error.message : String(error ?? "");
    if (/^Unauthorized|session är inte längre giltig/i.test(msg)) return "unauthorized";
    if (/Payment Required|aktiv Pro|kräver Pro/i.test(msg)) return "not_pro";
    if (/^För stort/i.test(msg)) return "file_too_large";
    // Skilj timspärr (anti-abuse, "vänta") från månadskvot (usage-cap, "uppgradera"):
    if (/Hastighetsgräns/i.test(msg)) return "rate_limited";
    if (/Quota|Månadsgräns/i.test(msg)) return "quota_exceeded";
    if (/Otillgänglig/i.test(msg)) return "unavailable";
    if (/internetanslutning|offline/i.test(msg)) return "offline";
    if (/raderad/i.test(msg)) return "audio_deleted";
    return "unknown";
}

/**
 * Serverns felkod, till exempel "(llm_upstream)", står sist i svarets text så att den syns i
 * loggen och i analysen av felen. Användaren har ingen nytta av den, så den tas bort ur det
 * som visas. Bara en avslutande kod i formen (gemener_med_understreck) tas bort.
 */
export function withoutErrorCode(message: string): string {
    return message.replace(/\s*\([a-z]+(?:_[a-z]+)+\)\s*$/, "");
}
