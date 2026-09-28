import { describe, expect, it } from "vitest"
import {
    ANALYSES_BEFORE_PRO_QUESTION,
    DAY_MS,
    INITIAL_STATE,
    SNOOZE_MS,
    type FeedbackState,
    type SessionContext,
    analysisCompleted,
    decline,
    finished,
    ignored,
    mayPrompt,
    parseState,
    shouldAskPaywall,
    shouldAskPro,
    shouldInvite,
    shown,
    snooze,
} from "./feedback-state"

const NOW = 1_800_000_000_000
const OK: SessionContext = { firstLaunch: false, errorThisSession: false, busy: false }
const fresh = (): FeedbackState => ({ ...INITIAL_STATE })

describe("inbjudan efter tredje lyckade transkriptet", () => {
    it("kommer vid tre", () => {
        expect(shouldInvite(fresh(), NOW, { ...OK, successfulTranscripts: 3 })).toBe(true)
    })
    it("kommer inte vid två", () => {
        expect(shouldInvite(fresh(), NOW, { ...OK, successfulTranscripts: 2 })).toBe(false)
    })
    it("kommer inte igen när frågorna är besvarade", () => {
        const s = finished(fresh(), "questionnaire")
        expect(shouldInvite(s, NOW + 30 * DAY_MS, { ...OK, successfulTranscripts: 10 })).toBe(false)
    })
})

describe("spärrarna", () => {
    it("Nej tack: ingen fråga igen, i någon yta, någonsin", () => {
        const s = decline(fresh())
        const later = NOW + 365 * DAY_MS
        expect(shouldInvite(s, later, { ...OK, successfulTranscripts: 50 })).toBe(false)
        expect(shouldAskPaywall(s, later, OK)).toBe(false)
        expect(shouldAskPro({ ...s, analyses: 9 }, later, { ...OK, isPro: true })).toBe(false)
    })

    it("första start: ingen fråga", () => {
        const ctx = { ...OK, firstLaunch: true }
        expect(mayPrompt(fresh(), NOW, ctx)).toBe(false)
        expect(shouldInvite(fresh(), NOW, { ...ctx, successfulTranscripts: 5 })).toBe(false)
        expect(shouldAskPaywall(fresh(), NOW, ctx)).toBe(false)
    })

    it("efter ett fel i sessionen: ingen fråga", () => {
        const ctx = { ...OK, errorThisSession: true }
        expect(shouldInvite(fresh(), NOW, { ...ctx, successfulTranscripts: 5 })).toBe(false)
        expect(shouldAskPaywall(fresh(), NOW, ctx)).toBe(false)
        expect(shouldAskPro({ ...fresh(), analyses: 5 }, NOW, { ...ctx, isPro: true })).toBe(false)
    })

    it("under inspelning eller slutbearbetning: ingen fråga", () => {
        expect(mayPrompt(fresh(), NOW, { ...OK, busy: true })).toBe(false)
    })

    it("Inte nu: vilar 14 dagar, sedan får ytan fråga igen", () => {
        const s = snooze(fresh(), NOW)
        expect(shouldAskPaywall(s, NOW + SNOOZE_MS - 1, OK)).toBe(false)
        expect(shouldAskPaywall(s, NOW + SNOOZE_MS, OK)).toBe(true)
    })

    it("minst ett dygn mellan två tillfällen", () => {
        const s = shown(fresh(), NOW)
        expect(mayPrompt(s, NOW + DAY_MS - 1, OK)).toBe(false)
        expect(mayPrompt(s, NOW + DAY_MS, OK)).toBe(true)
    })

    it("tre orörda visningar i rad ger 14 dagars vila", () => {
        let s = ignored(ignored(fresh(), NOW), NOW)
        expect(mayPrompt(s, NOW, OK)).toBe(true)
        s = ignored(s, NOW)
        expect(mayPrompt(s, NOW + SNOOZE_MS - 1, OK)).toBe(false)
        expect(s.ignoredInARow).toBe(0)
    })

    it("ett svar nollställer räkningen av orörda visningar", () => {
        const s = finished(ignored(ignored(fresh(), NOW), NOW), "paywall")
        expect(s.ignoredInARow).toBe(0)
    })
})

describe("betalväggen", () => {
    it("frågar en gång", () => {
        expect(shouldAskPaywall(fresh(), NOW, OK)).toBe(true)
        expect(shouldAskPaywall(finished(fresh(), "paywall"), NOW + 30 * DAY_MS, OK)).toBe(false)
    })
})

describe("Pro-frågan", () => {
    const afterAnalyses = (n: number) => {
        let s = fresh()
        for (let i = 0; i < n; i++) s = analysisCompleted(s)
        return s
    }
    it("kommer efter andra analysen", () => {
        expect(shouldAskPro(afterAnalyses(ANALYSES_BEFORE_PRO_QUESTION - 1), NOW, { ...OK, isPro: true })).toBe(false)
        expect(shouldAskPro(afterAnalyses(ANALYSES_BEFORE_PRO_QUESTION), NOW, { ...OK, isPro: true })).toBe(true)
    })
    it("bara till Pro-användare", () => {
        expect(shouldAskPro(afterAnalyses(5), NOW, { ...OK, isPro: false })).toBe(false)
    })
})

describe("sparat tillstånd", () => {
    it("trasigt innehåll ger starttillståndet, inte ett undantag", () => {
        expect(parseState("{inte json")).toEqual(INITIAL_STATE)
        expect(parseState(null)).toEqual(INITIAL_STATE)
        expect(parseState('"en sträng"').declined).toBe(false)
    })
    it("Nej tack överlever en omstart", () => {
        expect(parseState(JSON.stringify(decline(fresh()))).declined).toBe(true)
    })
    it("okända ytor och fel typer filtreras bort", () => {
        const s = parseState(JSON.stringify({ done: ["paywall", "okänd", 3], analyses: "två", snoozeUntil: "i morgon" }))
        expect(s.done).toEqual(["paywall"])
        expect(s.analyses).toBe(0)
        expect(s.snoozeUntil).toBeNull()
    })
})
