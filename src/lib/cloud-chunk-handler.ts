import type { UISegment } from "@/store/transcription-store";
import { MissingTokenError, isRetryableChunkError, retryDelayMs } from "@/lib/cloud-chunks";

// Matchar Rust `CloudChunk` (serde) — audio är WAV-bytes som number[].
export interface CloudChunkEvent {
    audio: number[];
    speaker: string;  // "DU" | "MÖTET" | "MOLN"
    start: number;    // sekunder
    duration: number; // segmentlängd i sekunder → end_time = start + duration
}

/** Det `handleChunk` behöver utifrån. Injiceras så att flödet kan testas utan Tauri,
 *  React och nätverk. */
export interface ChunkDeps {
    getToken: () => string | null | undefined;
    transcribe: (audio: number[], speaker: string, start: number, token: string) => Promise<{ text?: string | null }>;
    /** Sant när biten tillhör ett avbrutet eller avslutat möte. */
    isStale: () => boolean;
    /** Väntan före omförsök. Ska returnera tidigt när biten blivit inaktuell. */
    sleep: (ms: number) => Promise<void>;
    /** Lägger in segmentet i storen. */
    apply: (seg: UISegment) => void;
    capture: (event: string, props: Record<string, unknown>) => void;
    /** En bit lyckades: tillåt en ny felnotis senare. */
    onSuccess: () => void;
    /** En bit misslyckades slutgiltigt. */
    onFailure: (message: string) => void;
}

/** Anropet mot /transcribe-chunk, med omförsök. Returnerar texten och antalet försök,
 *  eller null när biten blev inaktuell eller misslyckades slutgiltigt. */
async function transcribeWithRetry(
    chunk: CloudChunkEvent,
    deps: ChunkDeps,
): Promise<{ text: string; attempts: number } | null> {
    for (let attempt = 0; ; attempt++) {
        try {
            const token = deps.getToken();
            if (!token) throw new MissingTokenError();
            const res = await deps.transcribe(chunk.audio, chunk.speaker, chunk.start, token);
            return { text: (res.text || "").trim(), attempts: attempt + 1 };
        } catch (e: any) {
            if (deps.isStale()) return null;
            const msg = String(e?.message || e);
            // #8: omförsök vid fel som kan gå över (nätverk, 5xx), med växande väntan.
            // Aldrig vid auth, Pro, kvot eller en trasig bit — samma svar kommer igen.
            const delay = isRetryableChunkError(e) ? retryDelayMs(attempt) : null;
            if (delay !== null) {
                await deps.sleep(delay);
                if (deps.isStale()) return null;
                continue;
            }
            deps.capture("cloud_chunk_error", {
                speaker: chunk.speaker, message: msg.slice(0, 140), attempts: attempt + 1,
            });
            deps.onFailure(msg);
            return null;
        }
    }
}

/**
 * En molnbit: anropet, och sedan infogningen i storen.
 *
 * 🔴 Bara anropet får göras om. Servern räknar varje lyckat anrop i kundens kvot.
 * Försöksslingan omslöt tidigare
 * också infogningen och analysanropet, och `isRetryableChunkError` gör om allt som inte
 * är ett HTTP-fel. Ett undantag där skickade alltså en redan transkriberad bit upp till
 * fyra gånger till, och debiterade den varje gång.
 */
export async function processCloudChunk(chunk: CloudChunkEvent, deps: ChunkDeps): Promise<void> {
    const res = await transcribeWithRetry(chunk, deps);
    if (!res) return;
    if (deps.isStale()) return; // #11: avbrutet eller ny session medan POST var i luften
    deps.onSuccess(); // #8 re-arm: anropet lyckades → tillåt ny felnotis senare
    try {
        if (res.text) {
            deps.apply({
                text: res.text,
                start_time: chunk.start,
                end_time: chunk.start + chunk.duration,
                timestamp: chunk.start * 1000,
                speaker: chunk.speaker,
            });
            deps.capture("cloud_chunk_ok", { speaker: chunk.speaker, attempts: res.attempts });
        } else {
            deps.capture("cloud_chunk_empty", { speaker: chunk.speaker, attempts: res.attempts });
        }
    } catch (e) {
        // Biten är betald och transkriberad. Ett nytt anrop ger samma text och en ny
        // debitering, så felet loggas och biten släpps.
        console.error("Cloud chunk could not be applied:", e);
    }
}
