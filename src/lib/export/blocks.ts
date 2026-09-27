import { format } from "date-fns";
import { sv } from "date-fns/locale";
import type { ExportBlock, ExportContent, ExportMeeting } from "./types";

/** "Möte 26 september 2026, 14:05" — samma datumform som listan Inspelningar, lokal tid. */
export function meetingTitle(createdAt: string): string {
    return `Möte ${format(new Date(createdAt), "d MMMM yyyy, HH:mm", { locale: sv })}`;
}

/** Tidigast först. Ogiltiga datum hamnar sist i den ordning de kom. */
export function sortMeetings(meetings: ExportMeeting[]): ExportMeeting[] {
    const t = (m: ExportMeeting) => {
        const v = new Date(m.createdAt).getTime();
        return Number.isNaN(v) ? Number.POSITIVE_INFINITY : v;
    };
    return [...meetings].sort((a, b) => t(a) - t(b));
}

/**
 * Ett mötes block: rubrik med datum, sedan transkript och/eller protokoll.
 * Sektionsrubrikerna "Transkription" och "Protokoll" skrivs bara när båda ingår.
 * Saknas underlaget för en del utelämnas den, men mötets rubrik står alltid kvar.
 */
export function meetingBlocks(m: ExportMeeting, content: ExportContent): ExportBlock[] {
    const out: ExportBlock[] = [{ kind: "title", text: meetingTitle(m.createdAt) }];
    const both = content === "both";

    if (content !== "analysis" && m.lines.length > 0) {
        if (both) out.push({ kind: "heading", level: 1, text: "Transkription" });
        for (const l of m.lines) out.push({ kind: "turn", label: l.label, text: l.text });
    }

    const a = m.analysis;
    if (content !== "transcript" && a) {
        if (both) out.push({ kind: "heading", level: 1, text: "Protokoll" });
        if (a.summary.trim()) {
            out.push({ kind: "heading", level: 2, text: "Sammanfattning" });
            out.push({ kind: "paragraph", text: a.summary.trim() });
        }
        if (a.decisions.length > 0) {
            out.push({ kind: "heading", level: 2, text: "Beslut" });
            for (const d of a.decisions) out.push({ kind: "bullet", text: d });
        }
        if (a.actions.length > 0) {
            out.push({ kind: "heading", level: 2, text: "Åtgärder" });
            for (const x of a.actions) out.push({ kind: "bullet", text: x });
        }
    }
    return out;
}

/** Har mötet något av det valda innehållet? "Båda" räcker med det ena. */
export function hasContentFor(m: ExportMeeting, content: ExportContent): boolean {
    const t = m.lines.length > 0;
    const a = m.analysis !== null;
    return content === "transcript" ? t : content === "analysis" ? a : t || a;
}

/**
 * Möten utan det valda innehållet tas inte med. Annars skulle "Bara protokoll" över
 * många möten, där få har protokoll, ge en fil per möte med bara en rubrik.
 */
export function filterForContent(meetings: ExportMeeting[], content: ExportContent): ExportMeeting[] {
    return meetings.filter(m => hasContentFor(m, content));
}

/**
 * Säger när bara en del av mötena har det valda innehållet. Mötena utan tas inte med,
 * så att en fil aldrig består av tomma rubriker.
 */
export function coverageHint(content: ExportContent, count: number, transcriptCount: number, analysisCount: number): string | null {
    if (count <= 1) return null;
    if (content === "analysis" && analysisCount < count) {
        return `Protokoll finns för ${analysisCount} av ${count} möten. Övriga tas inte med.`;
    }
    if (content === "transcript" && transcriptCount < count) {
        return `Transkription finns för ${transcriptCount} av ${count} möten. Övriga tas inte med.`;
    }
    if (content === "both" && analysisCount < count) {
        return `Protokoll finns för ${analysisCount} av ${count} möten. Övriga exporteras med bara transkription.`;
    }
    return null;
}

/** Flera möten i en fil: kronologiskt, varje möte under sin datumrubrik. */
export function buildBlocks(meetings: ExportMeeting[], content: ExportContent): ExportBlock[] {
    return sortMeetings(meetings).flatMap(m => meetingBlocks(m, content));
}
