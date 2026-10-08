import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { accountControl, accountMenuItems } from "./account-control";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f: string) => readFileSync(path.join(SRC, f), "utf8");

describe("kontoplatsen i protokollpanelen", () => {
    it("utloggad får inloggningsläget, aldrig ingenting", () => {
        expect(accountControl({ isSignedIn: false, isAuthenticating: false })).toBe("sign_in");
        expect(accountControl({ isSignedIn: false, isAuthenticating: true })).toBe("signing_in");
    });

    it("inloggad får kontomenyn", () => {
        expect(accountControl({ isSignedIn: true, isAuthenticating: false })).toBe("menu");
        expect(accountControl({ isSignedIn: true, isAuthenticating: true })).toBe("menu");
    });

    // Felet som fanns: kontoplatsen renderades bara för inloggade, så den som loggat ut
    // kom inte tillbaka. Panelen får bara välja VAR knappen står (efter panelernas
    // layout, se accountButtonPanel), aldrig OM den står där efter inloggningsläget.
    it("panelen renderar kontoplatsen utan villkor på inloggning, i båda panelerna", () => {
        const view = read("components/dashboard/split-view.tsx");
        const uses = view.split("\n").map(l => l.trim()).filter(l => l.includes("<AccountButton"));
        expect(uses.length).toBe(2);
        for (const l of uses) {
            expect(l).toMatch(/^\{accountIn === '(protocol|transcript)' && <AccountButton \/>\}$/);
        }
        expect(uses.some(l => l.includes("'protocol'"))).toBe(true);
        expect(uses.some(l => l.includes("'transcript'"))).toBe(true);
        expect(view).toMatch(/const accountIn = accountButtonPanel\(collapsed\);/);
    });

    it("utloggad har Logga in i menyn, även medan inloggningen väntar", () => {
        expect(accountMenuItems("sign_in")).toContain("sign_in");
        expect(accountMenuItems("signing_in")).toContain("sign_in");
        expect(accountMenuItems("sign_in")).not.toContain("sign_out");
    });

    it("inloggad har Logga ut och ingen inloggning", () => {
        expect(accountMenuItems("menu")).toEqual(["sign_out"]);
    });

    // Menyn styrs av accountMenuItems. Komponenten måste rendera inloggningsraden för den
    // posten, och raden måste starta inloggningen i webbläsaren med avsikten free.
    it("komponenten renderar inloggningsraden och startar inloggningen med avsikten free", () => {
        const button = read("components/dashboard/account-button.tsx");
        expect(button).toMatch(/accountMenuItems\(control\)/);
        const start = button.indexOf('items.includes("sign_in")');
        expect(start).toBeGreaterThan(0);
        const row = button.slice(start, button.indexOf("</button>", start));
        expect(row).toMatch(/"Logga in"/);
        expect(row).toMatch(/startAuth\(\{ intent: "free", source: "sign_in_button" \}\)/);
        // Avsikten går genom inloggningens ägare, inte genom en egen setSignInIntent.
        expect(button).not.toMatch(/setSignInIntent/);
        // Ingen gren som döljer kontoplatsen för utloggad.
        expect(button).not.toMatch(/return null/);
    });
});
