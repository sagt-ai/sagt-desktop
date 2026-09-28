// Återkopplingen i appen: vilket kort som visas, när det utlöses, och hur svaren
// når PostHog. Spärrarna och utkorgen är rena funktioner i feedback-state.ts och
// feedback-outbox.ts; här sitter lagringen, klockan och nätet.
//
// Svaren skickas på samma id som appens övriga händelser (användarens id när hen
// är inloggad, annars enhetens), så att de går att läsa i sitt sammanhang.

import { create } from "zustand"
import posthog from "posthog-js"
import { invoke } from "@tauri-apps/api/core"
import { CURRENT_VERSION } from "@/lib/version"
import { useAuthStore } from "@/store/auth-store"
import { useSyncStore } from "@/store/sync-store"
import { useTranscriptionStore } from "@/store/transcription-store"
import {
    type FeedbackState,
    type FeedbackSurface,
    type SessionContext,
    analysisCompleted,
    decline,
    finished,
    ignored,
    parseState,
    shouldAskPaywall,
    shouldAskPro,
    shouldInvite,
    shown,
    snooze,
} from "./feedback-state"
import {
    type OutboxItem,
    type Rating,
    buildAnswer,
    enqueue,
    flush,
    parseOutbox,
    removeSent,
} from "./feedback-outbox"

const STATE_KEY = "sagt_feedback"
const OUTBOX_KEY = "sagt_feedback_outbox"
const LAST_OPENED_KEY = "sagt_last_opened_at"
const KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined
const HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? "https://eu.i.posthog.com"

/** Hur länge efter utlösaren kortet väntar: transkriptet ska hinna synas först. */
export const AFTER_TRANSCRIPT_MS = 3000
/** Efter start: appen ska ha hunnit visa sig och ansluta innan kortet kommer. */
export const AFTER_START_MS = 8000
/** Uppgraderingsfönstret stängs först, frågan kommer en stund efter. */
export const AFTER_PAYWALL_MS = 1500

function read(key: string): string | null {
    try { return localStorage.getItem(key) } catch { return null }
}
function write(key: string, value: string) {
    try { localStorage.setItem(key, value) } catch { /* full eller blockerad lagring: svaret skickas ändå */ }
}

// Läses när modulen laddas, alltså innan AppGuard skapar licensen vid första start.
const FIRST_LAUNCH = read("sagt_beta_license") === null
write(LAST_OPENED_KEY, new Date().toISOString())

let errorThisSession = false

/** Ett fel har visats för användaren. Ingen fråga resten av sessionen. */
export function markErrorSeen() {
    errorThisSession = true
}

function context(): SessionContext {
    return {
        firstLaunch: FIRST_LAUNCH,
        errorThisSession,
        busy: useSyncStore.getState().isRecording || useTranscriptionStore.getState().isProcessing,
    }
}

function loadState(): FeedbackState {
    return parseState(read(STATE_KEY))
}
function saveState(s: FeedbackState) {
    write(STATE_KEY, JSON.stringify(s))
}

// ─── Kortet ──────────────────────────────────────────────────────────────────

export type CardStage = "invite" | "question" | "thanks"

export interface ActiveCard {
    surface: FeedbackSurface
    stage: CardStage
    responseId: string
    /** Öppnat av användaren själv från Inställningar: spärrarna gäller inte. */
    requested: boolean
}

interface FeedbackStore {
    active: ActiveCard | null
    open: (surface: FeedbackSurface, stage: CardStage, requested?: boolean) => void
    close: () => void
    setStage: (stage: CardStage) => void
}

export const useFeedbackStore = create<FeedbackStore>((set) => ({
    active: null,
    open: (surface, stage, requested = false) =>
        set({ active: { surface, stage, responseId: crypto.randomUUID(), requested } }),
    close: () => set({ active: null }),
    setStage: (stage) => set((s) => (s.active ? { active: { ...s.active, stage } } : s)),
}))

function show(surface: FeedbackSurface, stage: CardStage) {
    if (useFeedbackStore.getState().active) return
    saveState(shown(loadState(), Date.now()))
    useFeedbackStore.getState().open(surface, stage)
}

// ─── Utlösare ────────────────────────────────────────────────────────────────

async function successfulTranscripts(): Promise<number> {
    try {
        const recs = await invoke<{ has_segments?: boolean }[]>("get_recordings")
        return recs.filter((r) => r.has_segments).length
    } catch {
        return 0
    }
}

