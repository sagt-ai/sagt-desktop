import { upsellForProtocolGate, type QuotaLineInput, type UpsellSource } from "./upsell-state";
import type { EntitlementGate } from "./entitlements";

/** Kalendermånaden i UTC ("2026-10"), samma periodnyckel som servern räknar i. */
export function currentPeriod(now: Date): string {
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export type Capture = (event: string, props?: Record<string, unknown>) => void;

/**
 * Ett klick på "Skapa protokoll": vilket fönster som öppnas, eller null när begäran ska
 * skickas. Spärrar klienten själv på en räknare som visar noll når inget anrop servern,
 * och då skickar servern inget `quota_exhausted`. Klienten skickar det i stället, en gång
 * per klick, så att tratten quota_exhausted → upsell_modal_opened → … börjar på samma
 * ställe oavsett vem som spärrade (`origin` skiljer dem åt).
 */
export function protocolClick(
    gate: EntitlementGate,
    quota: QuotaLineInput | null,
    capture: Capture,
    now: Date = new Date(),
): { source: UpsellSource; quota: QuotaLineInput | null } | null {
    const source = upsellForProtocolGate(gate);
    if (!source) return null;
    if (source === 'quota_protocol') {
        // Samma fält som serverns event, plus origin.
        capture('quota_exhausted', {
            kind: 'protocol',
            limit: quota?.limit ?? null,
            used: quota?.used ?? null,
            period: currentPeriod(now),
            plan: 'free',
            origin: 'client',
        });
        // Fönstret ersätter felnotisen; bara eventet, som vid serverns 402.
        capture('error_shown', { surface: 'desktop', code: 'quota_exhausted', kind: 'protocol', action: 'analysis', origin: 'client' });
        return { source, quota };
    }
    return { source, quota: null };
}
