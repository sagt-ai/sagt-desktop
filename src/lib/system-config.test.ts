import { describe, it, expect } from "vitest";
import { checkoutInterval, diarizeAvailable, jobDiarizeAvailable, liveDiarizeAvailable, mcpAvailable, proYearlyAvailable, type SystemConfig } from "./system-config";

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
// olika: ett falskt true här ger en 503 per inspelningsstart.
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

// Två vägar, två knappar. Med de nya fälten läses varje väg för sig; utan dem (en äldre
// backend) gäller det gamla gemensamma fältet för båda.
describe("talarseparering per väg", () => {
    it("efter mötet på, omtranskribering av: bara efter mötet visas", () => {
        const config = { diarize_after_meeting_enabled: true, job_diarize_enabled: false, diarize_enabled: false };
        expect(diarizeAvailable(config)).toBe(true);
        expect(jobDiarizeAvailable(config)).toBe(false);
    });

    it("omtranskribering på, efter mötet av: bara omtranskriberingen visas", () => {
        const config = { diarize_after_meeting_enabled: false, job_diarize_enabled: true, diarize_enabled: false };
        expect(diarizeAvailable(config)).toBe(false);
        expect(jobDiarizeAvailable(config)).toBe(true);
    });

    it("de nya fälten går före det gamla", () => {
        // Det gamla fältet är sant bara när båda är på. Läste klienten det, försvann en väg
        // som är påslagen; läste den det som "båda", visades en som är av.
        const config = { diarize_after_meeting_enabled: false, job_diarize_enabled: false, diarize_enabled: true };
        expect(diarizeAvailable(config)).toBe(false);
        expect(jobDiarizeAvailable(config)).toBe(false);
    });

    it("äldre backend utan de nya fälten: det gamla fältet gäller båda", () => {
        expect(jobDiarizeAvailable({ diarize_enabled: true })).toBe(true);
        expect(jobDiarizeAvailable({ diarize_enabled: false })).toBe(false);
        expect(jobDiarizeAvailable({})).toBe(false);
        expect(jobDiarizeAvailable(undefined)).toBe(false);
    });

    it("av för värden som bara är sanna i JavaScript", () => {
        for (const value of ["false", "true", 1]) {
            const config = { diarize_after_meeting_enabled: value, job_diarize_enabled: value } as unknown as SystemConfig;
            expect(diarizeAvailable(config), JSON.stringify(value)).toBe(false);
            expect(jobDiarizeAvailable(config), JSON.stringify(value)).toBe(false);
        }
    });
});

// Årsvalet i uppgraderingsfönstret. Ett falskt true visar ett val som kassan svarar 503 på.
describe("proYearlyAvailable", () => {
    it("på när backend svarar true", () => {
        expect(proYearlyAvailable({ pro_yearly_available: true })).toBe(true);
    });

    it("av när backend svarar false, saknar fältet eller inte svarat", () => {
        expect(proYearlyAvailable({ pro_yearly_available: false })).toBe(false);
        expect(proYearlyAvailable({})).toBe(false);
        expect(proYearlyAvailable(undefined)).toBe(false);
        expect(proYearlyAvailable(null)).toBe(false);
    });

    it("av för värden som bara är sanna i JavaScript", () => {
        for (const value of ["false", "true", 1]) {
            const config = { pro_yearly_available: value } as unknown as SystemConfig;
            expect(proYearlyAvailable(config), JSON.stringify(value)).toBe(false);
        }
    });
});

describe("checkoutInterval", () => {
    it("år bara när året är valt och finns", () => {
        expect(checkoutInterval("year", true)).toBe("year");
    });

    it("månad när årspriset inte finns, även om året valts", () => {
        // Valet gjordes, sedan sa en ny config nej: hellre rubrikpriset än ett 503.
        expect(checkoutInterval("year", false)).toBe("month");
    });

    it("månad när månad är vald", () => {
        expect(checkoutInterval("month", true)).toBe("month");
        expect(checkoutInterval("month", false)).toBe("month");
    });
});

describe("mcpAvailable", () => {
    it("bara ett uttryckligt true visar MCP-avsnittet", () => {
        expect(mcpAvailable({ mcp_available: true })).toBe(true)
        for (const c of [null, undefined, {}, { mcp_available: false }, { mcp_available: "true" as unknown as boolean }, { mcp_available: 1 as unknown as boolean }]) {
            expect(mcpAvailable(c)).toBe(false)
        }
    })
})
