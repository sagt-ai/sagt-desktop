// Tidszonen sätts innan något datum formateras: filnamn och rubriker skrivs i lokal tid,
// och testmaskiner kör ofta i UTC.
process.env.TZ = "Europe/Stockholm";

import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { buildBlocks, coverageHint, filterForContent, meetingBlocks, meetingTitle } from "./blocks";
import { mdEscape, renderMd, renderTxt } from "./render-text";
import { renderDocx } from "./render-docx";
import { buildExport, effectiveBundle } from "./bundle";
import { bundleStem, datePrefix, dedupeNames, firstSentence, meetingStem, sanitizeFilename, shortenAtWord } from "./filename";
import { isExportable, parseAnalysis, selectExportSegments } from "./select";
import { buildCopyText } from "@/lib/transcript-turns";
import { EXPECTED_MD_A, EXPECTED_TXT_A, MEETING_A } from "./fixtures";
import type { ExportMeeting } from "./types";

const decoder = new TextDecoder();
const meeting = (createdAt: string, first: string, withAnalysis = true): ExportMeeting => ({
    createdAt,
    lines: [{ label: "Du", text: first }],
    analysis: withAnalysis ? { summary: `Sammanfattning ${first}`, decisions: [], actions: [] } : null,
});

async function docxXml(bytes: Uint8Array): Promise<string> {
    const zip = await JSZip.loadAsync(bytes);
    const file = zip.file("word/document.xml");
    if (!file) throw new Error("word/document.xml saknas");
    return file.async("string");
}

describe("innehållsval", () => {
    it("bara transkription: inga sektionsrubriker och inget protokoll", () => {
        const kinds = meetingBlocks(MEETING_A, "transcript").map(b => b.kind);
        expect(kinds).toEqual(["title", "turn", "turn"]);
    });

    it("bara protokoll: inga turer", () => {
        const blocks = meetingBlocks(MEETING_A, "analysis");
        expect(blocks.some(b => b.kind === "turn")).toBe(false);
        expect(blocks.filter(b => b.kind === "heading").map(b => (b as { text: string }).text))
            .toEqual(["Sammanfattning", "Beslut", "Åtgärder"]);
    });

    it("båda: Transkription före Protokoll", () => {
        const headings = meetingBlocks(MEETING_A, "both")
            .filter(b => b.kind === "heading" && b.level === 1)
            .map(b => (b as { text: string }).text);
        expect(headings).toEqual(["Transkription", "Protokoll"]);
    });

    it("möte utan protokoll: rubriken och transkriptet står kvar", () => {
        const blocks = meetingBlocks({ ...MEETING_A, analysis: null }, "both");
        expect(blocks[0]).toEqual({ kind: "title", text: "Möte 26 september 2026, 14:05" });
        expect(renderTxt(blocks)).not.toContain("PROTOKOLL");
    });

    it("tomma beslut och åtgärder får ingen rubrik", () => {
        const txt = renderTxt(meetingBlocks({ ...MEETING_A, analysis: { summary: "S.", decisions: [], actions: [] } }, "analysis"));
        expect(txt).toBe("Möte 26 september 2026, 14:05\n\nSammanfattning\nS.\n");
    });
});

