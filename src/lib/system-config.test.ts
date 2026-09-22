import { describe, it, expect } from "vitest";
import { diarizeAvailable, liveDiarizeAvailable, type SystemConfig } from "./system-config";

// Samma fall som webbens frontend/lib/system-config.test.ts: talarsepareringen gäller bara
// när backend uttryckligen svarar true.
describe("diarizeAvailable", () => {
    it("på när backend svarar true", () => {
        expect(diarizeAvailable({ diarize_enabled: true })).toBe(true);
    });

    it("av när backend svarar false", () => {
        expect(diarizeAvailable({ diarize_enabled: false })).toBe(false);
    });

    it("av när svaret saknas", () => {
        expect(diarizeAvailable(undefined)).toBe(false);
        expect(diarizeAvailable(null)).toBe(false);
    });

    it("av mot en äldre backend utan fältet", () => {
        expect(diarizeAvailable({})).toBe(false);
    });

    it("av för värden som bara är sanna i JavaScript", () => {
        // Strängen "false" är sann i en if-sats. `!!diarize_enabled` hade laddat upp
        // MÖTET-kanalen här, trots att servern svarar 503.
        for (const value of ["false", "true", 1]) {
            const config = { diarize_enabled: value } as unknown as SystemConfig;
            expect(diarizeAvailable(config), JSON.stringify(value)).toBe(false);
        }
    });
});

// Live-diariseringens kill switch. Samma fall igen, därför att felet de skyddar mot är
// olika: ett falskt true här ger en 503 per inspelningsstart i 5xx-larmet.
describe("liveDiarizeAvailable", () => {
    it("på när backend svarar true", () => {
        expect(liveDiarizeAvailable({ live_diarize_enabled: true })).toBe(true);
    });

    it("av när backend svarar false", () => {
        expect(liveDiarizeAvailable({ live_diarize_enabled: false })).toBe(false);
    });

    it("av när svaret saknas", () => {
        expect(liveDiarizeAvailable(undefined)).toBe(false);
        expect(liveDiarizeAvailable(null)).toBe(false);
    });

    it("av mot en äldre backend utan fältet", () => {
        expect(liveDiarizeAvailable({})).toBe(false);
    });

    it("av för värden som bara är sanna i JavaScript", () => {
        for (const value of ["false", "true", 1]) {
            const config = { live_diarize_enabled: value } as unknown as SystemConfig;
            expect(liveDiarizeAvailable(config), JSON.stringify(value)).toBe(false);
        }
    });

    it("läser inte diarize_enabled", () => {
        // De två flaggorna är oberoende i backend: DIARIZE_ENABLED styr batch-diarisering
        // vid stopp, LIVE_DIARIZE_ENABLED den strömmande vägen. Ett fält som läser fel
        // konstant hade sett korrekt ut i produktion i dag, där båda är false.
        expect(liveDiarizeAvailable({ diarize_enabled: true })).toBe(false);
        expect(diarizeAvailable({ live_diarize_enabled: true })).toBe(false);
    });
});
