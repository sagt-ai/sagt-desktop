import { parseCloudSegments, type TurnInput } from "@/lib/transcript-turns";
import type { ExportAnalysis } from "./types";

/** Det en inspelningsrad bär som exporten behöver. */
export interface ExportableRecording {
    has_segments: boolean;
    analysis_json?: string | null;
    cloud_transcript?: string | null;
    cloud_segments?: string | null;
}

/**
 * Vilket transkript som exporteras för en sparad inspelning: samma som vyn visar när
 * inspelningen öppnas. Molnresultatet går före det lokala när det finns (strukturerade
 * turer först, annars molntexten som ett stycke); annars de lokala segmenten i tidsordning.
 */
export function selectExportSegments(
    rec: Pick<ExportableRecording, "cloud_segments" | "cloud_transcript">,
    local: TurnInput[],
): TurnInput[] {
    const structured = parseCloudSegments(rec.cloud_segments);
    if (structured.length > 0) return structured;
    const blob = rec.cloud_transcript?.trim();
    if (blob) return [{ start_time: 0, end_time: 0, text: blob, speaker: "MOLN" }];
    return [...local].sort((a, b) => (a.start_time || 0) - (b.start_time || 0));
}

/** Protokollet som sparats med inspelningen, eller null om det saknas eller är trasigt. */
export function parseAnalysis(raw: string | null | undefined): ExportAnalysis | null {
    if (!raw) return null;
    try {
        const a = JSON.parse(raw);
        if (!a || typeof a !== "object") return null;
        const list = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(s => s.trim()) : []);
        const out: ExportAnalysis = {
            summary: typeof a.summary === "string" ? a.summary : "",
            decisions: list(a.decisions),
            actions: list(a.actions),
        };
        return out.summary.trim() || out.decisions.length || out.actions.length ? out : null;
    } catch {
        return null;
    }
}

/** Har inspelningen ett transkript, lokalt eller från molnet? */
export function hasTranscriptSource(rec: ExportableRecording): boolean {
    return rec.has_segments
        || parseCloudSegments(rec.cloud_segments).length > 0
        || !!rec.cloud_transcript?.trim();
}

/** Har inspelningen ett protokoll med innehåll? */
export function hasAnalysisSource(rec: ExportableRecording): boolean {
    return parseAnalysis(rec.analysis_json) !== null;
}

/** Finns det något att exportera: transkript (lokalt eller moln) eller ett protokoll. */
export function isExportable(rec: ExportableRecording): boolean {
    return hasTranscriptSource(rec) || hasAnalysisSource(rec);
}

/** Export ingår i Pro. Allt annat än en aktiv prenumeration ger nej. */
export function canExport(stripeStatus: string | null | undefined): boolean {
    return stripeStatus === "active";
}