describe("format", () => {
    it("txt enligt facit", () => {
        expect(renderTxt(meetingBlocks(MEETING_A, "both"))).toBe(EXPECTED_TXT_A);
    });

    it("txt:s transkript är samma text som kopiera-knappen ger", () => {
        const txt = renderTxt(meetingBlocks(MEETING_A, "transcript"));
        expect(txt).toBe(`${meetingTitle(MEETING_A.createdAt)}\n\n${buildCopyText(MEETING_A.lines)}\n`);
    });

    it("md enligt facit", () => {
        expect(renderMd(meetingBlocks(MEETING_A, "both"))).toBe(EXPECTED_MD_A);
    });

    it("md maskerar tecken som annars blir formatering", () => {
        expect(mdEscape("# rubrik")).toBe("\\# rubrik");
        expect(mdEscape("- punkt")).toBe("\\- punkt");
        expect(mdEscape("1. först")).toBe("1\\. först");
        expect(mdEscape("a*b_c")).toBe("a\\*b\\_c");
        expect(mdEscape("Vanlig mening.")).toBe("Vanlig mening.");
    });

    it("docx är ett Word-paket med transkript, rubriker och punktlista", async () => {
        const bytes = await renderDocx(meetingBlocks(MEETING_A, "both"));
        expect(decoder.decode(bytes.slice(0, 2))).toBe("PK");
        const xml = await docxXml(bytes);
        for (const s of ["Möte 26 september 2026, 14:05", "Du: ", "Hej och välkomna till mötet.", "Sammanfattning", "Budgeten godkänns."]) {
            expect(xml).toContain(s);
        }
        expect(xml).toContain("<w:numPr>");
    });

    it("docx: protokollet har samma textstorlek som transkriptet", async () => {
        const zip = await JSZip.loadAsync(await renderDocx(meetingBlocks(MEETING_A, "both")));
        const styles = await zip.file("word/styles.xml")!.async("string");
        const doc = await zip.file("word/document.xml")!.async("string");
        const size = (xml: string) => xml.match(/<w:sz w:val="(\d+)"\/>/)?.[1];
        const style = (id: string) => styles.match(new RegExp(`<w:style[^>]*w:styleId="${id}".*?</w:style>`))?.[0] ?? "";
        // Brödtexten (turer, sammanfattning) ärver dokumentets standard: 12 pt, som Word.
        expect(size(styles.match(/<w:docDefaults>.*?<\/w:docDefaults>/)?.[0] ?? "")).toBe("24");
        // Underrubrikerna (Sammanfattning, Beslut, Åtgärder) och punkterna har samma storlek.
        expect(size(style("Heading3"))).toBe("24");
        expect(size(style("ListParagraph")) ?? "24").toBe("24");
        // Inga textstycken sätter en egen storlek som bryter mönstret.
        expect(doc).not.toMatch(/<w:sz /);
        expect(styles.match(/<w:docDefaults>.*?<\/w:docDefaults>/)?.[0]).toContain('w:ascii="Calibri"');
    });

    it("docx: bara talaretiketten är fet, brödtexten uttryckligen inte", async () => {
        const zip = await JSZip.loadAsync(await renderDocx(meetingBlocks(MEETING_A, "both")));
        const doc = await zip.file("word/document.xml")!.async("string");
        const styles = await zip.file("word/styles.xml")!.async("string");
        const runs = (doc.match(/<w:r>.*?<\/w:r>/g) ?? []).map(r => ({
            text: r.replace(/<[^>]+>/g, ""),
            bold: /<w:b\/>/.test(r),
            notBold: /<w:b w:val="false"\/>/.test(r),
        }));
        const body = ["Hej och välkomna till mötet.", "Tack. Vi börjar med budgeten.", "Budgeten gicks igenom.", "Budgeten godkänns.", "Anna skickar underlaget."];
        for (const t of body) {
            const run = runs.find(r => r.text === t);
            expect(run, t).toBeDefined();
            expect(run!.notBold, t).toBe(true);
        }
        expect(runs.filter(r => r.bold).map(r => r.text)).toEqual(["Du: ", "Mötet: "]);
        // Stilen som rubrikerna bygger på finns, och den är inte fet.
        const normal = styles.match(/<w:style[^>]*w:styleId="Normal".*?<\/w:style>/)?.[0] ?? "";
        expect(normal).toContain('<w:b w:val="false"/>');
    });

    it("docx: punktlistan har Words standardindrag", async () => {
        const zip = await JSZip.loadAsync(await renderDocx(meetingBlocks(MEETING_A, "both")));
        const doc = await zip.file("word/document.xml")!.async("string");
        const numbering = await zip.file("word/numbering.xml")!.async("string");
        // Listan som punkterna i dokumentet faktiskt använder.
        const numId = doc.split(/<w:p[ >]/).find(p => p.includes("Budgeten godkänns"))?.match(/<w:numId w:val="(\d+)"\/>/)?.[1];
        expect(numId).toBeDefined();
        const abstractId = numbering.match(new RegExp(`<w:num w:numId="${numId}"><w:abstractNumId w:val="(\\d+)"`))?.[1];
        const abstract = numbering.match(new RegExp(`<w:abstractNum [^>]*w:abstractNumId="${abstractId}".*?</w:abstractNum>`))?.[0] ?? "";
        expect(abstract).toContain('<w:ind w:left="720" w:hanging="360"/>');
    });

    it("docx utan protokoll innehåller inget protokoll", async () => {
        const xml = await docxXml(await renderDocx(meetingBlocks(MEETING_A, "transcript")));
        expect(xml).not.toContain("Sammanfattning");
        expect(xml).not.toContain("Protokoll");
    });
});

