import { describe, it, expect, vi, beforeEach } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Dialogen renderas på riktigt (utan DOM, som statisk markup). Bara räknarens källa och
// uppgraderingsfönstret byts ut: det som provas är att dialogen visar det hooken ger.
const counterMock = vi.hoisted(() => ({ value: null as { remaining: number; limit: number } | null, openArg: [] as boolean[] }));
vi.mock("@/store/entitlements-store", () => ({
    useExportCounter: (open: boolean) => { counterMock.openArg.push(open); return counterMock.value; },
    requestExportPermit: vi.fn(),
    useEntitlementsStore: { getState: () => ({ applyQuotaExhausted: vi.fn() }) },
}));
vi.mock("./upsell-modal", () => ({ UpsellModal: () => null }));
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("@/lib/feedback-runtime", () => ({ markErrorSeen: vi.fn() }));
vi.mock("@/lib/export/tauri-io", () => ({ saveExportFile: vi.fn() }));

import { ExportDialog } from "./export-dialog";

const render = (isOpen = true) => renderToStaticMarkup(createElement(ExportDialog, {
    isOpen, onClose: () => {}, scope: "selected", count: 1, transcriptCount: 1, analysisCount: 1,
    loadMeetings: async () => [],
}));

describe("exportdialogens räknare", () => {
    beforeEach(() => { counterMock.value = null; counterMock.openArg = []; });

    it("gratiskonto: raden visas med siffrorna", () => {
        counterMock.value = { remaining: 9, limit: 10 };
        const html = render();
        expect(html).toContain("Exportera mötet"); // dialogen renderades alls
        expect(html).toContain("9 av 10 exporter kvar den här månaden");
        expect(counterMock.openArg).toContain(true);
    });

    it("ingen räknare (Pro, utloggad): ingen rad", () => {
        const html = render();
        expect(html).toContain("Exportera mötet");
        expect(html).not.toContain("exporter kvar");
    });

    it("stängd dialog läser inte liggaren", () => {
        render(false);
        expect(counterMock.openArg).toEqual([false]);
    });
});
