import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "@pdfme/pdf-lib";
import type { ExportBlock } from "./types";

// PDF med samma innehåll och ordning som Word-exporten: mötets rubrik, sektionerna,
// protokollets underrubriker med stycken och punkter, och transkriptets turer med fet
// talaretikett. Byggs helt i klienten, utan nätverk.
//
// Typsnittet är Helvetica, ett av PDF:ens standardtypsnitt: det bäddas inte in, så filen
// blir några kilobyte i stället för flera hundra. Standardtypsnitten täcker teckentabellen
// WinAnsi (svenska, övriga västeuropeiska språk, typografiska citattecken och tankstreck).
// Tecken utanför den (till exempel polska ł eller emoji) ersätts, se `encodable`.

const PAGE_WIDTH = 595.28; // A4 i punkter
const PAGE_HEIGHT = 841.89;
const MARGIN = 64;
const CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN;

const BODY = 11;
const LEADING = 1.35;
const TITLE = 20;
const HEADING_1 = 16;
const HEADING_COLOR = rgb(0x0f / 255, 0x47 / 255, 0x61 / 255); // samma som Word-exporten
const BLACK = rgb(0, 0, 0);
const BULLET_INDENT = 18;

type Run = { text: string; bold: boolean };
type Piece = { text: string; font: PDFFont; width: number };

interface Fonts {
    regular: PDFFont;
    bold: PDFFont;
    /** Tecken som standardtypsnittet kan skriva (samma för normal och fet). */
    charset: Set<number>;
}

/**
 * Texten med varje tecken som typsnittet inte kan skriva ersatt: först utan accent
 * (ŕ → r), annars med ett frågetecken. Tabb blir blanksteg, osynliga tecken försvinner.
 * Utan det kastar biblioteket på första sådana tecken och hela exporten misslyckas.
 */
export function encodable(text: string, charset: Set<number>): string {
    let out = "";
    for (const ch of text.normalize("NFC")) {
        const cp = ch.codePointAt(0)!;
        if (charset.has(cp)) { out += ch; continue; }
        if (ch === "\t") { out += " "; continue; }
        // Nollbreda tecken och riktningsmarkörer syns inte; ta bort dem.
        if (/[​-‏⁠﻿]/.test(ch)) continue;
        const base = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "");
        if (base && [...base].every(c => charset.has(c.codePointAt(0)!))) { out += base; continue; }
        out += "?";
    }
    return out;
}

class Writer {
    private page!: PDFPage;
    private y = 0;
    /** Har den aktuella sidan något innehåll? Styr sidbrytningen före ett nytt möte. */
    private pageHasContent = false;

    constructor(private readonly doc: PDFDocument, private readonly fonts: Fonts) {
        this.newPage();
    }

    newPage(): void {
        this.page = this.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        this.y = PAGE_HEIGHT - MARGIN;
        this.pageHasContent = false;
    }

    /** Ny sida om den aktuella redan har innehåll (varje möte efter det första). */
    breakPageIfUsed(): void {
        if (this.pageHasContent) this.newPage();
    }

    space(pt: number): void {
        // Mellanrum överst på en sida behövs inte.
        if (this.pageHasContent) this.y -= pt;
    }

    /** Skriv runs radbrutna inom bredden, med indrag och valfritt tecken framför första raden. */
    paragraph(runs: Run[], size: number, color = BLACK, opts: { indent?: number; marker?: string } = {}): void {
        const indent = opts.indent ?? 0;
        const lines = this.wrap(runs, size, CONTENT_WIDTH - indent);
        const lineHeight = size * LEADING;
        lines.forEach((line, i) => {
            if (this.y - lineHeight < MARGIN) this.newPage();
            const baseline = this.y - size;
            if (i === 0 && opts.marker) {
                this.page.drawText(opts.marker, { x: MARGIN + indent - 12, y: baseline, size, font: this.fonts.regular, color });
            }
            // Ett anrop per typsnitt och rad: ord i samma typsnitt ritas som en sträng.
            let x = MARGIN + indent;
            for (let j = 0; j < line.length;) {
                const font = line[j].font;
                let text = "";
                let width = 0;
                for (; j < line.length && line[j].font === font; j++) {
                    text += line[j].text;
                    width += line[j].width;
                }
                this.page.drawText(text, { x, y: baseline, size, font, color });
                x += width;
            }
            this.y -= lineHeight;
            this.pageHasContent = true;
        });
    }