describe("flera möten", () => {
    const later = meeting("2026-09-26T08:00:00Z", "Tredje.");
    const first = meeting("2026-09-01T07:30:00Z", "Första.");
    const middle = meeting("2026-09-10T13:15:00Z", "Andra.");

    it("samlad fil: kronologisk ordning med en datumrubrik per möte", () => {
        const md = renderMd(buildBlocks([later, first, middle], "both"));
        const titles = md.split("\n").filter(l => l.startsWith("# "));
        expect(titles).toEqual([
            "# Möte 1 september 2026, 09:30",
            "# Möte 10 september 2026, 15:15",
            "# Möte 26 september 2026, 10:00",
        ]);
        expect(md.indexOf("Första.")).toBeLessThan(md.indexOf("Andra."));
        expect(md.indexOf("Andra.")).toBeLessThan(md.indexOf("Tredje."));
    });

    it("samlad fil får periodens namn", async () => {
        const file = await buildExport([later, first], { format: "txt", content: "transcript", bundle: "combined" });
        expect(file.name).toBe("Möten 2026-09-01 – 2026-09-26.txt");
        const txt = decoder.decode(file.bytes);
        expect(txt.indexOf("Första.")).toBeLessThan(txt.indexOf("Tredje."));
    });

    it("zip: en fil per möte, unika namn", async () => {
        const twin = meeting("2026-09-01T07:30:00Z", "Första.");
        const file = await buildExport([later, first, twin], { format: "md", content: "both", bundle: "zip" });
        expect(file.name).toBe("Möten 2026-09-01 – 2026-09-26.zip");
        const zip = await JSZip.loadAsync(file.bytes);
        expect(Object.keys(zip.files).sort()).toEqual([
            "2026-09-01 0930 – Första (2).md",
            "2026-09-01 0930 – Första.md",
            "2026-09-26 1000 – Tredje.md",
        ]);
    });

    it("zip med docx: varje fil är ett Word-paket", async () => {
        const file = await buildExport([later, first], { format: "docx", content: "transcript", bundle: "zip" });
        const zip = await JSZip.loadAsync(file.bytes);
        const inner = await zip.file("2026-09-26 1000 – Tredje.docx")!.async("uint8array");
        expect(await docxXml(inner)).toContain("Tredje.");
    });

    it("samlad Word-fil: ny sida per möte, löpande text inom mötet, luft före protokollet", async () => {
        // Tre möten med två turer och protokoll var.
        const full = (d: string, t: string): ExportMeeting => ({ ...MEETING_A, createdAt: d, lines: [{ label: "Du", text: t }, { label: "Mötet", text: "Svar." }] });
        const file = await buildExport(
            [full("2026-09-26T08:00:00Z", "Tredje."), full("2026-09-01T07:30:00Z", "Första."), full("2026-09-10T13:15:00Z", "Andra.")],
            { format: "docx", content: "both", bundle: "combined" },
        );
        const xml = await docxXml(file.bytes);
        const paras = xml.split(/<w:p[ >]/).slice(1).map(p => ({
            text: p.replace(/<[^>]+>/g, ""),
            pageBreak: p.includes("<w:pageBreakBefore"),
            gap: p.includes('w:before="240"'),
        }));
        // Sidbrytning bara före mötesrubrikerna 2 och 3, aldrig före en tur eller protokollet.
        expect(paras.filter(p => p.pageBreak).map(p => p.text)).toEqual([
            "Möte 10 september 2026, 15:15",
            "Möte 26 september 2026, 10:00",
        ]);
        // Protokollet står i samma möte, med en tom rad ovanför.
        const protocol = paras.filter(p => p.text === "Protokoll");
        expect(protocol).toHaveLength(3);
        expect(protocol.every(p => p.gap && !p.pageBreak)).toBe(true);
    });

    it("möten utan det valda innehållet tas inte med", async () => {
        const noAnalysis = meeting("2026-09-10T13:15:00Z", "Utan protokoll.", false);
        const onlyAnalysis: ExportMeeting = { createdAt: "2026-09-12T08:00:00Z", lines: [], analysis: { summary: "Bara protokoll.", decisions: [], actions: [] } };
        const all = [first, noAnalysis, onlyAnalysis];
        expect(filterForContent(all, "analysis").map(m => m.createdAt)).toEqual([first.createdAt, onlyAnalysis.createdAt]);
        expect(filterForContent(all, "transcript").map(m => m.createdAt)).toEqual([first.createdAt, noAnalysis.createdAt]);
        expect(filterForContent(all, "both")).toHaveLength(3);
        // Hela kedjan: en samlad protokollfil får bara rubriker för möten med protokoll.
        const md = renderMd(buildBlocks(filterForContent(all, "analysis"), "analysis"));
        expect(md.split("\n").filter(l => l.startsWith("# "))).toHaveLength(2);
        expect(md).not.toContain("10 september");
    });

    it("dialogen säger när bara en del av mötena har innehållet", () => {
        expect(coverageHint("analysis", 40, 40, 1)).toBe("Protokoll finns för 1 av 40 möten. Övriga tas inte med.");
        expect(coverageHint("transcript", 3, 2, 3)).toBe("Transkription finns för 2 av 3 möten. Övriga tas inte med.");
        expect(coverageHint("both", 3, 3, 1)).toBe("Protokoll finns för 1 av 3 möten. Övriga exporteras med bara transkription.");
        expect(coverageHint("analysis", 2, 2, 2)).toBeNull();
        expect(coverageHint("analysis", 1, 1, 0)).toBeNull();
    });

    it("ett enda möte blir alltid en fil", async () => {
        expect(effectiveBundle(1, "zip")).toBe("single");
        expect(effectiveBundle(3, "single")).toBe("zip");
        const file = await buildExport([MEETING_A], { format: "docx", content: "both", bundle: "zip" });
        expect(file.name).toBe("2026-09-26 1405 – Hej och välkomna till mötet.docx");
    });
});

