// Svaren på väg till PostHog.
//
// Varje svar läggs i en utkorg i localStorage innan det skickas, och tas bort
// först när PostHog svarat 200. Utan nät, eller om appen stängs mitt i, ligger
// svaret kvar och skickas vid nästa start eller när nätet kommer tillbaka.
// posthog-js egen kö ligger bara i minnet och försvinner när appen stängs.
//
// Svaren skickas medan användaren skriver. Utkorgen håller därför bara den
// senaste versionen per svar och fråga: ett nytt utkast ersätter det gamla.

export const FEEDBACK_EVENT = "feedback_answer"
export const ANSWER_MAX_LENGTH = 1000
export const OUTBOX_MAX = 50
const REDACTED = "[borttaget]"

const EMAIL = /[^\s@]+@[^\s@]+\.[^\s@]+/g
// Sju eller fler siffror med mellanslag, bindestreck, punkt eller plus emellan:
// telefon- och personnummer, men inte "2 möten i veckan".
const NUMBER_SERIES = /\+?\d(?:[\s.\-]?\d){6,}/g

/** Rensar före kapning: en adress som kapas mitt i matchar inte längre mönstret. */
export function scrubAnswer(raw: string): string {
    return raw.replace(EMAIL, REDACTED).replace(NUMBER_SERIES, REDACTED).slice(0, ANSWER_MAX_LENGTH).trim()
}

export type Rating = "up" | "down"

export interface AnswerProperties {
    surface: string
    question_id: string
    rating: Rating | null
    answer: string | null
    final: boolean
    response_id: string
    plan: "pro" | "free"
    signed_in: boolean
    app_version: string
    os: string
    environment: string
}

export interface OutboxItem {
    distinct_id: string
    /** När svaret gavs, inte när det skickades. */
    timestamp: string
    properties: AnswerProperties
}

/** Svaret att lägga i utkorgen, eller null när det inte finns något att skicka. */
export function buildAnswer(input: Omit<AnswerProperties, "answer"> & { answer: string }): AnswerProperties | null {
    const answer = scrubAnswer(input.answer) || null
    if (!answer && !input.rating) return null
    return { ...input, answer }
}

function sameSlot(a: OutboxItem, b: OutboxItem): boolean {
    return a.properties.response_id === b.properties.response_id
        && a.properties.question_id === b.properties.question_id
}

/** Lägger till eller ersätter svaret på samma fråga i samma tillfälle. */
export function enqueue(outbox: OutboxItem[], item: OutboxItem): OutboxItem[] {
    const rest = outbox.filter((o) => !sameSlot(o, item))
    return [...rest, item].slice(-OUTBOX_MAX)
}

export function parseOutbox(raw: string | null): OutboxItem[] {
    if (!raw) return []
    try {
        const v = JSON.parse(raw)
        return Array.isArray(v)
            ? v.filter((o) => o && typeof o.distinct_id === "string" && o.properties?.response_id)
            : []
    } catch {
        return []
    }
}

export function captureBody(apiKey: string, item: OutboxItem) {
    return {
        api_key: apiKey,
        event: FEEDBACK_EVENT,
        distinct_id: item.distinct_id,
        timestamp: item.timestamp,
        properties: { ...item.properties, $geoip_disable: true },
    }
}

export type Post = (body: unknown) => Promise<{ ok: boolean }>

/**
 * Skickar allt i utkorgen och returnerar det som gick fram. Vid nätfel avbryts
 * resten: de får vänta till nästa försök.
 */
export async function flush(
    items: OutboxItem[],
    apiKey: string,
    post: Post,
): Promise<OutboxItem[]> {
    const sent: OutboxItem[] = []
    for (const item of items) {
        try {
            const res = await post(captureBody(apiKey, item))
            if (res.ok) sent.push(item)
        } catch {
            // Inget nät: resten får vänta till nästa försök.
            break
        }
    }
    return sent
}

/** Tar bort de skickade, men bara om de inte ersatts under tiden. */
export function removeSent(outbox: OutboxItem[], sent: OutboxItem[]): OutboxItem[] {
    return outbox.filter((o) => !sent.some((s) => s === o || JSON.stringify(s) === JSON.stringify(o)))
}
