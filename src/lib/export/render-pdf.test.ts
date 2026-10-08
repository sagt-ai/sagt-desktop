process.env.TZ = "Europe/Stockholm";

import { describe, it, expect } from "vitest";
import { PDFDocument } from "@pdfme/pdf-lib";
import { inflateSync } from "zlib";
import { renderPdf, encodable } from "./render-pdf";
import { buildExport } from "./bundle";
import { meetingBlocks } from "./blocks";
import { MEETING_A } from "./fixtures";
import type { ExportBlock } from "./types";

// Läser tillbaka texten ur PDF:en utan att lita på renderaren: packa upp varje ström,
// plocka ut strängarna som ritas (`<hex> Tj`) och avkoda dem som WinAnsi (windows-1252),
// teckentabellen standardtypsnitten skriver i. Ett tecken som kodats fel syns här som fel
// tecken, inte som ett fel i renderaren.
const winAnsi = new TextDecoder("windows-1252");

function pdfLines(bytes: Uint8Array): string[] {
    const raw = Buffer.from(bytes).toString("latin1");
    const lines: string[] = [];
    const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
    for (const m of raw.matchAll(re)) {
        const data = Buffer.from(m[1], "latin1");
        let content: string;
        try { content = inflateSync(data).toString("latin1"); } catch { content = data.toString("latin1"); }
        // En rad i PDF:en: allt som ritas mellan två textpositioner.
        for (const block of content.split(/\bBT\b/).slice(1)) {
            const parts = [...block.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)].map(t => winAnsi.decode(Buffer.from(t[1], "hex")));
            if (parts.length) lines.push(parts.join(""));
        }
    }
    return lines;
}

const SWEDISH = "Åsa och Örjan: ”Vi börjar – på “allvar” med äpplen, éclairer och Ärligt talat.”";

describe("PDF-exporten", () => {
    it("svenska tecken, tankstreck och citattecken kommer fram oförändrade", async () => {
        const bytes = await renderPdf([
            { kind: "title", text: "Möte 6 oktober 2026, 14:05" },
            { kind: "turn", label: "Åsa", text: SWEDISH },
        ]);
        expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
        const text = pdfLines(bytes).join(" ");
        expect(text).toContain("Möte 6 oktober 2026, 14:05");
        expect(text).toContain("Åsa: ");
        for (const ch of ["å", "ä", "ö", "Å", "Ä", "Ö", "é", "–", "”", "“"]) expect(text).toContain(ch);
        expect(text.replace(/\s+/g, " ")).toContain(SWEDISH);
    });

    it("tecken utanför standardtypsnittet fäller inte exporten", async () => {
        const bytes = await renderPdf([{ kind: "paragraph", text: "Łukasz sa 😀 och Dvořák​ log\tsedan" }]);
        const text = pdfLines(bytes).join(" ");
        expect(text).toContain("?ukasz sa ? och Dvorák log sedan");
    });

    it("radbrytningar i texten blir nya rader, inte frågetecken", async () => {
        const lines = pdfLines(await renderPdf([{ kind: "paragraph", text: "rad ett\nrad två\r\nslut" }]));
        expect(lines).toEqual(["rad ett", "rad två", "slut"]);
    });

    it("encodable: accent bort när det går, annars frågetecken", () => {
        const charset = new Set([..."abcdefghijklmnopqrstuvwxyzåäöé ?"].map(c => c.codePointAt(0)!));
        expect(encodable("ŕåł", charset)).toBe("rå?");
    });

    it("samma struktur som Word-exporten: rubrik, sektioner, punkter, turer", async () => {
        const blocks = meetingBlocks(MEETING_A, "both");
        const text = pdfLines(await renderPdf(blocks)).join("\n");
        for (const b of blocks) {
            const want = b.kind === "turn" && b.label ? `${b.label}: ` : b.kind === "turn" ? b.text : b.text;
            // Långa stycken bryts över flera rader; första ordet räcker för att se ordningen.
            expect(text).toContain(want.split(" ")[0]);
        }
        const order = ["Transkription", "Protokoll", "Sammanfattning", "Beslut", "Åtgärder"].map(h => text.indexOf(h));
        expect(order.every(i => i >= 0)).toBe(true);
        expect([...order].sort((a, b) => a - b)).toEqual(order);
    });

    it("lång text bryts inom sidan och fortsätter på nästa sida", async () => {
        const word = "Budgeten";
        const blocks: ExportBlock[] = [{ kind: "title", text: "Möte" }];
        for (let i = 0; i < 80; i++) blocks.push({ kind: "turn", label: "Du", text: `${word} ${i} `.repeat(30) });
        blocks.push({ kind: "paragraph", text: "x".repeat(400) }); // ett ord bredare än raden
        const bytes = await renderPdf(blocks);
        expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(3);
        // Ingen rad är längre än vad som ryms: Helvetica 11 pt, ~467 pt bred rad ≈ < 120 tecken.
        for (const l of pdfLines(bytes)) expect(l.length).toBeLessThan(120);
    });

    it("en samlad fil börjar varje möte på en ny sida", async () => {
        const one = await renderPdf([{ kind: "title", text: "A" }, { kind: "paragraph", text: "a" }]);
        const two = await renderPdf([{ kind: "title", text: "A" }, { kind: "paragraph", text: "a" }, { kind: "title", text: "B" }]);
        expect((await PDFDocument.load(one)).getPageCount()).toBe(1);
        expect((await PDFDocument.load(two)).getPageCount()).toBe(2);
    });

    it("PDF i exportflödet: ett möte ger en .pdf", async () => {
        const single = await buildExport([MEETING_A], { format: "pdf", content: "both", bundle: "single" });
        expect(single.name).toMatch(/\.pdf$/);
        expect(Buffer.from(single.bytes.slice(0, 5)).toString()).toBe("%PDF-");
    });
});
