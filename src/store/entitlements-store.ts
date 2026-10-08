import { create } from "zustand";
import { consumeEntitlement, getEntitlements, reconcileEntitlements } from "@/lib/api";
import { entitlementGate, periodEnded, type EntitlementGate, type EntitlementKind, type EntitlementsResponse, type QuotaCounter, type QuotaExhaustedInfo } from "@/lib/entitlements";
import { currentPeriod, ExportLedger, exportCounterView, permitExport, reconcileOffline, type ExportCounterView, type ExportPermit } from "@/lib/export/quota";
import { isProStatus, useAuthStore } from "@/store/auth-store";

/**
 * Gratiskvoternas räknare för det inloggade kontot, speglade från servern.
 *
 * Hämtas vid inloggning, vid varje sessionsförnyelse (båda går via setSession i
 * auth-store, se startEntitlementsSync) och efter varje förbrukning. Sparas inte på disk:
 * räknaren är en visning, servern är den som räknar. Offline står den senast hämtade
 * kvar, eller ingen alls, och då avgör servern vid nästa anrop.
 *
 * Det här är det enda stället som avgör om en rätt med gratiskvot är tillgänglig.
 * Komponenter frågar `entitled(kind)` eller `useEntitlement(kind)`, aldrig Pro-status
 * direkt (testet entitlement-gates.test.ts fäller nya sådana kontroller för protokollet).
 */
interface EntitlementsState {
    counters: Record<string, QuotaCounter>;
    /** Kontot räknarna hör till, så att ett svar för ett tidigare konto inte skriver över. */
    userId: string | null;

    refresh: () => Promise<void>;
    /**
     * Lägg in serverns svar (hämtning, förbrukning, avstämning) för kontot det gällde.
     * `seq` kommer från `nextResponseSeq()` när anropet startade: ett svar på ett äldre
     * anrop skriver inte över ett nyare.
     */
    applyEntitlements: (userId: string, data: EntitlementsResponse, seq: number) => boolean;
    /** Lägg in kvotfälten ur ett 402 direkt, utan att vänta på nästa hämtning. */
    applyQuotaExhausted: (q: QuotaExhaustedInfo) => void;
    reset: () => void;
}

// Löpnummer per hämtning: ett äldre svar som kommer fram efter ett nyare skriver inte över.
let refreshSeq = 0;
// Löpnummer över alla anrop som svarar med kvoterna (hämtning, förbrukning, avstämning).
// Ett svar på ett anrop som startade före det senast inlagda läggs inte in: en hämtning som
// startade före en avstämning hade annars gett tillbaka ett förskott utan avstämningens
// exporter avräknade.
let responseSeq = 0;
let appliedSeq = 0;
function nextResponseSeq(): number { return ++responseSeq; }

/** Exportens förskott och liggare, i den här datorns lokala lagring. */
export const exportLedger = new ExportLedger(() => globalThis.localStorage);

export const useEntitlementsStore = create<EntitlementsState>((set, get) => ({
    counters: {},
    userId: null,

    refresh: async () => {
        const auth = useAuthStore.getState();
        const token = auth.getToken();
        const userId = auth.userId;
        if (!token || !userId) { get().reset(); return; }
        const seq = ++refreshSeq;
        const order = nextResponseSeq();
        try {
            const data = await getEntitlements(token);
            // Ett nyare anrop har startat, eller utloggad / annat konto: släng svaret.
            if (seq !== refreshSeq || useAuthStore.getState().userId !== userId) return;
            get().applyEntitlements(userId, data, order);
        } catch (e) {
            // Nätfel eller serverfel: behåll senaste bilden. Servern grindar ändå.
            console.warn("Kunde inte hämta kvoterna:", e);
        }
    },

    applyEntitlements: (userId, data, seq) => {
        if (seq < appliedSeq) return false;
        appliedSeq = seq;
        // Förskottet sparas per konto även om ett annat konto hunnit logga in: det hör till
        // det konto servern svarade för.
        exportLedger.rememberAllowance(userId, data.plan === "pro" ? null : data.offline_allowance);
        if (useAuthStore.getState().userId !== userId) return false;
        set({ counters: data.counters, userId });
        return true;
    },

    applyQuotaExhausted: (q) => {
        if (!q.limit) return; // "ingår i Pro" (t.ex. en mall) har ingen räknare att visa
        const userId = useAuthStore.getState().userId;
        // Räknare från ett annat konto ska inte blandas med serverns svar för det här.
        const prev = get().userId === userId ? get().counters[q.kind] : undefined;
        if (get().userId !== userId) set({ counters: {}, userId });
        set({
            counters: {
                ...get().counters,
                [q.kind]: {
                    ...prev,
                    limit: q.limit,
                    used: q.used,
                    remaining: Math.max(0, q.limit - q.used),
                    resets_at: q.resets_at,
                },
            },
        });
    },

    // Nytt löpnummer: en hämtning som pågår när räknarna töms (planbyte, utloggning)
    // skriver inte tillbaka dem efteråt.
    reset: () => { refreshSeq++; set({ counters: {}, userId: null }); },
}));

