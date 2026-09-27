// Hur ett transkript läses upp: gruppering i talarturer, sammanhängande stycken och
// talaretiketter. Delas av transkriptvyn (det som visas och det kopiera-knappen kopierar)
// och av filexporten, så att en exporterad fil alltid innehåller samma text som vyn.
//
// Håll modulen fri från runtime-importer utöver speaker-naming (som själv bara har
// typimporter statiskt), så att den går att testa i Node utan webbläsare.
import { speakerKey } from "@/lib/speaker-naming";

/** Minsta form på ett segment som turerna byggs av. */
export interface TurnInput {
    start_time: number;
    end_time: number;
    text: string;
    speaker: string;
}

export interface Turn {
    speaker: string;
    text: string;
    start_time: number;
    end_time: number;
}

/** En rad i ett uppläst transkript: talaretikett (null = ingen talare) och text. */
export interface TranscriptLine {
    label: string | null;
    text: string;
}

/**
 * Strukturerade molnsegment (sparade som JSON på inspelningen). Tomma texter filtreras,
 * saknad talare blir "MÖTET". Ogiltig JSON eller annat än en lista ger [].
 */
export function parseCloudSegments(raw: string | null | undefined): TurnInput[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .filter((s: any) => String(s?.text ?? "").trim())
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((s: any) => ({
                start_time: s.start_time ?? 0,
                end_time: s.end_time ?? 0,
                text: String(s.text).trim(),
                speaker: s.speaker || "MÖTET",
            }));
    } catch {
        return [];
    }
}

/** Standardetikett när användaren inte namngett talaren: Du, Mötet, Talare 1 … */
export function defaultLabel(sp: string): string {
    const k = speakerKey(sp);
    if (k === "DU") return "Du";
    if (k === "MÖTET") return "Mötet";
    // Numrerade etiketter → svensk titelform (TALARE 1 → "Talare 1").
    const m = k.match(/^(DU|MÖTET|TALARE)\s+(\d+)$/);
    if (m) {
        const base = m[1] === "TALARE" ? "Talare" : m[1] === "DU" ? "Du" : "Mötet";
        return `${base} ${m[2]}`;
    }
    return sp;
}

/** Användarens namn på talaren om det finns, annars standardetiketten. */
export function speakerLabel(sp: string, map: Record<string, string>): string {
    return map[speakerKey(sp)] || defaultLabel(sp);
}

/** Sammanhängande läge: all text är ett flöde utan talare ("MOLN"). */
export function isMergedView(segments: TurnInput[]): boolean {
    return segments.length > 0 && segments.every(s => s.speaker === "MOLN");
}

/** Stycken i sammanhängande läge: nytt stycke vid en paus ≥ pauseBreakMs. */
export function mergedParagraphs(segments: TurnInput[], pauseBreakMs: number): string[] {
    const paras: string[] = [];
    let cur = "";
    let prevEnd: number | null = null;
    for (const s of segments) {
        const t = s.text.trim();
        if (!t) continue;
        if (prevEnd != null && (s.start_time - prevEnd) * 1000 >= pauseBreakMs) {
            if (cur) paras.push(cur);
            cur = t;
        } else {
            cur = cur ? `${cur} ${t}` : t;
        }
        prevEnd = s.end_time || s.start_time;
    }
    if (cur) paras.push(cur);
    return paras;
}

/**
 * Slå ihop på varandra följande segment med samma talare till en tur. Ny tur vid
 * talarbyte eller paus ≥ pauseBreakMs. Segment med nospeech-markören och tomma
 * segment hoppas över. Talarna jämförs som de står (inte kanoniserade).
 */
export function groupTurns(segments: TurnInput[], pauseBreakMs: number): Turn[] {
    const out: Turn[] = [];
    for (const s of segments) {
        if (s.text.includes("<|nospeech|>")) continue;
        const t = s.text.trim();
        if (!t) continue;
        const last = out[out.length - 1];
        const gap = last ? (s.start_time - last.end_time) * 1000 : 0;
        if (last && last.speaker === s.speaker && gap < pauseBreakMs) {
            last.text += " " + t;
            last.end_time = s.end_time || s.start_time;
        } else {
            out.push({ speaker: s.speaker, text: t, start_time: s.start_time, end_time: s.end_time || s.start_time });
        }
    }
    return out;
}

/** Transkriptet som rader, exakt som vyn visar det. */
export function transcriptLines(
    segments: TurnInput[],
    map: Record<string, string>,
    pauseBreakMs: number,
): TranscriptLine[] {
    if (isMergedView(segments)) {
        return mergedParagraphs(segments, pauseBreakMs).map(text => ({ label: null, text }));
    }
    return groupTurns(segments, pauseBreakMs).map(turn => ({
        label: turn.speaker === "MOLN" ? null : speakerLabel(turn.speaker, map),
        text: turn.text,
    }));
}

/** Texten som kopiera-knappen lägger i urklipp: "Talare: text", tomrad mellan turer. */
export function buildCopyText(lines: TranscriptLine[]): string {
    return lines.map(l => (l.label ? `${l.label}: ${l.text}` : l.text)).join("\n\n");
}
