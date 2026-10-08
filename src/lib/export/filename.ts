import { format } from "date-fns";
import type { ExportFormat, ExportMeeting } from "./types";
import { sortMeetings } from "./blocks";

export const MAX_TITLE_CHARS = 60;

/** Första meningen: fram till första . ! ? som följs av blanksteg eller textslut. */
export function firstSentence(text: string): string {
    const t = text.replace(/\s+/g, " ").trim();
    const m = t.match(/^(.+?[.!?])(?=\s|$)/);
    return (m ? m[1] : t).trim();
}

/** Korta vid ett ordslut så att resultatet är högst `max` tecken. */
export function shortenAtWord(s: string, max = MAX_TITLE_CHARS): string {
    if (s.length <= max) return s;
    const cut = s.slice(0, max + 1);
    const space = cut.lastIndexOf(" ");
    return (space > 0 ? cut.slice(0, space) : s.slice(0, max)).trim();
}

/**
 * Giltigt filnamn på Windows och macOS: tecknen \ / : * ? " < > | och kontrolltecken
 * blir blanksteg, blanksteg slås ihop, och avslutande punkt eller blanksteg tas bort
 * (Windows tillåter dem inte sist i ett namn).
 */
export function sanitizeFilename(s: string): string {
    return s
        // eslint-disable-next-line no-control-regex
        .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/[. ]+$/, "");
}

/** "2026-09-26 1405" i lokal tid. */
export function datePrefix(createdAt: string): string {
    return format(new Date(createdAt), "yyyy-MM-dd HHmm");
}

function titleSource(m: ExportMeeting): string {
    const candidates = [m.lines[0]?.text, m.analysis?.summary, m.fallbackTitle];
    for (const c of candidates) {
        const t = sanitizeFilename(shortenAtWord(firstSentence(c ?? "")));
        if (t) return t;
    }
    return "Möte";
}

/** "2026-09-26 1405 – Vi börjar med budgeten." utan ändelse. */
export function meetingStem(m: ExportMeeting): string {
    return `${datePrefix(m.createdAt)} – ${titleSource(m)}`;
}

/** Namn på en samlad fil eller ett arkiv: "Möten 2026-09-01 – 2026-09-26". */
export function bundleStem(meetings: ExportMeeting[]): string {
    const sorted = sortMeetings(meetings);
    if (sorted.length === 0) return "Möten";
    const first = format(new Date(sorted[0].createdAt), "yyyy-MM-dd");
    const last = format(new Date(sorted[sorted.length - 1].createdAt), "yyyy-MM-dd");
    return first === last ? `Möten ${first}` : `Möten ${first} – ${last}`;
}

/** Unika namn i ett arkiv: andra "a.txt" blir "a (2).txt", tredje "a (3).txt". */
export function dedupeNames(names: string[]): string[] {
    const seen = new Map<string, number>();
    const taken = new Set<string>();
    return names.map(name => {
        const key = name.toLowerCase();
        if (!taken.has(key)) {
            taken.add(key);
            seen.set(key, 1);
            return name;
        }
        const dot = name.lastIndexOf(".");
        const base = dot > 0 ? name.slice(0, dot) : name;
        const ext = dot > 0 ? name.slice(dot) : "";
        let n = seen.get(key) ?? 1;
        let candidate: string;
        do {
            n++;
            candidate = `${base} (${n})${ext}`;
        } while (taken.has(candidate.toLowerCase()));
        seen.set(key, n);
        taken.add(candidate.toLowerCase());
        return candidate;
    });
}

export const FILE_FILTERS: Record<ExportFormat | "zip", { name: string; extensions: string[] }> = {
    docx: { name: "Word-dokument", extensions: ["docx"] },
    pdf: { name: "PDF-dokument", extensions: ["pdf"] },
    md: { name: "Markdown", extensions: ["md"] },
    txt: { name: "Textfil", extensions: ["txt"] },
    zip: { name: "Zip-arkiv", extensions: ["zip"] },
};