/** Räknaren för rätten, men bara om den hör till kontot som är inloggat nu. */
function counterFor(kind: EntitlementKind, s: { counters: Record<string, QuotaCounter>; userId: string | null }, userId: string | null) {
    return s.userId !== null && s.userId === userId ? (s.counters[kind] ?? null) : null;
}

/**
 * Grinden för en rätt, utanför React (händelsehanterare, lib-kod). Stoppar den på en
 * räknare som visar noll hämtas räknaren igen i bakgrunden, så att en inaktuell bild
 * (servern har nollställt, eller en hämtning misslyckades) rättar sig till nästa klick.
 */
export function entitlementFor(kind: EntitlementKind): EntitlementGate {
    const auth = useAuthStore.getState();
    const gate = entitlementGate(kind, {
        isSignedIn: auth.isSignedIn,
        isPro: auth.isPro(),
        counter: counterFor(kind, useEntitlementsStore.getState(), auth.userId),
    });
    if (gate === "quota_exhausted") void useEntitlementsStore.getState().refresh();
    return gate;
}

/** True om användaren får använda rätten nu. Ersätter "inloggad och Pro" för protokoll. */
export function entitled(kind: EntitlementKind): boolean {
    return entitlementFor(kind) === "allowed";
}

/** Grinden för en rätt, reaktivt i en komponent. */
export function useEntitlement(kind: EntitlementKind): EntitlementGate {
    const isSignedIn = useAuthStore((s) => s.isSignedIn);
    const isPro = useAuthStore((s) => s.isPro());
    const userId = useAuthStore((s) => s.userId);
    const counter = useEntitlementsStore((s) => counterFor(kind, s, userId));
    return entitlementGate(kind, { isSignedIn, isPro, counter });
}

/**
 * Räknaren som visas, eller null för utloggad, Pro, innan den hämtats och när dess period
 * tagit slut (samma regel som grinden, så att panelen och klicket säger samma sak).
 */
export function visibleCounter(f: { isSignedIn: boolean; isPro: boolean; counter: QuotaCounter | null }, now: Date): QuotaCounter | null {
    if (!f.isSignedIn || f.isPro || !f.counter || periodEnded(f.counter, now)) return null;
    return f.counter;
}

/** Räknaren för en rätt i en komponent (se visibleCounter). */
export function useQuotaCounter(kind: EntitlementKind): QuotaCounter | null {
    const isSignedIn = useAuthStore((s) => s.isSignedIn);
    const isPro = useAuthStore((s) => s.isPro());
    const userId = useAuthStore((s) => s.userId);
    const counter = useEntitlementsStore((s) => counterFor(kind, s, userId));
    return visibleCounter({ isSignedIn, isPro, counter }, new Date());
}

/**
 * Exportdialogens räknare ur den synliga räknaren: exporter i dess period som dragits från
 * förskottet men inte stämts av dras av lokalt (ExportLedger.pendingCount).
 */
export function exportCounterFor(userId: string | null, counter: QuotaCounter | null, now: Date): ExportCounterView | null {
    if (!userId || !counter) return null;
    return exportCounterView({
        counter,
        pendingOffline: exportLedger.pendingCount(userId, counter.period ?? currentPeriod(now)),
    });
}

/**
 * Exportdialogens räknare i en komponent. Liggaren ligger utanför storen och läses vid
 * rendering, och bara när dialogen är öppen: den renderas om när den öppnas, och stängs
 * efter en sparad export.
 */
export function useExportCounter(open: boolean): ExportCounterView | null {
    const userId = useAuthStore((s) => s.userId);
    const counter = useQuotaCounter("export");
    return open ? exportCounterFor(userId, counter, new Date()) : null;
}

