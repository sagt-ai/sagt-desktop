import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const app = readFileSync(path.join(SRC, "App.tsx"), "utf8");

// Bannerna ska ligga över hela bredden. Ligger de inne i huvudytan trycker de ned
// panelernas rubrikrad men inte menyns, och linjen under rubrikerna blir inte hel.
describe("bannernas placering", () => {
    for (const banner of ["<MotdBanner", "<TrialBanner", "<AudioWarningBanner"]) {
        it(`${banner} ligger före menyn och huvudytan`, () => {
            const at = app.indexOf(banner);
            expect(at).toBeGreaterThan(-1);
            expect(at).toBeLessThan(app.indexOf("<Sidebar"));
            expect(at).toBeLessThan(app.indexOf("<main"));
        });
    }
});
