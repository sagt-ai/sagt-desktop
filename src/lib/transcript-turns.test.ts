import { describe, it, expect } from "vitest";
import {
    buildCopyText,
    defaultLabel,
    groupTurns,
    isMergedView,
    mergedParagraphs,
    parseCloudSegments,
    transcriptLines,
    type TurnInput,
} from "./transcript-turns";

const seg = (speaker: string, start: number, end: number, text: string): TurnInput =>
    ({ speaker, start_time: start, end_time: end, text });

describe("groupTurns", () => {
    it("slår ihop samma talare utan paus", () => {
        const turns = groupTurns([seg("DU", 0, 1, "Hej"), seg("DU", 1.2, 2, "alla.")], 1500);
        expect(turns).toEqual([{ speaker: "DU", text: "Hej alla.", start_time: 0, end_time: 2 }]);
    });

    it("ny tur vid en paus lika lång som gränsen", () => {
        const turns = groupTurns([seg("DU", 0, 1, "Ett."), seg("DU", 2.5, 3, "Två.")], 1500);
        expect(turns.map(t => t.text)).toEqual(["Ett.", "Två."]);
    });

    it("ny tur vid talarbyte", () => {
        const turns = groupTurns([seg("DU", 0, 1, "Fråga?"), seg("MÖTET", 1, 2, "Svar.")], 1500);
        expect(turns.map(t => t.speaker)).toEqual(["DU", "MÖTET"]);
    });

    it("jämför talarna som de står: mic och DU blir två turer", () => {
        const turns = groupTurns([seg("mic", 0, 1, "A"), seg("DU", 1, 2, "B")], 1500);
        expect(turns).toHaveLength(2);
    });

    it("hoppar över nospeech-markören och tomma segment", () => {
        const turns = groupTurns([seg("DU", 0, 1, "<|nospeech|>"), seg("DU", 1, 2, "  "), seg("DU", 2, 3, "Text")], 1500);
        expect(turns.map(t => t.text)).toEqual(["Text"]);
    });
});

describe("sammanhängande molntext", () => {
    it("delar i stycken vid paus", () => {
        const segs = [seg("MOLN", 0, 1, "Ett"), seg("MOLN", 1.1, 2, "två."), seg("MOLN", 5, 6, "Tre.")];
        expect(isMergedView(segs)).toBe(true);
        expect(mergedParagraphs(segs, 1500)).toEqual(["Ett två.", "Tre."]);
    });

    it("är inte sammanhängande så fort en talare finns", () => {
        expect(isMergedView([seg("MOLN", 0, 1, "a"), seg("DU", 1, 2, "b")])).toBe(false);
        expect(isMergedView([])).toBe(false);
    });
});

describe("defaultLabel", () => {
    it.each([
        ["DU", "Du"], ["mic", "Du"], ["MÖTET", "Mötet"], ["sys", "Mötet"],
        ["TALARE 1", "Talare 1"], ["MÖTET 2", "Mötet 2"], ["Anna", "Anna"],
    ])("%s → %s", (raw, label) => {
        expect(defaultLabel(raw)).toBe(label);
    });
});

describe("transcriptLines och kopieringstexten", () => {
    it("använder namnen användaren satt, annars standardetiketten", () => {
        const lines = transcriptLines([seg("DU", 0, 1, "Hej."), seg("sys", 1, 2, "Tjena.")], { DU: "Anna" }, 1500);
        expect(lines).toEqual([{ label: "Anna", text: "Hej." }, { label: "Mötet", text: "Tjena." }]);
        expect(buildCopyText(lines)).toBe("Anna: Hej.\n\nMötet: Tjena.");
    });

    it("molntext utan talare får ingen etikett", () => {
        const lines = transcriptLines([seg("MOLN", 0, 1, "Allt i ett.")], {}, 1500);
        expect(buildCopyText(lines)).toBe("Allt i ett.");
    });
});

describe("parseCloudSegments", () => {
    it("tolkar sparade molnsegment och sätter MÖTET när talare saknas", () => {
        const raw = JSON.stringify([{ start_time: 1, end_time: 2, text: " Hej ", speaker: "DU" }, { text: "Svar" }, { text: "" }]);
        expect(parseCloudSegments(raw)).toEqual([
            { start_time: 1, end_time: 2, text: "Hej", speaker: "DU" },
            { start_time: 0, end_time: 0, text: "Svar", speaker: "MÖTET" },
        ]);
    });

    it("ger tom lista för trasig eller saknad data", () => {
        expect(parseCloudSegments("{inte json")).toEqual([]);
        expect(parseCloudSegments('{"a":1}')).toEqual([]);
        expect(parseCloudSegments(null)).toEqual([]);
    });
});
