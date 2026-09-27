// Exportens två kontakter med operativsystemet: läsa sparade möten ur den lokala
// databasen och spara den färdiga filen där användaren väljer. Allt annat i exporten är
// rena funktioner utan Tauri.
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { parseSpeakerData } from "@/lib/speaker-naming";
import { transcriptLines, type TurnInput } from "@/lib/transcript-turns";
import { FILE_FILTERS } from "./filename";
import { sortMeetings } from "./blocks";
import { parseAnalysis, selectExportSegments, type ExportableRecording } from "./select";
import type { ExportBundle, ExportFile, ExportFormat, ExportMeeting } from "./types";

export interface RecordingForExport extends ExportableRecording {
    id: number;
    filename: string;
    created_at: string;
    speaker_map?: string | null;
}

/** Bygg exportens möten ur sparade inspelningar. Allt läses lokalt; inget nätverk. */
export async function collectMeetings(recs: RecordingForExport[], pauseBreakMs: number): Promise<ExportMeeting[]> {
    const meetings: ExportMeeting[] = [];
    for (const rec of recs) {
        const local = rec.has_segments
            ? await invoke<TurnInput[]>("get_recording_segments", { recordingId: rec.id })
            : [];
        const segments = selectExportSegments(rec, local);
        meetings.push({
            createdAt: rec.created_at,
            lines: transcriptLines(segments, parseSpeakerData(rec.speaker_map).map, pauseBreakMs),
            analysis: parseAnalysis(rec.analysis_json),
            fallbackTitle: rec.filename.replace(/\.[^.]+$/, ""),
        });
    }
    return sortMeetings(meetings);
}

/**
 * Visa "Spara som" och skriv filen. Returnerar false när användaren avbryter.
 * Appen får bara skriva till den fil som valts i dialogen.
 */
export async function saveExportFile(file: ExportFile, format: ExportFormat, bundle: ExportBundle): Promise<boolean> {
    const filter = bundle === "zip" ? FILE_FILTERS.zip : FILE_FILTERS[format];
    const path = await save({ defaultPath: file.name, filters: [filter] });
    if (!path) return false;
    await writeFile(path, file.bytes);
    return true;
}
