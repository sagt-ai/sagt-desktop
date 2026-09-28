import { useEffect, useMemo, useRef, useState } from "react"
import { ThumbsDown, ThumbsUp, X } from "lucide-react"
import { useAuthStore } from "@/store/auth-store"
import { useSyncStore } from "@/store/sync-store"
import { INVITE_BODY, INVITE_TITLE, questionsFor } from "@/lib/feedback-questions"
import type { Rating } from "@/lib/feedback-outbox"
import {
    chooseDecline,
    chooseSnooze,
    markFinished,
    markIgnored,
    sendAnswer,
    useFeedbackStore,
} from "@/lib/feedback-runtime"

/** Orört kort försvinner av sig självt efter så här lång tid. */
const IDLE_CLOSE_MS = 60_000
/** Texten skickas när användaren slutat skriva en stund. */
const TYPING_SEND_MS = 1500
const THANKS_MS = 2500

/**
 * Återkopplingskortet nere till höger. Inget överlägg: det blockerar ingenting.
 * z-[60] lägger det över den låsta protokollpanelens slöja (z-[51]) men under
 * uppgraderingsfönstret (z-[100]).
 *
 * Varje svar skickas medan det ges. Tummen skickas vid klicket, texten när
 * användaren slutat skriva, lämnar fältet eller går vidare. Den som slutar
 * efter två frågor har alltså gett två svar.
 */
export function FeedbackCard() {
    const active = useFeedbackStore((s) => s.active)
    // Döljs medan en inspelning pågår, men behåller sitt läge: det som redan
    // skrivits finns kvar när inspelningen är slut.
    const recording = useSyncStore((s) => s.isRecording)
    if (!active) return null
    // key: ett nytt tillfälle börjar alltid om från första frågan.
    return (
        <div hidden={recording}>
            <Card key={active.responseId} paused={recording} />
        </div>
    )
}

