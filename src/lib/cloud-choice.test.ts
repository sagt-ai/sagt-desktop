import { describe, it, expect, vi } from "vitest";
import { cloudChoiceAction } from "./cloud-choice";

const consoleWarn = console.warn;
vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("[zustand persist middleware]")) return;
    consoleWarn(...args);
});

import { migrateSettings } from "@/store/settings-store";

describe("migrateSettings v9 → v10", () => {
    it("molnläge som standard flyttas inte: läget står kvar och frågan väntar", () => {
        for (const mode of ["cloud", "cloud_analysis"]) {
            const out = migrateSettings({ recordingMode: mode, modeExplicitlySet: true }, 9);
            expect(out.recordingMode).toBe(mode);
            expect(out.cloudChoicePending).toBe(true);
        }
        // Även den som aldrig valt uttryckligen (den gamla automatiken).
        expect(migrateSettings({ recordingMode: "cloud", modeExplicitlySet: false }, 9).cloudChoicePending).toBe(true);
    });

    it("lokalt läge: ingen fråga", () => {
        const out = migrateSettings({ recordingMode: "local", modeExplicitlySet: false }, 9);
        expect(out.recordingMode).toBe("local");
        expect(out.cloudChoicePending).toBe(false);
    });

    it("ett gjort val nollställs inte längre av uppgraderingen", () => {
        expect(migrateSettings({ recordingMode: "local", modeExplicitlySet: true }, 9).modeExplicitlySet).toBe(true);
    });

    it("äldre versioner får samma fråga", () => {
        expect(migrateSettings({ recordingMode: "cloud" }, 5).cloudChoicePending).toBe(true);
    });
});

describe("cloudChoiceAction", () => {
    const CASES: Array<[boolean, boolean, boolean, ReturnType<typeof cloudChoiceAction>]> = [
        // pending, isSignedIn, isPro → åtgärd
        [false, true, true, "wait"],
        [false, true, false, "wait"],
        [false, false, false, "wait"],
        [true, false, false, "wait"],          // utloggad: planen okänd, ändra ingenting
        [true, true, true, "show"],            // Pro med molnet som gammal standard: fråga
        [true, true, false, "wait"],           // utan Pro (eller inaktuell plan): ingen tyst ändring
    ];
    it.each(CASES)("pending=%s inloggad=%s Pro=%s → %s", (pending, isSignedIn, isPro, expected) => {
        expect(cloudChoiceAction({ pending, isSignedIn, isPro })).toBe(expected);
    });
});
