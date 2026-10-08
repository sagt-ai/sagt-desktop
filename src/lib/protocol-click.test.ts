import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { protocolClick } from "./protocol-click";

describe("klick på Skapa protokoll och tratten", () => {
    const q = { used: 3, limit: 3, resets_at: "2026-11-01" };

    it("lokal spärr skickar quota_exhausted från klienten, en gång per klick", () => {
        const capture = vi.fn();
        expect(protocolClick("quota_exhausted", q, capture, new Date("2026-10-31T23:00:00Z"))).toEqual({ source: "quota_protocol", quota: q });
        const kvot = capture.mock.calls.filter(c => c[0] === "quota_exhausted");
        expect(kvot).toHaveLength(1);
        expect(kvot[0][1]).toEqual({
            kind: "protocol", limit: 3, used: 3, period: "2026-10", plan: "free", origin: "client",
        });
        expect(capture).toHaveBeenCalledWith("error_shown", expect.objectContaining({ code: "quota_exhausted", kind: "protocol", origin: "client" }));
    });

    it("ingen spärr → inget event och inget fönster", () => {
        const capture = vi.fn();
        expect(protocolClick("allowed", q, capture)).toBeNull();
        expect(capture).not.toHaveBeenCalled();
    });

    it("utloggad → kontofönstret, inget kvotevent", () => {
        const capture = vi.fn();
        expect(protocolClick("sign_in", null, capture)).toEqual({ source: "free_account", quota: null });
        expect(capture).not.toHaveBeenCalled();
    });
});

it("protokollknappen i panelen går genom protocolClick med captureEvent", () => {
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../components/dashboard/split-view.tsx"), "utf8");
    expect(src).toMatch(/protocolClick\(entitlementFor\('protocol'\), quotaForUpsell\('protocol'\), captureEvent\)/);
});
