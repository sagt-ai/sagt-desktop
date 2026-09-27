import type { ExportBlock, ExportFile, ExportFormat, ExportMeeting, ExportOptions } from "./types";
import { buildBlocks, meetingBlocks, sortMeetings } from "./blocks";
import { renderMd, renderTxt } from "./render-text";
import { bundleStem, dedupeNames, meetingStem } from "./filename";

const encoder = new TextEncoder();

async function render(blocks: ExportBlock[], format: ExportFormat): Promise<Uint8Array> {
    // Word- och zip-biblioteken laddas först när någon exporterar, inte när appen startar.
    if (format === "docx") return (await import("./render-docx")).renderDocx(blocks);
    return encoder.encode(format === "md" ? renderMd(blocks) : renderTxt(blocks));
}

/** Ett möte blir alltid en enda fil, oavsett valt paket. */
export function effectiveBundle(count: number, bundle: ExportOptions["bundle"]): ExportOptions["bundle"] {
    return count <= 1 ? "single" : bundle === "single" ? "zip" : bundle;
}

/**
 * Bygg exportfilen. Ett möte ger en fil; flera ger antingen ett zip-arkiv med en fil per
 * möte eller en samlad fil där mötena står i datumordning under var sin rubrik.
 */
export async function buildExport(meetings: ExportMeeting[], opts: ExportOptions): Promise<ExportFile> {
    if (meetings.length === 0) throw new Error("Inga möten att exportera");
    const bundle = effectiveBundle(meetings.length, opts.bundle);
    const ext = opts.format;

    if (bundle === "single") {
        const m = meetings[0];
        return { name: `${meetingStem(m)}.${ext}`, bytes: await render(meetingBlocks(m, opts.content), opts.format) };
    }

    if (bundle === "combined") {
        return {
            name: `${bundleStem(meetings)}.${ext}`,
            bytes: await render(buildBlocks(meetings, opts.content), opts.format),
        };
    }

    const sorted = sortMeetings(meetings);
    const names = dedupeNames(sorted.map(m => `${meetingStem(m)}.${ext}`));
    const { default: JSZip } = await import("jszip");
    const zip = new JSZip();
    for (let i = 0; i < sorted.length; i++) {
        zip.file(names[i], await render(meetingBlocks(sorted[i], opts.content), opts.format));
    }
    return { name: `${bundleStem(meetings)}.zip`, bytes: await zip.generateAsync({ type: "uint8array" }) };
}
