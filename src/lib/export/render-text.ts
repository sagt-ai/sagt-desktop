import type { ExportBlock } from "./types";

// Text och Markdown. Båda byggs som stycken med en tomrad emellan; en underrubrik i
// textformatet står tätt ovanför sitt innehåll, som i protokollpanelen.

/**
 * Ren text. Transkriptets turer skrivs "Talare: text", precis som kopiera-knappen,
 * så en exporterad fil och ett urklipp är samma text.
 */
export function renderTxt(blocks: ExportBlock[]): string {
    const parts: string[] = [];
    let i = 0;
    while (i < blocks.length) {
        const b = blocks[i];
        if (b.kind === "heading" && b.level === 2) {
            // Underrubrik + dess stycke/punkter som ett block utan tomrad emellan.
            const lines = [b.text];
            i++;
            while (i < blocks.length && (blocks[i].kind === "paragraph" || blocks[i].kind === "bullet")) {
                const c = blocks[i] as Extract<ExportBlock, { kind: "paragraph" | "bullet" }>;
                lines.push(c.kind === "bullet" ? `- ${c.text}` : c.text);
                i++;
            }
            parts.push(lines.join("\n"));
            continue;
        }
        parts.push(txtBlock(b));
        i++;
    }
    return parts.join("\n\n") + "\n";
}

function txtBlock(b: ExportBlock): string {
    switch (b.kind) {
        case "title": return b.text;
        case "heading": return b.level === 1 ? b.text.toUpperCase() : b.text;
        case "paragraph": return b.text;
        case "bullet": return `- ${b.text}`;
        case "turn": return b.label ? `${b.label}: ${b.text}` : b.text;
    }
}

/** Markdown: mötet som #, sektioner som ##, protokollets delar som ###. */
export function renderMd(blocks: ExportBlock[]): string {
    const parts: string[] = [];
    let i = 0;
    while (i < blocks.length) {
        const b = blocks[i];
        if (b.kind === "bullet") {
            // En punktlista hålls ihop utan tomrader, annars blir den "lös" i Markdown.
            const items: string[] = [];
            while (i < blocks.length && blocks[i].kind === "bullet") {
                items.push(`- ${mdEscape((blocks[i] as { text: string }).text)}`);
                i++;
            }
            parts.push(items.join("\n"));
            continue;
        }
        parts.push(mdBlock(b));
        i++;
    }
    return parts.join("\n\n") + "\n";
}

function mdBlock(b: Exclude<ExportBlock, { kind: "bullet" }>): string {
    switch (b.kind) {
        case "title": return `# ${b.text}`;
        case "heading": return `${b.level === 1 ? "##" : "###"} ${b.text}`;
        case "paragraph": return mdEscape(b.text);
        case "turn": return b.label ? `**${mdEscape(b.label)}:** ${mdEscape(b.text)}` : mdEscape(b.text);
    }
}

/**
 * Tal kan börja med tecken som Markdown läser som syntax ("# ", "- ", "1. ", "> ").
 * Bara radbörjan och tecknen som annars formaterar mitt i texten (*, _, `) maskeras;
 * resten av texten lämnas orörd så att filen går att läsa som ren text.
 */
export function mdEscape(s: string): string {
    return s
        .replace(/([\\`*_])/g, "\\$1")
        .replace(/^(\s*)([#>+-])(\s)/gm, "$1\\$2$3")
        // Numrerad lista: snedstrecket före punkten ("1\."), före siffran vore det bokstavligt.
        .replace(/^(\s*\d+)([.)])(\s)/gm, "$1\\$2$3");
}
