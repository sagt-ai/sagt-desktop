// Exportkvoten: om en export får göras, och bokföringen av exporter som görs utan nätverk.
// Ren modul (lagringen och anropen skickas in), så att besluten kan testas i node.
//
// Exporten renderas i appen. Ett gratiskonto drar därför en enhet hos servern innan
// filen sparas, med en nyckel per avsiktlig export. Utan nätverk drar appen i stället av
// från serverns signerade förskott och skriver nyckeln i en liggare, som skickas till
// servern när appen är online igen. Pro räknas aldrig och anropar ingenting.
import type { EntitlementCallOutcome } from "@/lib/api";
import type { EntitlementGate, EntitlementsResponse, OfflineAllowance, QuotaCounter } from "@/lib/entitlements";
import type { QuotaLineInput, UpsellSource } from "@/lib/upsell-state";

/** Det appen behöver av localStorage. Varje åtkomst kan kasta (blockerad lagring). */
export interface KeyValueStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

/** Exporter gjorda utan nätverk mot ett och samma förskott. */
export interface LedgerBatch {
    userId: string;
    allowance: OfflineAllowance;
    keys: string[];
}

interface LedgerData {
    /** Senaste förskottet per konto. Sparas så att det finns kvar efter en omstart utan nätverk. */
    allowances: Record<string, OfflineAllowance>;
    batches: LedgerBatch[];
}

export const LEDGER_STORAGE_KEY = "sagt.export-ledger.v1";
/** Så många nycklar tar servern emot per avstämning. */
export const RECONCILE_CHUNK = 100;

const empty = (): LedgerData => ({ allowances: {}, batches: [] });

function isAllowance(a: unknown): a is OfflineAllowance {
    const x = a as Record<string, unknown> | null;
    return !!x && typeof x.kind === "string" && typeof x.n === "number" && typeof x.period === "string"
        && typeof x.exp === "number" && typeof x.token === "string";
}

function parseLedger(raw: string | null): LedgerData {
    if (!raw) return empty();
    try {
        const d = JSON.parse(raw);
        const allowances: Record<string, OfflineAllowance> = {};
        for (const [user, a] of Object.entries(d?.allowances ?? {})) if (isAllowance(a)) allowances[user] = a;
        const batches = Array.isArray(d?.batches)
            ? (d.batches as unknown[]).filter((b): b is LedgerBatch => {
                const x = b as Record<string, unknown> | null;
                return !!x && typeof x.userId === "string" && isAllowance(x.allowance)
                    && Array.isArray(x.keys) && x.keys.every(k => typeof k === "string");
            })
            : [];
        return { allowances, batches };
    } catch {
        return empty();
    }
}

/**
 * Förskottet och liggaren, i localStorage med en kopia i minnet. Kastar lagringen (blockerad,
 * full) fortsätter appen på minneskopian under sessionen i stället för att krascha.
 */
export class ExportLedger {
    private memory: LedgerData | null = null;
    /** Senaste skrivningen till lagringen misslyckades: minneskopian är nyare än lagringen. */
    private unsaved = false;

    constructor(private readonly storage: () => KeyValueStorage | null | undefined) {}

    private read(): LedgerData {
        // Gick lagringen att läsa men inte att skriva (full), är det som står där inaktuellt.
        if (this.unsaved && this.memory) return this.memory;
        try {
            const s = this.storage();
            if (s) {
                const d = parseLedger(s.getItem(LEDGER_STORAGE_KEY));
                this.memory = d;
                return d;
            }
        } catch (e) {
            console.warn("[export] liggaren gick inte att läsa:", e);
        }
        return this.memory ?? empty();
    }

    private write(d: LedgerData): void {
        this.memory = d;
        try {
            const s = this.storage();
            if (s) {
                s.setItem(LEDGER_STORAGE_KEY, JSON.stringify(d));
                this.unsaved = false;
            } else {
                this.unsaved = true;
            }
        } catch (e) {
            this.unsaved = true;
            console.warn("[export] liggaren gick inte att spara:", e);
        }
    }

    /** Spara kontots senaste förskott (eller glöm det, för Pro och när det saknas). */
    rememberAllowance(userId: string, allowance: OfflineAllowance | null): void {
        const d = this.read();
        if (allowance) d.allowances[userId] = allowance;
        else delete d.allowances[userId];
        this.write(d);
    }

    allowanceFor(userId: string): OfflineAllowance | null {
        return this.read().allowances[userId] ?? null;
    }

    /** Exporter kvar utan nätverk: förskottet minus det som ännu inte stämts av, i samma period. */
    offlineRemaining(userId: string, now: Date): number {
        const d = this.read();
        const a = d.allowances[userId];
        if (!a || now.getTime() / 1000 >= a.exp) return 0;
        const pending = d.batches
            .filter(b => b.userId === userId && b.allowance.period === a.period)
            .reduce((n, b) => n + b.keys.length, 0);
        return Math.max(0, a.n - pending);
    }

