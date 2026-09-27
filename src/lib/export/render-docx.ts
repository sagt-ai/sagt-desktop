import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import type { ExportBlock } from "./types";

const BULLETS = "bullets";
// En tom rad (12 pt i twips) före en sektion inom mötet.
const SECTION_GAP = 240;

// Typografi: storlekarna följer Words standard sedan 2023 (brödtext 12 pt, Rubrik 1
// 20 pt, Rubrik 2 16 pt, Words rubrikfärg; storlekar i halvpunkter). Typsnittet är
// Calibri, som finns i Windows och som macOS tillhandahåller; Words nya Aptos följer
// bara med Microsoft 365. Protokollets underrubriker är fet brödtext, som
// talaretiketterna i transkriptet, så att de två delarna ser likadana ut.
//
// Brödtexten har en egen stil (Normal) och varje run är uttryckligen icke-fet. I Pages
// (2026-09-26) visades brödtexten fet när dokumentet saknade Normal-stilen, som
// rubrikstilarna bygger på. Med stilen på plats och fetstilen avslagen per run kan inget
// ärva fetstil från en rubrik eller från talaretiketten.
const FONT = "Calibri";
const BODY = 24;
const HEADING_COLOR = "0F4761";
const NORMAL = "Normal";
const STYLES = {
    default: {
        document: { run: { font: FONT, size: BODY } },
        heading1: { run: { font: FONT, size: 40, bold: true, color: HEADING_COLOR }, paragraph: { spacing: { after: 120 } } },
        heading2: { run: { font: FONT, size: 32, bold: true, color: HEADING_COLOR }, paragraph: { spacing: { after: 120 } } },
        heading3: { run: { font: FONT, size: BODY, bold: true, color: "000000" }, paragraph: { spacing: { before: 120, after: 40 } } },
        listParagraph: { run: { font: FONT, size: BODY, bold: false } },
    },
    paragraphStyles: [
        { id: NORMAL, name: "Normal", quickFormat: true, run: { font: FONT, size: BODY, bold: false } },
    ],
};

/** Brödtext: uttryckligen inte fet. */
const plain = (text: string) => new TextRun({ text, bold: false });

function toParagraph(b: ExportBlock, index: number): Paragraph {
    switch (b.kind) {
        case "title":
            return new Paragraph({
                text: b.text,
                heading: HeadingLevel.HEADING_1,
                // I en samlad fil börjar varje möte utom det första på en ny sida.
                pageBreakBefore: index > 0,
            });
        case "heading":
            return new Paragraph({
                text: b.text,
                heading: b.level === 1 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
                // "Transkription" och "Protokoll": en tom rad ovanför, ingen sidbrytning.
                ...(b.level === 1 ? { spacing: { before: SECTION_GAP } } : {}),
            });
        case "paragraph":
            return new Paragraph({ style: NORMAL, children: [plain(b.text)], spacing: { after: 160 } });
        case "bullet":
            return new Paragraph({ children: [plain(b.text)], numbering: { reference: BULLETS, level: 0 } });
        case "turn":
            return new Paragraph({
                style: NORMAL,
                children: b.label
                    ? [new TextRun({ text: `${b.label}: `, bold: true }), plain(b.text)]
                    : [plain(b.text)],
                spacing: { after: 160 },
            });
    }
}

/** Word-dokument (.docx) som byte. Byggs helt i klienten, utan nätverk. */
export async function renderDocx(blocks: ExportBlock[]): Promise<Uint8Array> {
    const doc = new Document({
        creator: "Sagt.ai",
        styles: STYLES,
        numbering: {
            config: [{
                reference: BULLETS,
                // Words standardindrag för punktlistor: 1,27 cm, punkten hänger 0,63 cm.
                // Utan uttryckligt indrag lägger Pages texten i en smal kolumn långt åt höger.
                levels: [{
                    level: 0, format: "bullet", text: "•", alignment: "left",
                    style: { paragraph: { indent: { left: 720, hanging: 360 } } },
                }],
            }],
        },
        sections: [{ children: blocks.map((b, i) => toParagraph(b, i)) }],
    });
    // toBlob fungerar både i appens webbvy och i Node; toBuffer skulle kräva Node.
    const blob = await Packer.toBlob(doc);
    return new Uint8Array(await blob.arrayBuffer());
}
