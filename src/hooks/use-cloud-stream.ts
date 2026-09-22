import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useTranscriptionStore } from "@/store/transcription-store";
import { useAuthStore } from "@/store/auth-store";
import { useSyncStore } from "@/store/sync-store";
import { transcribeChunk } from "@/lib/api";
import { MissingTokenError, insertCloudSegment, isRetryableChunkError, retryDelayMs } from "@/lib/cloud-chunks";
import posthog from "posthog-js";
import { showError } from "@/hooks/use-posthog-events";

// Matchar Rust `CloudChunk` (serde) — audio är WAV-bytes som number[].
interface CloudChunkEvent {
    audio: number[];
    speaker: string;  // "DU" | "MÖTET" | "MOLN"
    start: number;    // sekunder
    duration: number; // segmentlängd i sekunder → end_time = start + duration
}

// Begränsa samtidiga moln-POST så vi inte översvämmar Berget vid snabb segmentering.
const MAX_CONCURRENT = 3;

// Modulnivå-tillstånd — useCloudStream monteras EN gång i App.tsx (singleton), så detta är
// säkert och låter control-bar/split-view styra kön (vänta/avbryt) utan prop-trådning.
let queue: CloudChunkEvent[] = [];
let pending = 0;
let cancelRequested = false;
let wasBusy = false;
let errored = false;
// Räknas upp vid varje ny session, avbrott och avmontering. En bit tar sin generation när
// den plockas ur kön och släpps tyst om den har bytts: med omförsök kan en bit leva ~12 s,
// och resetCloudStream() nollställer cancelRequested vid nästa start — utan generationen
// hade en bit från förra mötet kunnat landa i det nya efter clearSegments().
let generation = 0;

export function cloudStreamBusy(): boolean {
    return pending > 0 || queue.length > 0;
}

export async function waitForCloudStreamIdle(timeoutMs = 60000): Promise<void> {
    const start = Date.now();
    while (cloudStreamBusy() && Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 150));
    }
}

// #11: Avbryt ska bita på moln-kön — töm den, släpp in inga fler chunks och släck "Bearbetar".
export function cancelCloudStream() {
    cancelRequested = true;
    generation++;
    queue = [];
    wasBusy = false;
    useTranscriptionStore.getState().setIsProcessing(false);
}

// Nollställs vid varje inspelningsstart (control-bar) så en ny session inte ärver avbrottet.
export function resetCloudStream() {
    generation++;
    cancelRequested = false;
    queue = [];
    wasBusy = false;
    errored = false;
}

// #12: persistera hela segment-storen till DB. Körs vid varje äkta kö-dränering post-stop så
// eftersläpande chunks alltid fångas — annars sparas bara det som hunnit in vid control-bars
// timeout, och ett flikbyte (SplitView remount) läser då tillbaka en halv transkribering.
async function persistSegments() {
    const sid = useSyncStore.getState().currentSessionId;
    if (!sid) return;
    const segs = useTranscriptionStore.getState().segments;
    if (segs.length === 0) return;
    try {
        await invoke("update_recording_segments", {
            recordingId: parseInt(sid, 10),
            segments: segs.map((s) => ({
                start_time: s.start_time,
                end_time: s.end_time,
                text: s.text,
                speaker: s.speaker,
            })),
        });
    } catch (e) {
        console.error("persistSegments failed:", e);
    }
}

/**
 * Lyssnar på Rust `cloud-chunk-ready` (PRO live-molnströmning), POSTar varje VAD-segment
 * till /transcribe-chunk och matar in resultatet i transcription-store med talar-tag.
 * Äger även "Bearbetar…"-statusen post-stop (#11) och persisterar vid dränering (#12).
 */