    /**
     * Dra en export från förskottet och skriv nyckeln i liggaren. Samma nyckel igen (ett
     * omförsök) drar inget nytt. False när förskottet saknas, gått ut eller är slut.
     */
    drawOffline(userId: string, key: string, now: Date): boolean {
        if (this.hasKey(userId, key)) return true;
        if (this.offlineRemaining(userId, now) <= 0) return false;
        const d = this.read();
        const a = d.allowances[userId];
        let batch = d.batches.find(b => b.userId === userId && b.allowance.token === a.token);
        if (!batch) {
            batch = { userId, allowance: a, keys: [] };
            d.batches.push(batch);
        }
        batch.keys.push(key);
        this.write(d);
        return true;
    }

    hasKey(userId: string, key: string): boolean {
        return this.read().batches.some(b => b.userId === userId && b.keys.includes(key));
    }

    /** Antal exporter i perioden som dragits från förskottet och ännu inte stämts av. */
    pendingCount(userId: string, period: string): number {
        return this.read().batches
            .filter(b => b.userId === userId && b.allowance.period === period)
            .reduce((n, b) => n + b.keys.length, 0);
    }

    /** Liggarens poster för kontot som väntar på avstämning. */
    pending(userId: string): LedgerBatch[] {
        return this.read().batches.filter(b => b.userId === userId && b.keys.length > 0);
    }

    /** Ta bort nycklar som servern bekräftat. Rör bara den post de hörde till. */
    removeKeys(userId: string, token: string, keys: string[]): void {
        const done = new Set(keys);
        const d = this.read();
        for (const b of d.batches) {
            if (b.userId === userId && b.allowance.token === token) b.keys = b.keys.filter(k => !done.has(k));
        }
        d.batches = d.batches.filter(b => b.keys.length > 0);
        this.write(d);
    }
}

// ─── Om en export får göras ────────────────────────────────────────────────────

export type ConsumeCall = (key: string, token: string) => Promise<EntitlementCallOutcome>;

export type ExportPermit =
    | { ok: true; via: "pro" | "online" | "offline" }
    | { ok: false; reason: "sign_in" }
    | { ok: false; reason: "quota_exhausted"; origin: "server" | "offline"; quota: QuotaLineInput | null }
    | { ok: false; reason: "offline_no_allowance" }
    | { ok: false; reason: "error"; status: number; detail: string };

/**
 * Får exporten göras? Anropas när användaren trycker Exportera, innan "Spara som".
 *  - Utloggad: nej, konto först.
 *  - Pro: ja, utan anrop.
 *  - Gratiskonto: servern drar en enhet (200 → ja, 402 → kvoten slut). Når appen inte
 *    servern dras exporten från förskottet i stället. Andra svar är fel: de släpps inte
 *    igenom på förskottet, eftersom ett fel i servern annars gav fria exporter.
 */
export async function permitExport(o: {
    isSignedIn: boolean;
    isPro: boolean;
    userId: string | null;
    token: string | null;
    key: string;
    consume: ConsumeCall;
    ledger: ExportLedger;
    /** Serverns svar efter en lyckad förbrukning: nya räknare och nytt förskott. */
    onBody?: (body: EntitlementsResponse) => void;
    now?: Date;
}): Promise<ExportPermit> {
    if (!o.isSignedIn || !o.token || !o.userId) return { ok: false, reason: "sign_in" };
    if (o.isPro) return { ok: true, via: "pro" };

    let outcome: EntitlementCallOutcome;
    try {
        outcome = await o.consume(o.key, o.token);
    } catch {
        // Servern gick inte att nå: förskottet.
        const now = o.now ?? new Date();
        if (o.ledger.drawOffline(o.userId, o.key, now)) return { ok: true, via: "offline" };
        const a = o.ledger.allowanceFor(o.userId);
        if (!a || now.getTime() / 1000 >= a.exp) return { ok: false, reason: "offline_no_allowance" };
        return { ok: false, reason: "quota_exhausted", origin: "offline", quota: null };
    }

    if (outcome.kind === "ok") {
        o.onBody?.(outcome.body);
        return { ok: true, via: "online" };
    }
    if (outcome.kind === "exhausted") {
        const q = outcome.quota;
        return {
            ok: false, reason: "quota_exhausted", origin: "server",
            quota: q && q.limit > 0 ? { used: q.used, limit: q.limit, resets_at: q.resets_at } : null,
        };
    }
    return { ok: false, reason: "error", status: outcome.status, detail: outcome.detail };
}

// ─── Avstämningen ──────────────────────────────────────────────────────────────