/** Siffrorna till kvotraden i uppgraderingsfönstret, för kontot som är inloggat nu. */
export function quotaForUpsell(kind: EntitlementKind): { used: number; limit: number; resets_at: string | null } | null {
    const c = counterFor(kind, useEntitlementsStore.getState(), useAuthStore.getState().userId);
    return c ? { used: c.used, limit: c.limit, resets_at: c.resets_at ?? null } : null;
}

/**
 * Håller räknarna i takt med sessionen: hämta när token byts (inloggning och varje
 * förnyelse går via setSession), töm vid utloggning. Pro har inga räknare, så där hämtas
 * inget. Returnerar avregistreringen.
 */
export function startEntitlementsSync(): () => void {
    const auth = useAuthStore.getState();
    if (auth.isSignedIn && !auth.isPro()) void useEntitlementsStore.getState().refresh();
    // Exporter gjorda utan nätverk bokförs så snart appen är online med en giltig session:
    // vid start, vid varje ny token och när nätet kommer tillbaka.
    void reconcileOfflineExports();
    const onOnline = () => { void reconcileOfflineExports(); };
    globalThis.addEventListener?.("online", onOnline);
    const unsubscribe = useAuthStore.subscribe((state, prev) => {
        if (state.isSignedIn && (state.token !== prev.token || state.userId !== prev.userId)) {
            void reconcileOfflineExports();
        }
        // Planen läses ur respektive tillstånds fält. Store-funktionen för Pro läser alltid
        // det AKTUELLA tillståndet och hade gett den nya planen för båda, och missat bytet.
        const isProNow = isProStatus(state.stripeStatus);
        const wasPro = isProStatus(prev.stripeStatus);
        if (!state.isSignedIn || isProNow) {
            if (prev.isSignedIn && !wasPro) useEntitlementsStore.getState().reset();
            return;
        }
        if (state.token !== prev.token || state.userId !== prev.userId || wasPro) {
            void useEntitlementsStore.getState().refresh();
        }
    });
    return () => {
        globalThis.removeEventListener?.("online", onOnline);
        unsubscribe();
    };
}

// ─── Exporten ──────────────────────────────────────────────────────────────────

/**
 * Får en export göras nu? Drar en enhet hos servern för gratiskontot (en gång per nyckel),
 * eller från förskottet när servern inte går att nå. Pro anropar ingenting. Stämmer först
 * av exporter som gjorts utan nätverk, så att servern räknar med dem.
 */
export async function requestExportPermit(key: string): Promise<ExportPermit> {
    const auth = useAuthStore.getState();
    const userId = auth.userId;
    const token = auth.getToken();
    const isPro = auth.isPro();
    if (auth.isSignedIn && !isPro && userId && token && exportLedger.pending(userId).length > 0) {
        await reconcileOfflineExports();
    }
    const order = nextResponseSeq();
    return permitExport({
        isSignedIn: auth.isSignedIn,
        isPro,
        userId,
        token,
        key,
        consume: (k, t) => consumeEntitlement("export", k, t),
        ledger: exportLedger,
        onBody: (body) => { if (userId) useEntitlementsStore.getState().applyEntitlements(userId, body, order); },
    });
}

let reconciling: Promise<number> | null = null;

/**
 * Skicka liggaren för kontot som är inloggat. Pågår en avstämning redan väntar anroparen på
 * den i stället för att skicka samma nycklar en gång till.
 */
export function reconcileOfflineExports(): Promise<number> {
    if (reconciling) return reconciling;
    const auth = useAuthStore.getState();
    const userId = auth.userId;
    const token = auth.getToken();
    if (!auth.isSignedIn || !userId || !token || exportLedger.pending(userId).length === 0) return Promise.resolve(0);
    const order = nextResponseSeq();
    // Nycklarna lämnar liggaren när servern bekräftat dem, även om svaret inte läggs in
    // (en hämtning som startade senare hann före). Räknaren hade då varken avdraget eller
    // serverns nya siffror, så den hämtas om.
    let dropped = false;
    reconciling = reconcileOffline({
        userId,
        token,
        ledger: exportLedger,
        call: reconcileEntitlements,
        onBody: (body) => { if (!useEntitlementsStore.getState().applyEntitlements(userId, body, order)) dropped = true; },
    }).then((n) => {
        if (dropped && useAuthStore.getState().userId === userId) void useEntitlementsStore.getState().refresh();
        return n;
    }).catch((e) => {
        console.warn("[export] avstämningen misslyckades:", e);
        return 0;
    }).finally(() => { reconciling = null; });
    return reconciling;
}