describe("filnamn", () => {
    it("datum och klockslag i lokal tid", () => {
        expect(datePrefix("2026-09-26T12:05:00Z")).toBe("2026-09-26 1405");
        expect(datePrefix("2026-01-15T23:30:00Z")).toBe("2026-01-16 0030");
    });

    it("första meningen", () => {
        expect(firstSentence("Hej allihop. Nu börjar vi.")).toBe("Hej allihop.");
        expect(firstSentence("Klar!  Nästa")).toBe("Klar!");
        expect(firstSentence("Hur går det? Bra")).toBe("Hur går det?");
        expect(firstSentence("Version 2.5 är ute")).toBe("Version 2.5 är ute");
    });

    it("kortas vid ett ordslut", () => {
        const long = "Det här är en väldigt lång första mening som fortsätter långt förbi gränsen";
        const short = shortenAtWord(long);
        expect(short.length).toBeLessThanOrEqual(60);
        expect(long.startsWith(short)).toBe(true);
        expect(long[short.length]).toBe(" ");
    });

    it("tecken som Windows och macOS inte tillåter tas bort", () => {
        expect(sanitizeFilename('a\\b/c:d*e?f"g<h>i|j')).toBe("a b c d e f g h i j");
        expect(sanitizeFilename("rad\nett\ttvå")).toBe("rad ett två");
        expect(sanitizeFilename("Slut. ")).toBe("Slut");
    });

    it("namnet tas från transkriptet, annars sammanfattningen, annars inspelningen", () => {
        expect(meetingStem(MEETING_A)).toBe("2026-09-26 1405 – Hej och välkomna till mötet");
        expect(meetingStem({ ...MEETING_A, lines: [] })).toBe("2026-09-26 1405 – Budgeten gicks igenom");
        expect(meetingStem({ createdAt: MEETING_A.createdAt, lines: [], analysis: null, fallbackTitle: "session_1" }))
            .toBe("2026-09-26 1405 – session_1");
        expect(meetingStem({ createdAt: MEETING_A.createdAt, lines: [{ label: null, text: "???" }], analysis: null }))
            .toBe("2026-09-26 1405 – Möte");
    });

    it("dubbletter numreras", () => {
        expect(dedupeNames(["a.txt", "b.txt", "a.txt", "A.txt"])).toEqual(["a.txt", "b.txt", "a (2).txt", "A (3).txt"]);
    });

    it("samma dag ger ett datum i namnet", () => {
        expect(bundleStem([meeting("2026-09-26T08:00:00Z", "x"), meeting("2026-09-26T12:00:00Z", "y")])).toBe("Möten 2026-09-26");
    });
});

