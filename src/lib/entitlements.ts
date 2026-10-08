// Gratiskvoter och Pro, sett från klienten. Ren modul utan Tauri-, React- eller
// store-beroenden, så att besluten kan tabelltestas i node (vitest.config.ts).
//
// Servern är auktoritativ: den räknar varje protokoll och svarar 402 när kvoten är slut.
// Klienten speglar räknaren för att kunna visa "2 av 3 kvar" och öppna
// uppgraderingsfönstret direkt när det är tomt, i stället för att skicka texten först.

/** En rätt med gratiskvot, som servern räknar den. */
export interface QuotaCounter {
    limit: number;
    used: number;
    remaining: number;
    period?: string;
    resets_at?: string | null;
}

/**
 * Serverns förskott för export utan nätverk: hur många exporter klienten får göra offline
 * i perioden, signerat av servern. Klienten kan inte höja `n` utan att signaturen slutar
 * stämma, och exporterna bokförs hos servern när appen är online igen.
 */
export interface OfflineAllowance {
    kind: string;
    n: number;
    period: string;
    /** Förskottets sista giltiga sekund (Unix-tid, periodens slut). */
    exp: number;
    token: string;
}

/** Svaret från GET /entitlements (och från förbrukning och avstämning). Pro har inga räknare. */
export interface EntitlementsResponse {
    plan: "free" | "pro";
    counters: Record<string, QuotaCounter>;
    offline_allowance: OfflineAllowance | null;
}

/** Förskottet ur ett svar, eller null om det saknas eller har fel form. */
export function parseAllowance(raw: unknown): OfflineAllowance | null {
    const a = raw as Record<string, unknown> | null;
    if (!a || typeof a !== "object") return null;
    if (typeof a.kind !== "string" || typeof a.period !== "string" || typeof a.token !== "string") return null;
    if (typeof a.n !== "number" || typeof a.exp !== "number" || !Number.isFinite(a.n) || !Number.isFinite(a.exp)) return null;
    return { kind: a.kind, n: a.n, period: a.period, exp: a.exp, token: a.token };
}

/** Svarskroppen som planen, räknarna och förskottet. Okända former blir tomma. */
export function parseEntitlements(data: unknown): EntitlementsResponse {
    const d = data as Record<string, unknown> | null;
    return {
        plan: d?.plan === "pro" ? "pro" : "free",
        counters: d?.counters && typeof d.counters === "object" ? d.counters as Record<string, QuotaCounter> : {},
        offline_allowance: parseAllowance(d?.offline_allowance),
    };
}

/**
 * Det klienten grindar på.
 *  - `protocol`: AI-protokoll på texten. Gratiskonto med kvot, Pro obegränsat.
 *  - `export`: filexport (alla format; flera möten i en zip räknas som en). Gratiskonto
 *    med kvot, Pro obegränsat.
 *  - `template`: protokollmallar utöver standardmallen. Bara Pro.
 */
export type EntitlementKind = "protocol" | "export" | "template";

/** Utfallet av en grind: släpp igenom, be om inloggning, eller visa kvotraden. */
export type EntitlementGate = "allowed" | "sign_in" | "quota_exhausted";

export interface GateInput {
    isSignedIn: boolean;
    isPro: boolean;
    /** Räknaren för rätten, om den hämtats. Saknas den bestämmer servern. */
    counter?: QuotaCounter | null;
    /** Nu, för att känna igen en räknare från en period som redan tagit slut. */
    now?: Date;
}

export function entitlementGate(kind: EntitlementKind, f: GateInput): EntitlementGate {
    if (!f.isSignedIn) return "sign_in";
    if (f.isPro) return "allowed";
    if (kind === "template") return "quota_exhausted";
    // Ej hämtad räknare (offline vid inloggning, första sekunden): låt servern avgöra.
    // Ett 402 öppnar då samma fönster, en sekund senare.
    if (!f.counter) return "allowed";
    // En räknare från en period som tagit slut (appen öppen över månadsskiftet) säger
    // ingenting om den nya perioden. Servern avgör.
    if (periodEnded(f.counter, f.now ?? new Date())) return "allowed";
    return f.counter.remaining > 0 ? "allowed" : "quota_exhausted";
}

