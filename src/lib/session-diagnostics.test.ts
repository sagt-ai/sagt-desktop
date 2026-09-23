import { describe, expect, it } from 'vitest';
import { classifyTranscriptOutcome, transcriptOutcomeProps, type SessionDiagnostics } from './session-diagnostics';

const base: SessionDiagnostics = {
    levels_measured: true, mic_peak: 0.3, sys_peak: 0.2, mic_seen: true,
    mic_max_rms: 0.05, sys_max_rms: 0.04, vad_threshold: 0.008,
    vad_segments: 3, short_dropped: 0,
    whisper_text: 3, whisper_empty: 0, whisper_failed: 0, whisper_error: null, whisper_exit_code: null,
    segments_saved: 3, word_count: 40,
    flush_wait_ms: 260, flush_timed_out: false, cloud_streaming: false,
};

describe('classifyTranscriptOutcome', () => {
    it('sparade segment är text', () => {
        expect(classifyTranscriptOutcome(base)).toBe('text');
    });

    it('digital tystnad i båda kanalerna är no_audio', () => {
        expect(classifyTranscriptOutcome({
            ...base, mic_peak: 0, sys_peak: 0, vad_segments: 0, whisper_text: 0, segments_saved: 0,
        })).toBe('no_audio');
    });

    it('nivåer som aldrig mättes är inte digital tystnad', () => {
        // 🔴 NEGATIVT FALL. Bryter Avbryt väntan före sparandet skrivs nivåerna aldrig,
        // och de står kvar på 0. Det får inte klassas som att ljudet saknades.
        expect(classifyTranscriptOutcome({
            ...base, levels_measured: false, mic_peak: 0, sys_peak: 0,
            vad_segments: 0, whisper_text: 0, segments_saved: 0,
        })).toBe('no_speech_detected');
    });

    it('svagt ljud som aldrig nådde tröskeln är no_speech_detected, inte no_audio', () => {
        // 🔴 NEGATIVT FALL: brus under tröskeln får inte klassas som att ljudet saknades.
        expect(classifyTranscriptOutcome({
            ...base, mic_peak: 0.004, sys_peak: 0, mic_max_rms: 0.002,
            vad_segments: 0, whisper_text: 0, segments_saved: 0,
        })).toBe('no_speech_detected');
    });

    it('tal som VAD utlöste men som var för kort är speech_too_short, inte no_speech_detected', () => {
        // 🔴 NEGATIVT FALL. VAD utlöste (bufferten fylldes), men varje segment slängdes
        // för att det var kortare än minimigränsen. Det är inte "VAD utlöste aldrig".
        expect(classifyTranscriptOutcome({
            ...base, mic_peak: 0.2, sys_peak: 0, vad_segments: 0, short_dropped: 2,
            whisper_text: 0, segments_saved: 0,
        })).toBe('speech_too_short');
    });

    it('utan korta segment och utan VAD-segment är det fortfarande no_speech_detected', () => {
        expect(classifyTranscriptOutcome({
            ...base, mic_peak: 0.004, sys_peak: 0, vad_segments: 0, short_dropped: 0,
            whisper_text: 0, segments_saved: 0,
        })).toBe('no_speech_detected');
    });

    it('fel går före tomma svar när ingen körning gav text', () => {
        expect(classifyTranscriptOutcome({
            ...base, whisper_text: 0, whisper_failed: 2, whisper_empty: 1, segments_saved: 0,
        })).toBe('transcriber_failed');
    });

    it('whisper som svarar tomt är transcriber_empty', () => {
        expect(classifyTranscriptOutcome({
            ...base, whisper_text: 0, whisper_empty: 3, segments_saved: 0,
        })).toBe('transcriber_empty');
    });

    it('text från whisper som inte sparades är text_lost', () => {
        expect(classifyTranscriptOutcome({ ...base, segments_saved: 0 })).toBe('text_lost');
    });

});

describe('transcriptOutcomeProps', () => {
    it('transcriber_failed bär en stabil felkod och exitkoden', () => {
        // 🔴 NEGATIVT FALL. Utan koden går en saknad modell inte att skilja från en
        // whisper-cli som kraschar, och de kräver olika rättelser.
        const props = transcriptOutcomeProps({
            ...base, whisper_text: 0, whisper_failed: 3, segments_saved: 0,
            whisper_error: 'exit_nonzero', whisper_exit_code: -1073741795,
        }, 30);
        expect(props.outcome).toBe('transcriber_failed');
        expect(props.whisper_error).toBe('exit_nonzero');
        expect(props.whisper_exit_code).toBe(-1073741795);
    });

    it('avrundar nivåerna och bär bara tal, flaggor och utfallet', () => {
        const props = transcriptOutcomeProps({ ...base, mic_peak: 0.123456789 }, 42);
        expect(props.mic_peak).toBe(0.1235);
        expect(props.duration_seconds).toBe(42);
        // Den enda strängen utöver utfallet är felkoden, som är en stabil kod och
        // aldrig fri feltext.
        const strings = Object.entries(props).filter(([, v]) => typeof v === 'string');
        expect(strings).toEqual([['outcome', 'text']]);
        const failed = transcriptOutcomeProps({ ...base, whisper_text: 0, whisper_failed: 1, segments_saved: 0, whisper_error: 'model_missing' }, 1);
        expect(Object.entries(failed).filter(([, v]) => typeof v === 'string'))
            .toEqual([['outcome', 'transcriber_failed'], ['whisper_error', 'model_missing']]);
    });
});