describe("inspelningar", () => {
    const local = [
        { start_time: 5, end_time: 6, text: "Sen", speaker: "DU" },
        { start_time: 1, end_time: 2, text: "Först", speaker: "DU" },
    ];

    it("molnets turer går före de lokala", () => {
        const cloud = JSON.stringify([{ start_time: 0, end_time: 1, text: "Moln", speaker: "MÖTET" }]);
        expect(selectExportSegments({ cloud_segments: cloud, cloud_transcript: "blob" }, local).map(s => s.text)).toEqual(["Moln"]);
    });

    it("molntext utan turer blir ett stycke utan talare", () => {
        expect(selectExportSegments({ cloud_transcript: " Allt " }, local)).toEqual([{ start_time: 0, end_time: 0, text: "Allt", speaker: "MOLN" }]);
    });

    it("annars de lokala segmenten i tidsordning, även när molndata är trasig", () => {
        expect(selectExportSegments({ cloud_segments: "{trasig" }, local).map(s => s.text)).toEqual(["Först", "Sen"]);
    });

    it("protokollet tolkas, trasigt eller tomt ger inget", () => {
        expect(parseAnalysis('{"summary":"S","decisions":["B"],"actions":[]}')).toEqual({ summary: "S", decisions: ["B"], actions: [] });
        expect(parseAnalysis("{trasig")).toBeNull();
        expect(parseAnalysis('{"summary":"","decisions":[],"actions":[]}')).toBeNull();
        expect(parseAnalysis(undefined)).toBeNull();
    });

    it("exporterbar när det finns transkript eller protokoll", () => {
        expect(isExportable({ has_segments: true })).toBe(true);
        expect(isExportable({ has_segments: false, cloud_transcript: "x" })).toBe(true);
        expect(isExportable({ has_segments: false, analysis_json: '{"summary":"S"}' })).toBe(true);
        expect(isExportable({ has_segments: false, analysis_json: "{trasig", cloud_transcript: " " })).toBe(false);
    });
});