function Card({ paused }: { paused: boolean }) {
    const active = useFeedbackStore((s) => s.active)!
    const setStage = useFeedbackStore((s) => s.setStage)
    const close = useFeedbackStore((s) => s.close)
    const isPro = useAuthStore((s) => s.stripeStatus === "active")
    const questions = useMemo(() => questionsFor(active.surface, isPro), [active.surface])

    const [index, setIndex] = useState(0)
    const [rating, setRating] = useState<Rating | null>(null)
    const [text, setText] = useState("")
    const [expanded, setExpanded] = useState(false)
    const [touched, setTouched] = useState(active.requested)
    const question = questions[index]
    const isLast = index === questions.length - 1

    // Samma innehåll skickas inte två gånger (paus och blur följer ofta tätt).
    const lastSent = useRef<string | null>(null)
    const send = (final: boolean, r = rating, t = text) => {
        const key = `${question.id}\u0000${r ?? ""}\u0000${t.trim()}\u0000${final}`
        if (key === lastSent.current) return
        lastSent.current = key
        sendAnswer({
            surface: active.surface,
            responseId: active.responseId,
            questionId: question.id,
            rating: r,
            answer: t,
            final,
        })
    }

    // Orört kort försvinner efter en minut.
    useEffect(() => {
        if (touched || paused) return
        const t = setTimeout(markIgnored, IDLE_CLOSE_MS)
        return () => clearTimeout(t)
    }, [touched, paused])

    // Texten skickas när den varit stilla en stund.
    const latest = useRef({ text, rating })
    latest.current = { text, rating }
    useEffect(() => {
        if (!text.trim()) return
        const t = setTimeout(() => send(false), TYPING_SEND_MS)
        return () => clearTimeout(t)
    }, [text])

    useEffect(() => {
        if (active.stage !== "thanks") return
        const t = setTimeout(close, THANKS_MS)
        return () => clearTimeout(t)
    }, [active.stage, close])

    const pickRating = (r: Rating) => {
        setTouched(true)
        setRating(r)
        setExpanded(true)
        send(false, r)
    }

    const next = () => {
        send(true)
        if (isLast) {
            markFinished(active.surface)
            setStage("thanks")
            return
        }
        setIndex(index + 1)
        setRating(null)
        setText("")
        setExpanded(false)
    }

    // Krysset. Utkastet skickas, och frågorna i den här ytan är klara.
    const dismiss = () => {
        if (active.stage === "invite") return chooseSnooze()
        if (active.stage === "question") {
            if (latest.current.text.trim() || latest.current.rating) send(true)
            markFinished(active.surface)
        }
        close()
    }

    return (
        <div
            role="dialog"
            aria-label="Frågor om Sagt"
            onPointerDown={() => setTouched(true)}
            onKeyDown={() => setTouched(true)}
            className="absolute bottom-3 right-3 z-[60] w-80 max-h-[calc(100%-1.5rem)] overflow-y-auto rounded-xl border border-line bg-white p-4 shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-200 motion-reduce:animate-none"
        >
            {active.stage === "invite" && (
                <div>
                    <div className="flex items-start gap-3">
                        <p className="flex-1 text-sm font-medium text-ink leading-snug">{INVITE_TITLE}</p>
                        <CloseButton onClick={dismiss} />
                    </div>
                    <p className="mt-1 text-xs text-ink-muted leading-relaxed">{INVITE_BODY}</p>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                        <button
                            onClick={() => { setTouched(true); setStage("question") }}
                            className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                        >
                            Gärna
                        </button>
                        <button onClick={chooseSnooze} className="h-7 rounded-md px-3 text-xs text-ink-muted hover:text-ink transition-colors">
                            Inte nu
                        </button>
                        <button onClick={chooseDecline} className="h-7 rounded-md px-3 text-xs text-ink-muted/80 hover:text-ink transition-colors">
                            Nej tack
                        </button>
                    </div>
                </div>
            )}

            {active.stage === "question" && question && (
                <div>
                    <div className="flex items-center justify-between">
                        <span className="text-[11px] text-ink-muted">
                            {questions.length > 1 ? `${index + 1} av ${questions.length}` : ""}
                        </span>
                        <CloseButton onClick={dismiss} />
                    </div>

                    {question.thumb && (
                        <>
                            <p className="mt-1 text-sm font-medium text-ink leading-snug">{question.thumb}</p>
                            <div className="mt-3 flex gap-2">
                                <ThumbButton selected={rating === "up"} label="Ja" onClick={() => pickRating("up")} Icon={ThumbsUp} />
                                <ThumbButton selected={rating === "down"} label="Nej" onClick={() => pickRating("down")} Icon={ThumbsDown} />
                            </div>
                        </>
                    )}

                    {(expanded || !question.thumb) ? (
                        <div className="mt-3 animate-in fade-in duration-200 motion-reduce:animate-none">
                            <p className="text-[13px] text-ink leading-snug">{question.text}</p>
                            <textarea
                                autoFocus={!question.thumb || rating !== null}
                                value={text}
                                onChange={(e) => setText(e.target.value)}
                                onBlur={() => { if (text.trim()) send(false) }}
                                rows={3}
                                maxLength={1000}
                                placeholder="Skriv några ord"
                                className="mt-2 w-full resize-none rounded-md border border-line bg-white px-2.5 py-2 text-xs text-ink placeholder:text-ink-muted focus:outline-none focus:border-brand focus:ring-2 focus:ring-brand/15"
                            />
                        </div>
                    ) : (
                        <button
                            onClick={() => { setTouched(true); setExpanded(true) }}
                            className="mt-3 w-full border-b border-line pb-1 text-left text-xs text-ink-muted hover:text-ink transition-colors"
                        >
                            Eller skriv några ord
                        </button>
                    )}

                    <div className="mt-3 flex items-center justify-between gap-2">
                        <span className="text-[11px] text-ink-muted">
                            {expanded || !question.thumb ? "Sparas medan du skriver" : ""}
                        </span>
                        <div className="flex gap-1.5">
                            {!rating && !text.trim() && !isLast && (
                                <button onClick={next} className="h-7 rounded-md px-2.5 text-xs text-ink-muted hover:text-ink transition-colors">
                                    Hoppa över
                                </button>
                            )}
                            <button
                                onClick={next}
                                className="h-7 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 transition-colors"
                            >
                                {isLast ? "Klar" : "Nästa"}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {active.stage === "thanks" && (
                <p className="text-sm text-ink">Tack. Det hjälper oss att göra Sagt bättre.</p>
            )}
        </div>
    )
}

function CloseButton({ onClick }: { onClick: () => void }) {
    return (
        <button
            onClick={onClick}
            aria-label="Stäng"
            title="Stäng"
            className="-mr-1 -mt-1 rounded p-1 text-ink-muted hover:bg-paper-dim hover:text-ink transition-colors"
        >
            <X className="h-3.5 w-3.5" />
        </button>
    )
}

function ThumbButton({ selected, label, onClick, Icon }: {
    selected: boolean
    label: string
    onClick: () => void
    Icon: typeof ThumbsUp
}) {
    return (
        <button
            onClick={onClick}
            aria-label={label}
            aria-pressed={selected}
            title={label}
            className={`inline-flex h-8 w-10 items-center justify-center rounded-md border transition-colors ${
                selected
                    ? "border-brand bg-brand/10 text-brand"
                    : "border-line text-ink-muted hover:border-ink-muted hover:text-ink"
            }`}
        >
            <Icon className="h-4 w-4" />
        </button>
    )
}
