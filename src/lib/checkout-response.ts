// Tolkar svaret från POST /billing/checkout-session. Ren funktion utan Tauri-/store-
// beroenden → enhetstestbar i node, samma skäl som error-slug.ts.

export type CheckoutOutcome =
    | { ok: true; url: string }
    // `code` ur det delade slug-vokabuläret (frontend/lib/analytics.ts ErrorCode).
    | { ok: false; code: "unauthorized" | "unavailable" | "server_error" | "unknown"; message: string };

const GENERIC = "Kunde inte starta betalningen. Försök igen.";

export function interpretCheckoutResponse(status: number, body: unknown): CheckoutOutcome {
    if (status >= 200 && status < 300) {
        const url = (body as { url?: unknown } | null)?.url;
        // Endast https: URL:en öppnas i systemets webbläsare via shell-pluginet, och
        // ett svar utan giltig adress ska bli ett synligt fel, inte en tyst no-op.
        if (typeof url === "string" && url.startsWith("https://")) return { ok: true, url };
        return { ok: false, code: "unknown", message: GENERIC };
    }

    // 401 före `detail`: backendens texter där är engelska ("Token has expired").
    if (status === 401) {
        return { ok: false, code: "unauthorized", message: "Din session är inte längre giltig. Logga in igen för att uppgradera." };
    }

    // Endpointen svarar aldrig 404 själv. En 404 betyder att backenden saknar den —
    // desktop pekar alltid på produktion, även i en testbuild från develop — och
    // FastAPI:s detail är då ett engelskt "Not Found".
    if (status === 404) return { ok: false, code: "unknown", message: GENERIC };

    // FastAPI serialiserar `detail` som en LISTA av objekt vid valideringsfel. Bara en
    // sträng får visas — annars står det "[object Object]" i toasten.
    const detail = (body as { detail?: unknown } | null)?.detail;
    const message = typeof detail === "string" && detail.trim() ? detail : GENERIC;

    if (status === 503) return { ok: false, code: "unavailable", message };
    if (status >= 500) return { ok: false, code: "server_error", message };
    return { ok: false, code: "unknown", message };
}