export function useCloudStream() {
    useEffect(() => {
        let active = true;
        queue = [];
        pending = 0;
        cancelRequested = false;
        wasBusy = false;
        errored = false;

        const stale = (gen: number) => !active || cancelRequested || gen !== generation;

        // Väntan före omförsök, som släpper sin plats i kön inom 100 ms när biten blivit
        // inaktuell. Annars håller en bit från ett avbrutet möte en av MAX_CONCURRENT platser
        // i upp till ~8 s, och nästa mötes första bitar får vänta (code review 2026-09-21).
        const sleepUnlessStale = async (ms: number, gen: number) => {
            const until = Date.now() + ms;
            while (!stale(gen) && Date.now() < until) {
                await new Promise((r) => setTimeout(r, Math.min(100, until - Date.now())));
            }
        };

        const handleChunk = async (chunk: CloudChunkEvent, gen: number): Promise<void> => {
            for (let attempt = 0; ; attempt++) {
                try {
                    const token = useAuthStore.getState().getToken();
                    if (!token) throw new MissingTokenError();
                    const res = await transcribeChunk(chunk.audio, chunk.speaker, chunk.start, token);
                    if (stale(gen)) return; // #11: avbrutet eller ny session medan POST var i luften
                    const text = (res.text || "").trim();
                    if (text) {
                        const store = useTranscriptionStore.getState();
                        const next = insertCloudSegment(store.segments, {
                            text,
                            start_time: chunk.start,
                            end_time: chunk.start + chunk.duration,
                            timestamp: chunk.start * 1000,
                            speaker: chunk.speaker,
                        });
                        if (next) store.setSegments(next);
                        posthog?.capture?.("cloud_chunk_ok", { speaker: chunk.speaker, attempts: attempt + 1 });
                        errored = false; // #8 re-arm: lyckad chunk → tillåt ny felnotis senare
                    } else {
                        posthog?.capture?.("cloud_chunk_empty", { speaker: chunk.speaker, attempts: attempt + 1 });
                    }
                    return;
                } catch (e: any) {
                    if (stale(gen)) return;
                    const msg = String(e?.message || e);
                    // #8: omförsök vid fel som kan gå över (nätverk, 5xx), med växande väntan.
                    // Aldrig vid auth, Pro, kvot eller en trasig bit — samma svar kommer igen.
                    const delay = isRetryableChunkError(e) ? retryDelayMs(attempt) : null;
                    if (delay !== null) {
                        await sleepUnlessStale(delay, gen);
                        if (stale(gen)) return;
                        continue;
                    }
                    console.error("Cloud chunk failed:", msg);
                    posthog?.capture?.("cloud_chunk_error", {
                        speaker: chunk.speaker, message: msg.slice(0, 140), attempts: attempt + 1,
                    });
                    if (!errored) {
                        errored = true;
                        if (msg.includes("Payment Required")) showError('not_pro', "Molntranskribering kräver aktiv Pro-prenumeration.", { action: 'cloud_stream' });
                        else if (msg.includes("Quota")) showError('quota_exceeded', "Månadsgränsen för molntranskribering är nådd.", { action: 'cloud_stream' });
                        else showError('unavailable', "Molntranskribering avbröts (nätverk/server). Försöker igen automatiskt.", { action: 'cloud_stream' }, { duration: 6000 });
                    }
                    return;
                }
            }
        };

        // Körs efter varje avslutad chunk: när kön är ÄKTA tom post-stop → persistera (#12)
        // och släck "Bearbetar…" (#11). wasBusy gör att den bara fyrar en gång per dränering.
        const onMaybeDrained = () => {
            if (cloudStreamBusy()) return;
            if (!wasBusy) return;
            wasBusy = false;
            if (useSyncStore.getState().isRecording) return;
            void persistSegments().finally(() => {
                useTranscriptionStore.getState().setIsProcessing(false);
            });
        };

        const pump = () => {
            while (active && !cancelRequested && pending < MAX_CONCURRENT && queue.length > 0) {
                const chunk = queue.shift()!;
                const gen = generation;
                pending++;
                wasBusy = true;
                void (async () => {
                    await handleChunk(chunk, gen);
                    pending--;
                    pump();
                    onMaybeDrained();
                })();
            }
        };

        const unlistenPromise = listen<CloudChunkEvent>("cloud-chunk-ready", (event) => {
            if (cancelRequested) return; // #11: avbrutet — släng eftersläpande chunks
            queue.push(event.payload);
            wasBusy = true;
            // #11: chunks som anländer/processas efter stopp → håll "Bearbetar…" tänd tills dränerat.
            if (!useSyncStore.getState().isRecording) {
                useTranscriptionStore.getState().setIsProcessing(true);
            }
            pump();
        });

        return () => {
            active = false;
            generation++;
            queue = [];
            pending = 0;
            wasBusy = false;
            errored = false;
            unlistenPromise.then((f) => f());
        };
    }, []);
}