    /**
     * Radbrytning vid blanksteg. Ett ord som är bredare än raden (en lång länk) bryts mellan
     * tecken. En radbrytning i texten blir en ny rad.
     */
    private wrap(runs: Run[], size: number, maxWidth: number): Piece[][] {
        const lines: Piece[][] = [[]];
        let lineWidth = 0;
        const push = (text: string, font: PDFFont) => {
            const width = font.widthOfTextAtSize(text, size);
            lines[lines.length - 1].push({ text, font, width });
            lineWidth += width;
        };
        const newLine = () => { lines.push([]); lineWidth = 0; };

        for (const run of runs) {
            const font = run.bold ? this.fonts.bold : this.fonts.regular;
            // Radbrytningarna delas ut före teckenkontrollen: typsnittet har inget tecken för
            // dem, och de hade annars blivit frågetecken.
            run.text.split(/\r?\n|\r/).forEach((rawLine, li) => {
                if (li > 0) newLine();
                const hardLine = encodable(rawLine, this.fonts.charset);
                for (const token of hardLine.split(/(\s+)/)) {
                    if (!token) continue;
                    const isSpace = /^\s+$/.test(token);
                    const word = isSpace ? " " : token;
                    const width = font.widthOfTextAtSize(word, size);
                    if (isSpace) {
                        // Inget blanksteg först på en rad.
                        if (lineWidth > 0) push(word, font);
                        continue;
                    }
                    if (lineWidth + width <= maxWidth) { push(word, font); continue; }
                    // Släpp ett avslutande blanksteg innan raden bryts.
                    const cur = lines[lines.length - 1];
                    if (cur.length && cur[cur.length - 1].text === " ") lineWidth -= cur.pop()!.width;
                    if (lineWidth > 0) newLine();
                    if (width <= maxWidth) { push(word, font); continue; }
                    let chunk = "";
                    for (const ch of word) {
                        if (chunk && font.widthOfTextAtSize(chunk + ch, size) > maxWidth) {
                            push(chunk, font);
                            newLine();
                            chunk = "";
                        }
                        chunk += ch;
                    }
                    if (chunk) push(chunk, font);
                }
            });
        }
        return lines.filter((l, i) => l.length > 0 || i === 0);
    }
}

/** PDF-dokument som byte. Byggs helt i klienten, utan nätverk. */
export async function renderPdf(blocks: ExportBlock[]): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const fonts: Fonts = { regular, bold, charset: new Set(regular.getCharacterSet()) };

    const firstTitle = blocks.find(b => b.kind === "title");
    if (firstTitle) doc.setTitle(encodable(firstTitle.text, fonts.charset));
    doc.setCreator("Sagt.ai");
    doc.setProducer("Sagt.ai");
    doc.setLanguage("sv-SE");

    const w = new Writer(doc, fonts);
    for (const b of blocks) {
        switch (b.kind) {
            case "title":
                // I en samlad fil börjar varje möte utom det första på en ny sida.
                w.breakPageIfUsed();
                w.paragraph([{ text: b.text, bold: true }], TITLE, HEADING_COLOR);
                w.space(6);
                break;
            case "heading":
                if (b.level === 1) {
                    w.space(12);
                    w.paragraph([{ text: b.text, bold: true }], HEADING_1, HEADING_COLOR);
                    w.space(6);
                } else {
                    w.space(6);
                    w.paragraph([{ text: b.text, bold: true }], BODY);
                    w.space(2);
                }
                break;
            case "paragraph":
                w.paragraph([{ text: b.text, bold: false }], BODY);
                w.space(8);
                break;
            case "bullet":
                w.paragraph([{ text: b.text, bold: false }], BODY, BLACK, { indent: BULLET_INDENT, marker: "•" });
                w.space(2);
                break;
            case "turn":
                w.paragraph(
                    b.label ? [{ text: `${b.label}: `, bold: true }, { text: b.text, bold: false }] : [{ text: b.text, bold: false }],
                    BODY,
                );
                w.space(8);
                break;
        }
    }
    return await doc.save();
}
