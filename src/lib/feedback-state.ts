// När appen får ställa en fråga till användaren.
//
// Rena funktioner: tiden och det sparade tillståndet skickas in, så att varje
// spärr går att pröva utan DOM eller klocka. Lagringen sköts av
// feedback-runtime.ts.
//
// Spärrarna gäller alla frågor i appen:
// - "Nej tack" betyder aldrig mer, någon fråga.
// - "Inte nu" betyder inget på 14 dagar.
// - Aldrig vid första start, aldrig efter ett fel i sessionen, aldrig under
//   inspelning eller slutbearbetning.
// - Minst ett dygn mellan två tillfällen.
// - Tre obesvarade visningar i rad ger 14 dagars vila.

export type FeedbackSurface = "questionnaire" | "paywall" | "pro"

export const DAY_MS = 24 * 60 * 60 * 1000
export const SNOOZE_MS = 14 * DAY_MS
export const MIN_GAP_MS = DAY_MS
export const IGNORED_LIMIT = 3
/** Inbjudan kommer efter det tredje lyckade transkriptet. */
export const TRANSCRIPTS_BEFORE_INVITE = 3
/** Pro-frågan kommer efter den andra genomförda analysen. */
export const ANALYSES_BEFORE_PRO_QUESTION = 2

export interface FeedbackState {
    /** "Nej tack": aldrig mer. */
    declined: boolean
    /** "Inte nu", eller vila efter obesvarade visningar. */
    snoozeUntil: number | null
    lastShownAt: number | null
    /** Obesvarade visningar i rad. Nollställs av varje svar. */
    ignoredInARow: number
    /** Ytor som redan fått sin fråga. Varje yta frågar en gång. */
    done: FeedbackSurface[]
    /** Genomförda analyser, för Pro-frågan. */
    analyses: number
}

export const INITIAL_STATE: FeedbackState = {
    declined: false,
    snoozeUntil: null,
    lastShownAt: null,
    ignoredInARow: 0,
    done: [],
    analyses: 0,
}

export interface SessionContext {
    /** Licensen saknades när appen startade. */
    firstLaunch: boolean
    /** Ett fel har visats i den här sessionen. */
    errorThisSession: boolean
    /** Inspelning eller slutbearbetning pågår. */
    busy: boolean
}

/** Läser sparat tillstånd. Trasigt eller okänt innehåll ger starttillståndet, aldrig ett undantag. */
export function parseState(raw: string | null): FeedbackState {
    if (!raw) return { ...INITIAL_STATE }
    try {
        const v = JSON.parse(raw) as Partial<FeedbackState>
        const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null)
        return {
            declined: v.declined === true,
            snoozeUntil: num(v.snoozeUntil),
            lastShownAt: num(v.lastShownAt),
            ignoredInARow: num(v.ignoredInARow) ?? 0,
            done: Array.isArray(v.done)
                ? v.done.filter((s): s is FeedbackSurface => s === "questionnaire" || s === "paywall" || s === "pro")
                : [],
            analyses: num(v.analyses) ?? 0,
        }
    } catch {
        return { ...INITIAL_STATE }
    }
}

/** De gemensamma spärrarna. */
export function mayPrompt(state: FeedbackState, now: number, ctx: SessionContext): boolean {
    if (state.declined) return false
    if (ctx.firstLaunch || ctx.errorThisSession || ctx.busy) return false
    if (state.snoozeUntil !== null && now < state.snoozeUntil) return false
    if (state.lastShownAt !== null && now - state.lastShownAt < MIN_GAP_MS) return false
    return true
}

export function shouldInvite(state: FeedbackState, now: number, ctx: SessionContext & { successfulTranscripts: number }): boolean {
    return mayPrompt(state, now, ctx)
        && !state.done.includes("questionnaire")
        && ctx.successfulTranscripts >= TRANSCRIPTS_BEFORE_INVITE
}

export function shouldAskPaywall(state: FeedbackState, now: number, ctx: SessionContext): boolean {
    return mayPrompt(state, now, ctx) && !state.done.includes("paywall")
}

export function shouldAskPro(state: FeedbackState, now: number, ctx: SessionContext & { isPro: boolean }): boolean {
    return ctx.isPro
        && mayPrompt(state, now, ctx)
        && !state.done.includes("pro")
        && state.analyses >= ANALYSES_BEFORE_PRO_QUESTION
}

// ─── Övergångar ──────────────────────────────────────────────────────────────

export function shown(state: FeedbackState, now: number): FeedbackState {
    return { ...state, lastShownAt: now }
}

/** "Nej tack". */
export function decline(state: FeedbackState): FeedbackState {
    return { ...state, declined: true }
}

/** "Inte nu". Ytan får fråga igen efter vilan. */
export function snooze(state: FeedbackState, now: number): FeedbackState {
    return { ...state, snoozeUntil: now + SNOOZE_MS, ignoredInARow: 0 }
}

/** Kortet försvann av sig självt utan att användaren rörde det. */
export function ignored(state: FeedbackState, now: number): FeedbackState {
    const n = state.ignoredInARow + 1
    if (n >= IGNORED_LIMIT) return { ...state, ignoredInARow: 0, snoozeUntil: now + SNOOZE_MS }
    return { ...state, ignoredInARow: n }
}

/** Användaren svarade, eller stängde kortet efter att ha börjat. Ytan frågar inte igen. */
export function finished(state: FeedbackState, surface: FeedbackSurface): FeedbackState {
    const done = state.done.includes(surface) ? state.done : [...state.done, surface]
    return { ...state, done, ignoredInARow: 0 }
}

export function analysisCompleted(state: FeedbackState): FeedbackState {
    return { ...state, analyses: state.analyses + 1 }
}
