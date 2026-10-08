import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Grinden för AI-protokollet bor i entitlements-store (entitled/useEntitlement): Pro
// obegränsat, gratiskonto med månadskvot, utloggad via konto först. En ny kontroll av
// Pro-status direkt i en komponent är det som skulle låsa gratiskontot ute igen, tyst.
//
// Testet räknar varje kontroll av Pro-status per fil och jämför mot listan nedan. En ny
// kontroll fäller testet, och så gör en borttagen: listan ska spegla koden, annars slutar
// den skydda. Ska en ny kontroll in, gäller den något annat än protokollet och exporten
// (molnmodellen, talare, synk) och skrivs in här med motivering. Protokollet och exporten
// frågar grinden.
//
// Vad testet inte ser: en kontroll som byts mot en annan i samma fil (en tas bort, en ny
// läggs till) lämnar antalet oförändrat. Läs diffen när en rad i listan står still men
// filen ändrats kring Pro.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// `isPro` som ord (isPro, isPro(), s.isPro(), !isPro) och den direkta jämförelsen
// mot prenumerationens status, som annars vore vägen förbi räkningen.
const PRO_CHECK = /\bisPro\b|\bisProStatus\b|stripe_?[sS]tatus\s*===\s*["']active["']/g;

/** Kontroller av Pro-status som får finnas, per fil. Inget av detta gäller protokollet. */
const ALLOWED: Record<string, number> = {
    // Grinden själv och dess rena beslut, och vilken räknare som visas (visibleCounter).
    "store/entitlements-store.ts": 18,
    "lib/entitlements.ts": 2,
    // Exportkvoten: Pro anropar aldrig servern och exporterar offline utan förskott.
    "lib/export/quota.ts": 2,
    "lib/upsell-state.ts": 10,
    // Sessionen och prenumerationens status.
    "store/auth-store.ts": 7,
    "hooks/use-payment-refresh.ts": 5,
    "providers/PostHogProvider.tsx": 3,
    // Uppgraderingsfönstret (aktivering, kvotraden, stängning).
    "components/dashboard/upsell-modal.tsx": 15,
    // Molnmodellen är Pro: lägesväljaren, inställningarna, inspelningsstarten, frågan efter uppdateringen.
    "components/dashboard/mode-pill.tsx": 5,
    "pages/settings-page.tsx": 14,
    "components/layout/control-bar.tsx": 7,
    "components/dashboard/cloud-choice-dialog.tsx": 3,
    "lib/cloud-choice.ts": 2,
    // Kontomenyn visar planen (Sagt Pro / Gratiskonto).
    "components/dashboard/account-button.tsx": 3,
    // Transkriptvyn: omtranskribering i molnet, talaridentifiering, långsamhetstipset.
    // Protokollet frågar grinden om det får skapas; Pro-status väljer bara
    // VÄG efter grinden (omkörning av ett synkat molnjobb, uppladdning när text saknas)
    // och texten vid 413. Ingen av dem stänger ute ett gratiskonto.
    "components/dashboard/split-view.tsx": 8,
    // Talare och synk efter mötet (molnläge, Pro).
    "lib/auto-finalize.ts": 2,
    "hooks/use-live-diarize.ts": 1,
    "hooks/use-live-speaker-naming.ts": 1,
    "pages/recordings-page.tsx": 3,
    // Frågorna till användaren och provperiodens banner.
    "components/feedback/feedback-card.tsx": 3,
    "lib/feedback-questions.ts": 2,
    "lib/feedback-runtime.ts": 4,
    "lib/feedback-state.ts": 2,
    "components/lifecycle/trial-banner.tsx": 3,
};

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
        else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
    }
    return out;
}

export function countProChecks(source: string): number {
    return (source.match(PRO_CHECK) ?? []).length;
}

describe("Pro-kontroller utanför grinden", () => {
    const files = sourceFiles(SRC);
    const counts: Record<string, number> = {};
    for (const f of files) {
        const n = countProChecks(readFileSync(f, "utf8"));
        if (n > 0) counts[path.relative(SRC, f).split(path.sep).join("/")] = n;
    }

    // En räkning som ser noll filer eller noll kontroller säger "OK" om ingenting.
    it("läser källkoden (spärr mot en tom genomsökning)", () => {
        expect(files.length).toBeGreaterThan(50);
        expect(files.some(f => f.endsWith(path.join("dashboard", "split-view.tsx")))).toBe(true);
        expect(Object.keys(counts).length).toBeGreaterThan(10);
    });

    it("mönstret ser varje form av kontrollen", () => {
        expect(countProChecks("if (!isSignedIn || !isPro) openUpsell('analysis')")).toBe(1);
        expect(countProChecks("const p = useAuthStore.getState().isPro()")).toBe(1);
        expect(countProChecks('s.stripeStatus === "active"')).toBe(1);
        expect(countProChecks("user.stripe_status === 'active'")).toBe(1);
        expect(countProChecks("const pro = isProStatus(s.stripeStatus)")).toBe(1);
        expect(countProChecks("isProcessing && isProduction")).toBe(0);
    });

    it("exakt de tillåtna kontrollerna, per fil", () => {
        expect(counts).toEqual(ALLOWED);
    });
});
