import type { TranscriptLine } from "@/lib/transcript-turns";

export type ExportFormat = "txt" | "md" | "docx" | "pdf";
export type ExportContent = "transcript" | "analysis" | "both";
/** single = ett möte; zip = en fil per möte i ett arkiv; combined = alla möten i en fil. */
export type ExportBundle = "single" | "zip" | "combined";
export type ExportScope = "current" | "selected";

export interface ExportAnalysis {
    summary: string;
    decisions: string[];
    actions: string[];
}

export interface ExportMeeting {
    /** Mötets start, ISO 8601 (UTC). Visas och sätts i filnamnet i lokal tid. */
    createdAt: string;
    /** Transkriptet som vyn visar det. Tomt när mötet saknar transkript. */
    lines: TranscriptLine[];
    analysis: ExportAnalysis | null;
    /** Används i filnamnet när varken transkript eller sammanfattning finns. */
    fallbackTitle?: string;
}

export interface ExportOptions {
    format: ExportFormat;
    content: ExportContent;
    bundle: ExportBundle;
}

/** Formatoberoende innehåll; renderarna översätter blocken till txt, md, docx eller pdf. */
export type ExportBlock =
    | { kind: "title"; text: string }
    | { kind: "heading"; level: 1 | 2; text: string }
    | { kind: "paragraph"; text: string }
    | { kind: "bullet"; text: string }
    | { kind: "turn"; label: string | null; text: string };

export interface ExportFile {
    name: string;
    bytes: Uint8Array;
}
