import { describe, it, expect } from "vitest";
import {
    speakerKey,
    buildTurnsFromSegments,
    mergeSuggestions,
    parseSpeakerData,
    serializeSpeakerData,
    formatSpeakerGroup,
    suggestionsFromResult,
    applyNamingResult,
} from "@/lib/speaker-naming";
import type { UISegment } from "@/store/transcription-store";

// Hjälpare: minimalt segment.
const seg = (over: Partial<UISegment>): UISegment => ({
    id: 0,
    start_time: 0,
    end_time: 0,
    text: "",
    speaker: "MÖTET",
    timestamp: 0,
    ...over,
});

describe("speakerKey", () => {
    it("kanoniserar mic/DU → DU och sys/MÖTET → MÖTET", () => {
        expect(speakerKey("mic")).toBe("DU");
        expect(speakerKey("DU")).toBe("DU");
        expect(speakerKey("sys")).toBe("MÖTET");
        expect(speakerKey("MÖTET")).toBe("MÖTET");
    });
    it("lämnar numrerade diariserings-etiketter orörda", () => {
        expect(speakerKey("TALARE 2")).toBe("TALARE 2");
    });
});

describe("buildTurnsFromSegments", () => {
    it("kanoniserar nycklar och mappar start_time → start", () => {
        const turns = buildTurnsFromSegments([
            seg({ speaker: "mic", text: "Hej", start_time: 1.5 }),
            seg({ speaker: "sys", text: "Hallå", start_time: 3 }),
        ]);
        expect(turns).toEqual([
            { speaker: "DU", text: "Hej", start: 1.5 },
            { speaker: "MÖTET", text: "Hallå", start: 3 },
        ]);
    });

    it("filtrerar bort MOLN och tomma texter", () => {
        const turns = buildTurnsFromSegments([
            seg({ speaker: "MOLN", text: "molntext" }),
            seg({ speaker: "MÖTET", text: "   " }),
            seg({ speaker: "MÖTET", text: "riktigt" }),
        ]);
        expect(turns).toEqual([{ speaker: "MÖTET", text: "riktigt", start: 0 }]);
    });

    it("sätter start: null när start_time saknas", () => {
        const turns = buildTurnsFromSegments([
            seg({ speaker: "DU", text: "x", start_time: undefined as unknown as number }),
        ]);
        expect(turns[0].start).toBeNull();
    });
});

describe("mergeSuggestions — provenance-invariant", () => {
    it("sätter en osatt nyckel och registrerar den som auto", () => {
        const { map, autoKeys } = mergeSuggestions({}, { DU: "Anna" }, []);
        expect(map).toEqual({ DU: "Anna" });
        expect(autoKeys).toEqual(["DU"]);
    });

    it("förfinar en tidigare auto-satt nyckel", () => {
        const { map, autoKeys } = mergeSuggestions({ DU: "Anna" }, { DU: "Anna Andersson" }, ["DU"]);
        expect(map.DU).toBe("Anna Andersson");
        expect(autoKeys).toContain("DU");
    });

    it("rör ALDRIG en användarsatt nyckel (i base, ej i autoKeys)", () => {
        const { map, autoKeys } = mergeSuggestions({ DU: "Mitt namn" }, { DU: "LLM-gissning" }, []);
        expect(map.DU).toBe("Mitt namn");
        expect(autoKeys).not.toContain("DU");
    });

    it("skyddar användarsatt nyckel men sätter samtidigt en ny auto-nyckel", () => {
        const { map, autoKeys } = mergeSuggestions(
            { DU: "Mitt namn" },
            { DU: "LLM", "MÖTET": "Erik" },
            [],
        );
        expect(map).toEqual({ DU: "Mitt namn", "MÖTET": "Erik" });
        expect(autoKeys).toEqual(["MÖTET"]);
    });

    it("ignorerar tomma förslagsnamn", () => {
        const { map, autoKeys } = mergeSuggestions({}, { DU: "  " }, []);
        expect(map).toEqual({});
        expect(autoKeys).toEqual([]);
    });

    it("muterar inte inparametrarna", () => {
        const base = { DU: "Anna" };
        const auto = ["DU"];
        mergeSuggestions(base, { "MÖTET": "Erik" }, auto);
        expect(base).toEqual({ DU: "Anna" });
        expect(auto).toEqual(["DU"]);
    });
});

describe("parseSpeakerData / serializeSpeakerData", () => {
    it("defaultar auto: [] för äldre rader utan fältet (bakåtkompatibelt)", () => {
        const parsed = parseSpeakerData(JSON.stringify({ map: { DU: "Anna" }, participants: ["Erik"] }));
        expect(parsed).toEqual({ map: { DU: "Anna" }, participants: ["Erik"], auto: [] });
    });

    it("tom/trasig payload → tom default", () => {
        expect(parseSpeakerData(null)).toEqual({ map: {}, participants: [], auto: [] });
        expect(parseSpeakerData("{trasig")).toEqual({ map: {}, participants: [], auto: [] });
    });

    it("roundtrip bevarar map, participants och auto", () => {
        const data = { map: { DU: "Anna" }, participants: ["Erik"], auto: ["DU"] };
        expect(parseSpeakerData(serializeSpeakerData(data))).toEqual(data);
    });
});