/** True när räknarens period är slut (`resets_at` är dagen den nollställs, UTC). */
export function periodEnded(counter: QuotaCounter, now: Date): boolean {
    if (!counter.resets_at) return false;
    const reset = Date.parse(`${counter.resets_at}T00:00:00Z`);
    return Number.isFinite(reset) && now.getTime() >= reset;
}

// ─── Svar som inte är 200 ────────────────────────────────────────────────────────

/** Kvotens fält i ett 402 med `code: "quota_exhausted"`. */
export interface QuotaExhaustedInfo {
    kind: string;
    limit: number;
    used: number;
    resets_at: string | null;
}

/**
 * Fel från protokollanropet med det klienten behöver för att välja väg: status, serverns
 * `code` och kvotfält, och konfliktkoden vid 409. Meddelandet behåller formerna
 * "Unauthorized: …" och "Payment Required: …" som övriga felvägar redan läser.
 */
export class AnalyzeHttpError extends Error {
    constructor(
        message: string,
        readonly status: number,
        readonly detail: string,
        readonly quota: QuotaExhaustedInfo | null,
        readonly conflict: ConflictCode | null,
    ) {
        super(message);
        this.name = "AnalyzeHttpError";
    }
}

export type ConflictCode = "request_in_progress" | "idempotency_key_reused";

/**
 * Vilken sorts 409. Servern skickar `X-Error-Code` och exponerar det för webbvyn
 * (uppmätt 2026-10-06: produktionens CORS-svar har `access-control-expose-headers:
 * X-Error-Code`), så svarshuvudet avgör. Texten i `detail` är reserven om huvudet saknas.
 */
export function conflictCode(header: string | null, detail: string): ConflictCode | null {
    if (header === "request_in_progress" || header === "idempotency_key_reused") return header;
    if (/pågår/i.test(detail)) return "request_in_progress";
    if (/redan använd|ny nyckel/i.test(detail)) return "idempotency_key_reused";
    return null;
}

/** Kvotfälten ur ett 402-svar, eller null för ett 402 utan dem ("Pro krävs"). */
export function parseQuotaExhausted(body: unknown): QuotaExhaustedInfo | null {
    const b = body as Record<string, unknown> | null;
    if (!b || b.code !== "quota_exhausted" || typeof b.kind !== "string") return null;
    return {
        kind: b.kind,
        limit: typeof b.limit === "number" ? b.limit : 0,
        used: typeof b.used === "number" ? b.used : 0,
        resets_at: typeof b.resets_at === "string" ? b.resets_at : null,
    };
}

/** Bygger felet ur status, svarshuvud och kropp. Ren funktion, så att den kan testas. */
export function analyzeErrorFrom(status: number, errorCodeHeader: string | null, bodyText: string): AnalyzeHttpError {
    let body: unknown = null;
    let detail = bodyText;
    try {
        body = JSON.parse(bodyText);
        const d = (body as { detail?: unknown })?.detail;
        if (typeof d === "string") detail = d;
    } catch { /* inte JSON: detail är råtexten */ }

    const quota = status === 402 ? parseQuotaExhausted(body) : null;
    const conflict = status === 409 ? conflictCode(errorCodeHeader, detail) : null;
    let message: string;
    if (status === 401) message = `Unauthorized: ${detail}`;
    else if (status === 402) message = quota ? `Payment Required: ${detail}` : "Payment Required: Denna funktion kräver Pro. Vänligen uppgradera via webbportalen.";
    else if (status === 413) message = `För stort: ${detail}`;
    else message = `Re-analys misslyckades: ${detail}`;
    return new AnalyzeHttpError(message, status, detail, quota, conflict);
}