async function inviteIfDue() {
    const count = await successfulTranscripts()
    if (shouldInvite(loadState(), Date.now(), { ...context(), successfulTranscripts: count })) {
        show("questionnaire", "invite")
    }
}

/** En lokal inspelning är sparad. Bara ett transkript med text räknas. */
export function onTranscriptSaved(hadText: boolean) {
    if (!hadText) return
    setTimeout(inviteIfDue, AFTER_TRANSCRIPT_MS)
}

/**
 * Appen har startat. Den som redan har tre lyckade transkript får inbjudan
 * utan att först spela in igen. Spärrarna gäller som vanligt, så aldrig vid
 * första start och aldrig om ett fel hunnit visas.
 */
export function onAppStarted() {
    setTimeout(inviteIfDue, AFTER_START_MS)
}

/** Uppgraderingsfönstret stängdes. Frågan ställs bara när säljvyn stängdes utan köp. */
export function onUpsellDismissed(view: string) {
    if (view !== "sales") return
    setTimeout(() => {
        if (shouldAskPaywall(loadState(), Date.now(), context())) show("paywall", "question")
    }, AFTER_PAYWALL_MS)
}

/** En analys är klar och protokollet finns. Misslyckade analyser räknas inte. */
export function onAnalysisCompleted() {
    saveState(analysisCompleted(loadState()))
    setTimeout(() => {
        const isPro = useAuthStore.getState().isPro()
        if (shouldAskPro(loadState(), Date.now(), { ...context(), isPro })) show("pro", "question")
    }, AFTER_TRANSCRIPT_MS)
}

/** "Tyck till om Sagt" i Inställningar. */
export function openFromSettings() {
    useFeedbackStore.getState().open("questionnaire", "question", true)
}

// ─── Användarens val ─────────────────────────────────────────────────────────

export function chooseDecline() {
    saveState(decline(loadState()))
    useFeedbackStore.getState().close()
}

export function chooseSnooze() {
    saveState(snooze(loadState(), Date.now()))
    useFeedbackStore.getState().close()
}

/** Kortet försvann av sig självt, orört. */
export function markIgnored() {
    saveState(ignored(loadState(), Date.now()))
    useFeedbackStore.getState().close()
}

/** Användaren har svarat på, eller stängt, frågorna i en yta. */
export function markFinished(surface: FeedbackSurface) {
    saveState(finished(loadState(), surface))
}

// ─── Sändning ────────────────────────────────────────────────────────────────

function osName(): string {
    return /Mac/i.test(navigator.userAgent) ? "macos" : "windows"
}

let flushing = false

export async function flushOutbox() {
    if (!KEY || flushing) return
    const pending = parseOutbox(read(OUTBOX_KEY))
    if (pending.length === 0) return
    flushing = true
    try {
        const sent = await flush(pending, KEY, (body) =>
            fetch(`${HOST.replace(/\/+$/, "")}/i/v0/e/`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
                keepalive: true,
            }),
        )
        // Läs om: ett nytt utkast kan ha lagts till medan vi skickade.
        write(OUTBOX_KEY, JSON.stringify(removeSent(parseOutbox(read(OUTBOX_KEY)), sent)))
    } finally {
        flushing = false
    }
}

export function sendAnswer(args: {
    surface: FeedbackSurface
    responseId: string
    questionId: string
    rating: Rating | null
    answer: string
    final: boolean
}) {
    if (!KEY) return
    const auth = useAuthStore.getState()
    const props = buildAnswer({
        surface: args.surface,
        question_id: args.questionId,
        rating: args.rating,
        answer: args.answer,
        final: args.final,
        response_id: args.responseId,
        plan: auth.isPro() ? "pro" : "free",
        signed_in: auth.isSignedIn,
        app_version: CURRENT_VERSION,
        os: osName(),
        environment: import.meta.env.PROD ? "production" : "development",
    })
    if (!props) return
    const item: OutboxItem = {
        distinct_id: posthog.get_distinct_id?.() || args.responseId,
        timestamp: new Date().toISOString(),
        properties: props,
    }
    write(OUTBOX_KEY, JSON.stringify(enqueue(parseOutbox(read(OUTBOX_KEY)), item)))
    void flushOutbox()
}

if (typeof window !== "undefined") {
    window.addEventListener("online", () => { void flushOutbox() })
    void flushOutbox()
}