describe("formatSpeakerGroup", () => {
    it("visar upp till tre namn med snedstreck", () => {
        expect(formatSpeakerGroup(["Anna", "Lasse"])).toBe("Anna/Lasse");
        expect(formatSpeakerGroup(["Anna", "Lasse", "Per"])).toBe("Anna/Lasse/Per");
    });
    it("visar fyra eller fler som två namn och ett antal", () => {
        expect(formatSpeakerGroup(["Anna", "Lasse", "Per", "Eva"])).toBe("Anna, Lasse +2");
    });
});

describe("suggestionsFromResult", () => {
    it("gör grupper till vanliga namn och behåller enskilda personer", () => {
        expect(suggestionsFromResult({ speaker_map: { "MÖTET": "Per" }, speaker_groups: { DU: ["Anna", "Lasse"] } }))
            .toEqual({ "MÖTET": "Per", DU: "Anna/Lasse" });
    });
    it("tål en äldre server utan grupper och ett tomt svar", () => {
        expect(suggestionsFromResult({ speaker_map: { DU: "Anna" } })).toEqual({ DU: "Anna" });
        expect(suggestionsFromResult(null)).toEqual({});
        expect(suggestionsFromResult({})).toEqual({});
    });
});

describe("applyNamingResult", () => {
    const empty = { map: {}, participants: ["Anna", "Lasse"], auto: [] as string[] };

    it("lägger in en grupp som Anna/Lasse, automatisk och med källa", () => {
        const out = applyNamingResult(empty, { speaker_groups: { DU: ["Anna", "Lasse"] } }, "protocol");
        expect(out.data.map).toEqual({ DU: "Anna/Lasse" });
        expect(out.data.auto).toEqual(["DU"]);
        expect(out.data.auto_source).toEqual({ DU: "protocol" });
        expect(out.data.participants).toEqual(["Anna", "Lasse"]);
        expect(out.applied).toBe(1);
        expect(out.groupsApplied).toBe(1);
    });

    it("fyra namn i en grupp visas som Anna, Lasse +2", () => {
        const out = applyNamingResult(empty, { speaker_groups: { DU: ["Anna", "Lasse", "Per", "Eva"] } }, "protocol");
        expect(out.data.map.DU).toBe("Anna, Lasse +2");
    });

    it("rör aldrig ett namn som användaren satt", () => {
        const current = { map: { DU: "Daniel" }, participants: [], auto: [] as string[] };
        const out = applyNamingResult(current, { speaker_map: { DU: "Anna", "MÖTET": "Per" } }, "protocol");
        expect(out.data.map).toEqual({ DU: "Daniel", "MÖTET": "Per" });
        expect(out.applied).toBe(1);
        expect(out.groupsApplied).toBe(0);
    });

    it("ett tomt förslag ändrar ingenting och ger antal 0", () => {
        const current = { map: { DU: "Anna" }, participants: [], auto: ["DU"], auto_source: { DU: "identify" as const } };
        const out = applyNamingResult(current, { speaker_map: {}, speaker_groups: {} }, "protocol");
        expect(out.data.map).toEqual(current.map);
        expect(out.data.auto).toEqual(["DU"]);
        expect(out.data.auto_source).toEqual({ DU: "identify" });
        expect(out.applied).toBe(0);
    });

    it("samma förslag igen räknas inte som ett nytt namn", () => {
        const current = { map: { DU: "Anna" }, participants: [], auto: ["DU"] };
        expect(applyNamingResult(current, { speaker_map: { DU: "Anna" } }, "protocol").applied).toBe(0);
    });

    it("muterar inte indata", () => {
        const current = { map: { "MÖTET": "Per" }, participants: [], auto: ["MÖTET"] };
        applyNamingResult(current, { speaker_map: { DU: "Anna" } }, "protocol");
        expect(current).toEqual({ map: { "MÖTET": "Per" }, participants: [], auto: ["MÖTET"] });
    });
});

describe("källan till automatiska namn", () => {
    it("en gammal rad utan källa läses som förut", () => {
        const parsed = parseSpeakerData(JSON.stringify({ map: { DU: "Anna" }, participants: [], auto: ["DU"] }));
        expect(parsed.auto_source).toBeUndefined();
    });

    it("källan sparas och läses tillbaka, bara för nycklar som fortfarande är automatiska", () => {
        const raw = serializeSpeakerData({
            map: { DU: "Anna", "MÖTET": "Per" }, participants: [], auto: ["DU"],
            auto_source: { DU: "protocol", "MÖTET": "identify" },
        });
        expect(parseSpeakerData(raw).auto_source).toEqual({ DU: "protocol" });
    });

    it("okända källor släpps vid inläsning", () => {
        const parsed = parseSpeakerData(JSON.stringify({ map: {}, participants: [], auto: ["DU"], auto_source: { DU: "hackad" } }));
        expect(parsed.auto_source).toBeUndefined();
    });

    it("utan källa är payloaden byte för byte som förut", () => {
        expect(serializeSpeakerData({ map: { DU: "Anna" }, participants: ["Erik"], auto: ["DU"] }))
            .toBe(JSON.stringify({ map: { DU: "Anna" }, participants: ["Erik"], auto: ["DU"] }));
    });
});