// ─── Idempotensnyckeln ───────────────────────────────────────────────────────────

/**
 * En nyckel per avsiktlig begäran. Ett omförsök av SAMMA begäran (samma text och mall,
 * efter ett nätfel eller ett serverfel) återanvänder nyckeln, så att ett svar som gick
 * förlorat inte drar ett protokoll till. En lyckad begäran förbrukar nyckeln: nästa klick
 * på "Analysera igen" är en ny begäran.
 */
export class IdempotencyKeys {
    // En nyckel per begäran (mall + text), så att två begäranden som pågår samtidigt
    // (två inspelningar) inte tar varandras nycklar. Få poster: de släpps vid lyckat svar.
    private pending = new Map<string, string>();
    private static readonly MAX_PENDING = 20;

    constructor(private readonly newKey: () => string = () => crypto.randomUUID()) {}

    private static id(text: string, templateId: string): string {
        return `${templateId}\u0000${text}`;
    }

    keyFor(text: string, templateId: string): string {
        return this.pending.get(IdempotencyKeys.id(text, templateId)) ?? this.renew(text, templateId);
    }

    renew(text: string, templateId: string): string {
        const key = this.newKey();
        const id = IdempotencyKeys.id(text, templateId);
        this.pending.delete(id);
        this.pending.set(id, key);
        // Äldsta först ut: en begäran som aldrig lyckats ska inte hålla minnet för evigt.
        while (this.pending.size > IdempotencyKeys.MAX_PENDING) {
            this.pending.delete(this.pending.keys().next().value as string);
        }
        return key;
    }

    done(text: string, templateId: string): void {
        this.pending.delete(IdempotencyKeys.id(text, templateId));
    }
}

export type AnalyzeCall = (text: string, templateId: string, token: string, opts: { idempotencyKey: string }) => Promise<any>;

/** Väntetider medan en begäran med samma nyckel redan pågår hos servern: totalt ~30 s. */
export const IN_PROGRESS_DELAYS_MS = [2000, 4000, 8000, 16000];

/**
 * Skapa ett protokoll med idempotensnyckel och de omförsök servern ber om:
 *  - 409 `request_in_progress`: vänta och försök igen med samma nyckel (en ny nyckel
 *    hade dragit ett protokoll till).
 *  - 409 `idempotency_key_reused`: nyckeln hör till en annan begäran. Ny nyckel, ett försök.
 * Allt annat kastas till anroparen. Nyckeln står kvar efter ett fel, så att användarens
 * nästa försök med samma text blir ett omförsök och inte en ny förbrukning.
 */
export async function requestProtocol(opts: {
    text: string;
    templateId: string;
    token: string;
    keys: IdempotencyKeys;
    call: AnalyzeCall;
    sleep?: (ms: number) => Promise<void>;
}): Promise<any> {
    const { text, templateId, token, keys, call } = opts;
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
    let key = keys.keyFor(text, templateId);
    let waits = 0;
    let renewed = false;
    for (;;) {
        try {
            const result = await call(text, templateId, token, { idempotencyKey: key });
            keys.done(text, templateId);
            return result;
        } catch (e) {
            if (e instanceof AnalyzeHttpError && e.status === 409) {
                if (e.conflict === "request_in_progress" && waits < IN_PROGRESS_DELAYS_MS.length) {
                    await sleep(IN_PROGRESS_DELAYS_MS[waits++]);
                    continue;
                }
                if (e.conflict === "idempotency_key_reused" && !renewed) {
                    renewed = true;
                    key = keys.renew(text, templateId);
                    continue;
                }
                // Nyckeln duger inte ens efter förnyelsen: släpp den, så att nästa försök
                // börjar om med en ny i stället för att få samma svar igen. Pågår begäran
                // fortfarande står nyckeln kvar: ett senare försök får då svaret utan ny
                // förbrukning.
                if (e.conflict !== "request_in_progress") keys.done(text, templateId);
            }
            throw e;
        }
    }
}