export type ReconcileCall = (allowance: OfflineAllowance, keys: string[], token: string) => Promise<EntitlementCallOutcome>;

/**
 * Skicka liggaren till servern, högst RECONCILE_CHUNK nycklar per anrop. Nycklarna tas
 * bort ur liggaren först när servern svarat 200; vid nätfel eller annat svar ligger de
 * kvar till nästa försök (servern räknar varje nyckel en gång, så ett omförsök drar inget
 * dubbelt). Avvisar servern en post (4xx utom 401) prövas nästa post ändå, så att en post
 * som aldrig går igenom inte stoppar de andra. Nätfel, 401 och serverfel avbryter: då når
 * ingen post fram. Returnerar antalet bekräftade nycklar.
 */
export async function reconcileOffline(o: {
    userId: string;
    token: string;
    ledger: ExportLedger;
    call: ReconcileCall;
    onBody?: (body: EntitlementsResponse) => void;
}): Promise<number> {
    let confirmed = 0;
    batches: for (const batch of o.ledger.pending(o.userId)) {
        for (let i = 0; i < batch.keys.length; i += RECONCILE_CHUNK) {
            const keys = batch.keys.slice(i, i + RECONCILE_CHUNK);
            let outcome: EntitlementCallOutcome;
            try {
                outcome = await o.call(batch.allowance, keys, o.token);
            } catch {
                return confirmed; // offline igen: försök senare
            }
            if (outcome.kind !== "ok") {
                const status = outcome.kind === "error" ? outcome.status : 402;
                console.warn("[export] avstämningen avvisades:", status);
                if (status === 401 || status >= 500) return confirmed;
                continue batches;
            }
            o.ledger.removeKeys(o.userId, batch.allowance.token, keys);
            o.onBody?.(outcome.body);
            confirmed += keys.length;
        }
    }
    return confirmed;
}

// ─── Klicket på Exportera ──────────────────────────────────────────────────────

export type Capture = (event: string, props?: Record<string, unknown>) => void;

/** Kalendermånaden i UTC ("2026-10"), samma period som servern räknar i. */
export function currentPeriod(now: Date): string {
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Skicka klientens `quota_exhausted` för exporten (samma fält som serverns, plus origin). */
export function captureExportExhausted(capture: Capture, quota: QuotaLineInput | null, origin: "client" | "offline", now: Date = new Date()): void {
    capture("quota_exhausted", {
        kind: "export",
        limit: quota?.limit ?? null,
        used: quota?.used ?? null,
        period: currentPeriod(now),
        plan: "free",
        origin,
    });
    capture("error_shown", { surface: "desktop", code: "quota_exhausted", kind: "export", action: "export", origin });
}

/**
 * Ett klick på Exportera (transkriptvyn eller Inspelningar): vilket fönster som öppnas, eller
 * null när exportdialogen ska visas. Pro och gratiskontot med exporter kvar öppnar aldrig
 * fönstret. Spärrar klienten själv på en räknare som visar noll skickas `quota_exhausted`
 * härifrån, eftersom inget anrop når servern.
 */
export function exportClick(
    gate: EntitlementGate,
    quota: QuotaLineInput | null,
    capture: Capture,
    now: Date = new Date(),
): { source: UpsellSource; quota: QuotaLineInput | null } | null {
    if (gate === "sign_in") return { source: "export", quota: null };
    if (gate === "quota_exhausted") {
        captureExportExhausted(capture, quota, "client", now);
        return { source: "quota_export", quota };
    }
    return null;
}

// ─── Räknaren i exportdialogen ─────────────────────────────────────────────────

/** Det exportdialogen visar: "9 av 10 exporter kvar den här månaden". */
export interface ExportCounterView {
    remaining: number;
    limit: number;
}

/**
 * Räknaren i exportdialogen ur den synliga räknaren (null för utloggad, Pro, ej hämtad och
 * slut period, se visibleCounter i entitlements-store). Exporter som dragits från förskottet
 * men inte stämts av dras av lokalt, så att räknaren inte står still efter en export utan
 * nätverk. Serverns räknare tar med dem först efter avstämningen, och då är de borta ur
 * liggaren.
 */
export function exportCounterView(o: {
    counter: QuotaCounter | null;
    /** Exporter i räknarens period som väntar på avstämning (ExportLedger.pendingCount). */
    pendingOffline: number;
}): ExportCounterView | null {
    if (!o.counter) return null;
    return {
        remaining: Math.max(0, o.counter.remaining - Math.max(0, o.pendingOffline)),
        limit: o.counter.limit,
    };
}

/** Raden i dialogen, i samma form som protokollräknaren i panelen. */
export function exportCounterText(c: ExportCounterView): string {
    return `${c.remaining} av ${c.limit} exporter kvar den här månaden`;
}
