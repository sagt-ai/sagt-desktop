import { describe, it, expect } from "vitest";
import { diarizeAvailable, type SystemConfig } from "./system-config";

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
