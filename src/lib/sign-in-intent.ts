import type { UpsellSource } from "./upsell-state";

/**
 * Varför användaren loggade in, för `sign_in_completed`. Sätts av inloggningen i
 * webbläsaren (lib/browser-auth.ts) i samma ögonblick som den lyckas, ur avsikterna hos
 * alla som väntade på den, och läses när sessionen landar i appen.
 *  - `free`: "Skapa gratiskonto / logga in" eller "Logga in", utan köp.
 *  - `upgrade`: "Uppgradera nu" utan konto; köpet fortsätter efter inloggningen.
 * `source` är fönstrets källa eller panelens knapp, så att tratten går att följa per rätt.
 */
export type SignInIntent = "free" | "upgrade";

/** Var inloggningen startades: fönstrets källa, eller "Logga in"-knappen i panelen. */
export type SignInSource = UpsellSource | "sign_in_button";

/** Avsikten hör till inloggningen som just lyckades; en äldre hör inte dit. */
export const SIGN_IN_INTENT_TTL_MS = 60_000;

let pending: { intent: SignInIntent; source: SignInSource; at: number } | null = null;

export function setSignInIntent(intent: SignInIntent, source: SignInSource, now: number = Date.now()): void {
    pending = { intent, source, at: now };
}

export function clearSignInIntent(): void {
    pending = null;
}

/** Läser och tömmer. En inloggning räknas en gång, och bara inom tidsfönstret. */
export function consumeSignInIntent(now: number = Date.now()): { intent: SignInIntent; source: SignInSource } | null {
    const p = pending;
    pending = null;
    if (!p || now - p.at > SIGN_IN_INTENT_TTL_MS) return null;
    return { intent: p.intent, source: p.source };
}
