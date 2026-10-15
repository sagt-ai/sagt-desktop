import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { usePostHogEvents } from "./use-posthog-events";
import { useDismissible } from "./use-dismissible";
import { recordingMarker } from "@/lib/recording-marker";

// Pro-hint vid långsam lokal transkribering. Triggern är medvetet enkel (v1):
// "Slutför transkribering"-läget som kvarstår >= 15 s efter stopp är en direkt
// proxy för realtidsfaktor > ~1 på användarens CPU — helt utan Rust-ändringar.
// Kortet förklarar två skilda samband: datorn avgör tiden, modellen avgör
// kvaliteten. När transkriberingen är klar visas en rad med den faktiska tiden.
export const SLOW_THRESHOLD_MS = 15_000;
const DISMISS_KEY = "sagt_slow_hint_dismissed";

// Modulnivå: PostHog-eventen fyras max en gång per appsession även om
// SplitView avmonteras vid flikbyte (komponent-state överlever inte det).
let upsellEventSent = false;

/** Tiderna för den inspelning som just transkriberas, ur inspelningsmarkören. */
export interface FinalizeTiming {
    /** Inspelningens start i ms, samma klocka som filnamnet `session_<µs>.wav`. */
    startedAt: number;
    /** När användaren tryckte Stopp, i ms. */
    stoppedAt: number;
}

/** Resultatet efter en långsam lokal transkribering, för raden ovanför transkriptet. */
export interface SlowLocalResult {
    startedAt: number;
    meetingSeconds: number;
    waitSeconds: number;
}

// Överlever att SplitView avmonteras: transkriberingen blir ofta klar medan
// användaren är på en annan flik, och raden ska finnas när hen kommer tillbaka.
export const useSlowLocalResult = create<{
    result: SlowLocalResult | null;
    set: (r: SlowLocalResult | null) => void;
}>((set) => ({ result: null, set: (result) => set({ result }) }));

function timingFromMarker(): FinalizeTiming | null {
    const m = recordingMarker.current();
    if (!m || m.stopped_at === undefined || m.cancelled) return null;
    return { startedAt: m.started_at, stoppedAt: m.stopped_at };
}

/**
 * `eligible` = slutför-läget pågår OCH användaren är i målgruppen (ej Pro,
 * ej moln — anroparen äger det villkoret). Kortet visas efter 15 s
 * sammanhängande väntan och försvinner när läget bryts. Var väntan minst 15 s
 * sparas tiden som resultat för raden efteråt. Båda avfärdas permanent
 * (localStorage) via `dismiss`.
 */
export function useSlowLocalHint(eligible: boolean) {
    const events = usePostHogEvents();
    const [show, setShow] = useState(false);
    const [timing, setTiming] = useState<FinalizeTiming | null>(null);
    const timingRef = useRef<FinalizeTiming | null>(null);
    const { dismissed, dismiss } = useDismissible(DISMISS_KEY);
    const setResult = useSlowLocalResult((s) => s.set);

    useEffect(() => {
        if (!eligible) {
            setShow(false);
            // Slutför-läget bröts. Bara en inspelning som faktiskt sparas får raden:
            // split-view jämför resultatets starttid med den visade inspelningens fil.
            const t = timingRef.current;
            timingRef.current = null;
            if (t) {
                const waitMs = Date.now() - t.stoppedAt;
                if (waitMs >= SLOW_THRESHOLD_MS) {
                    setResult({
                        startedAt: t.startedAt,
                        meetingSeconds: Math.max(0, Math.round((t.stoppedAt - t.startedAt) / 1000)),
                        waitSeconds: Math.round(waitMs / 1000),
                    });
                }
            }
            return;
        }
        const t = timingFromMarker();
        timingRef.current = t;
        setTiming(t);
        setResult(null);
        if (dismissed) return;
        // Timer med avbrott: bryts slutför-läget (klart/avbrutet/ny inspelning)
        // före tröskeln städar cleanupen bort timern och inget kort visas.
        const timer = setTimeout(() => {
            setShow(true);
            if (!upsellEventSent) {
                upsellEventSent = true;
                events.upsellShown("slow_local_processing");
            }
        }, SLOW_THRESHOLD_MS);
        return () => clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [eligible, dismissed]);

    const dismissSlowHint = () => {
        dismiss();
        setShow(false);
        setResult(null);
    };

    return { showSlowHint: show, slowTiming: timing, slowHintDismissed: dismissed, dismissSlowHint };
}
