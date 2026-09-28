import { describe, expect, it } from "vitest"
import {
    ANSWER_MAX_LENGTH,
    OUTBOX_MAX,
    type OutboxItem,
    buildAnswer,
    captureBody,
    enqueue,
    flush,
    parseOutbox,
    removeSent,
    scrubAnswer,
} from "./feedback-outbox"
import { questionsFor } from "./feedback-questions"

const base = {
    surface: "questionnaire", question_id: "after_meeting", rating: null, final: false,
    response_id: "r1", plan: "free" as const, signed_in: false, app_version: "0.10.8",
    os: "windows", environment: "production",
}

const item = (answer: string, over: Partial<typeof base> = {}): OutboxItem => ({
    distinct_id: "user_1",
    timestamp: "2026-10-01T10:00:00.000Z",
    properties: buildAnswer({ ...base, ...over, answer })!,
})

describe("svaret", () => {
    it("tomt utan tumme skickas inte", () => {
        expect(buildAnswer({ ...base, answer: "  " })).toBeNull()
    })
    it("en tumme utan text skickas", () => {
        expect(buildAnswer({ ...base, rating: "up", answer: "" })?.rating).toBe("up")
    })
    it("e-post och telefonnummer rensas, korta tal står kvar", () => {
        expect(scrubAnswer("mejla anna@example.se")).toBe("mejla [borttaget]")
        expect(scrubAnswer("ring 070-123 45 67")).toBe("ring [borttaget]")
        expect(scrubAnswer("2 möten i veckan")).toBe("2 möten i veckan")
    })
    it("en adress vid kapningsgränsen rensas ändå", () => {
        const out = scrubAnswer("x".repeat(ANSWER_MAX_LENGTH - 5) + " anna@example.se")
        expect(out).not.toContain("anna")
    })
    it("bär användarens id och slår av ortsuppslaget", () => {
        const body = captureBody("phc_x", item("hej"))
        expect(body.distinct_id).toBe("user_1")
        expect(body.event).toBe("feedback_answer")
        expect(body.properties.$geoip_disable).toBe(true)
        expect(body.timestamp).toBe("2026-10-01T10:00:00.000Z")
    })
})

describe("utkorgen", () => {
    it("ett nytt utkast ersätter det gamla på samma fråga", () => {
        const box = enqueue(enqueue([], item("hej")), item("hej då"))
        expect(box).toHaveLength(1)
        expect(box[0].properties.answer).toBe("hej då")
    })
    it("olika frågor ligger kvar sida vid sida", () => {
        const box = enqueue(enqueue([], item("a")), item("b", { question_id: "missing" }))
        expect(box).toHaveLength(2)
    })
    it("växer inte obegränsat", () => {
        let box: OutboxItem[] = []
        for (let i = 0; i < OUTBOX_MAX + 10; i++) box = enqueue(box, item("x", { response_id: `r${i}` }))
        expect(box).toHaveLength(OUTBOX_MAX)
    })
    it("trasigt innehåll ger en tom utkorg", () => {
        expect(parseOutbox("{")).toEqual([])
        expect(parseOutbox('[{"nej":1}]')).toEqual([])
    })
})

describe("sändningen", () => {
    it("utan nät ligger allt kvar", async () => {
        const box = [item("a"), item("b", { question_id: "missing" })]
        const sent = await flush(box, "phc_x", async () => { throw new TypeError("Failed to fetch") })
        expect(removeSent(box, sent)).toEqual(box)
    })
    it("ett felsvar räknas inte som skickat", async () => {
        const box = [item("a")]
        const sent = await flush(box, "phc_x", async () => ({ ok: false }))
        expect(removeSent(box, sent)).toEqual(box)
    })
    it("skickade tas bort", async () => {
        const box = [item("a"), item("b", { question_id: "missing" })]
        const sent = await flush(box, "phc_x", async () => ({ ok: true }))
        expect(removeSent(box, sent)).toEqual([])
    })
    it("ett utkast som ersattes under sändningen ligger kvar i sin nya version", async () => {
        const before = [item("hej")]
        const sent = await flush(before, "phc_x", async () => ({ ok: true }))
        const now = enqueue(before, item("hej igen"))
        expect(removeSent(now, sent).map((o) => o.properties.answer)).toEqual(["hej igen"])
    })
})

describe("frågorna", () => {
    it("formuläret har högst fem frågor, och den första är Daniels ordagrant", () => {
        for (const isPro of [false, true]) {
            const q = questionsFor("questionnaire", isPro)
            expect(q.length).toBeLessThanOrEqual(5)
            expect(q[0].text).toBe("Vad planerar du göra med texten efter mötet, något vi kan hjälpa till med?")
        }
    })
    it("gratis och Pro får var sin fråga om att betala", () => {
        expect(questionsFor("questionnaire", false).map((q) => q.id)).toContain("worth_paying")
        expect(questionsFor("questionnaire", true).map((q) => q.id)).toContain("pro_worth")
    })
    it("frågornas id är unika inom en yta", () => {
        for (const s of ["questionnaire", "paywall", "pro"] as const) {
            const ids = questionsFor(s, false).map((q) => q.id)
            expect(new Set(ids).size).toBe(ids.length)
        }
    })
})
