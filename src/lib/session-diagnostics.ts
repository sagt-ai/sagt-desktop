/**
 * Mätvärden som följer med `history-updated` för en sparad inspelning. Speglar
 * `SessionDiagnostics` i `src-tauri/src/audio.rs`.
 *
 * Syftet är att en inspelning utan text ska gå att klassa: tyst ljud, tal som VAD
 * aldrig utlöste på, whisper som svarade tomt eller whisper som föll.
 */
export interface SessionDiagnostics {
    /** Falskt när nivåerna aldrig skrevs (Avbryt före sparandet). Då är 0 inte tystnad. */
    levels_measured: boolean;
    mic_peak: number;
    sys_peak: number;
    mic_seen: boolean;
    /** Högsta block-RMS, det VAD jämför med `vad_threshold`. */
    mic_max_rms: number;
    sys_max_rms: number;
    vad_threshold: number;
    vad_segments: number;
    short_dropped: number;
    whisper_text: number;
    whisper_empty: number;
    whisper_failed: number;
    /** Stabil kod för sessionens första misslyckade körning: `wav_write`, `exe_path`,
     *  `model_missing`, `sidecar_missing`, `spawn_failed`, `wait_failed`,
     *  `exit_nonzero` eller `unknown`. Aldrig fri feltext. */
    whisper_error: string | null;
    /** whisper-clis exitkod vid `exit_nonzero`. */
    whisper_exit_code: number | null;
    segments_saved: number;
    word_count: number;
    flush_wait_ms: number;
    flush_timed_out: boolean;
    cloud_streaming: boolean;
}

export type TranscriptOutcome =
    | 'text'
    /** Uppmätt digital tystnad i båda kanalerna: inget ljud nådde appen. */
    | 'no_audio'
    /** VAD utlöste aldrig ett segment. Med `levels_measured` och en nivå över 0 fanns
     *  ljud, se `*_max_rms` mot tröskeln. Utan `levels_measured` är nivåerna okända. */
    | 'no_speech_detected'
    /** VAD utlöste, men varje talsegment slängdes för att det var för kort. */
    | 'speech_too_short'
    /** Minst en whisper-körning föll och ingen gav text. */
    | 'transcriber_failed'
    /** Whisper kördes och svarade tomt. */
    | 'transcriber_empty'
    /** Whisper gav text, men ingen sparades. */
    | 'text_lost'
    | 'unknown';

export function classifyTranscriptOutcome(d: SessionDiagnostics): TranscriptOutcome {
    if (d.segments_saved > 0) return 'text';
    if (d.vad_segments === 0) {
        // Ett slängt kort segment betyder att VAD utlöste, alltså att ljud fanns. Det
        // går därför före nivåerna.
        if (d.short_dropped > 0) return 'speech_too_short';
        const silent = d.levels_measured && d.mic_peak === 0 && d.sys_peak === 0;
        return silent ? 'no_audio' : 'no_speech_detected';
    }
    if (d.whisper_failed > 0) return 'transcriber_failed';
    if (d.whisper_empty > 0) return 'transcriber_empty';
    if (d.whisper_text > 0) return 'text_lost';
    return 'unknown';
}

const round = (n: number) => Math.round(n * 10000) / 10000;

/** Egenskaperna till `local_transcript_outcome`. Innehåller inget ur transkriptet. */
export function transcriptOutcomeProps(d: SessionDiagnostics, durationSeconds: number) {
    return {
        outcome: classifyTranscriptOutcome(d),
        duration_seconds: durationSeconds,
        levels_measured: d.levels_measured,
        mic_peak: round(d.mic_peak),
        sys_peak: round(d.sys_peak),
        mic_seen: d.mic_seen,
        mic_max_rms: round(d.mic_max_rms),
        sys_max_rms: round(d.sys_max_rms),
        vad_threshold: round(d.vad_threshold),
        vad_segments: d.vad_segments,
        short_dropped: d.short_dropped,
        whisper_text: d.whisper_text,
        whisper_empty: d.whisper_empty,
        whisper_failed: d.whisper_failed,
        whisper_error: d.whisper_error,
        whisper_exit_code: d.whisper_exit_code,
        segments_saved: d.segments_saved,
        flush_wait_ms: d.flush_wait_ms,
        flush_timed_out: d.flush_timed_out,
    };
}
