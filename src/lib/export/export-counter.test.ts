import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import type { OfflineAllowance, QuotaCounter } from "@/lib/entitlements";
import { ExportLedger, exportCounterText, exportCounterView, type KeyValueStorage } from "./quota";
import { exportedEventProps } from "./run";

const NOW = new Date("2026-10-06T12:00:00Z");
const counter = (remaining: number, period = "2026-10", resets_at = "2026-11-01"): QuotaCounter =>
    ({ limit: 10, used: 10 - remaining, remaining, period, resets_at });

describe("räknaren i exportdialogen", () => {
    it("visar den synliga räknaren", () => {
        const v = exportCounterView({ counter: counter(9), pendingOffline: 0 });
        expect(v).toEqual({ remaining: 9, limit: 10 });
        expect(exportCounterText(v!)).toBe("9 av 10 exporter kvar den här månaden");
    });

    it("ingen synlig räknare (Pro, utloggad, ej hämtad): ingen rad", () => {
        expect(exportCounterView({ counter: null, pendingOffline: 2 })).toBeNull();
    });

    it("export utan nätverk som inte stämts av dras av lokalt", () => {
        expect(exportCounterView({ counter: counter(9), pendingOffline: 2 })).toEqual({ remaining: 7, limit: 10 });
    });

    it("avdraget går inte under noll", () => {
        expect(exportCounterView({ counter: counter(1), pendingOffline: 3 })).toEqual({ remaining: 0, limit: 10 });
    });
});

class MemoryStorage implements KeyValueStorage {
    data = new Map<string, string>();
    getItem(k: string) { return this.data.get(k) ?? null; }
    setItem(k: string, v: string) { this.data.set(k, v); }
}

describe("liggarens antal per period", () => {
    const EXP = Date.parse("2026-11-01T00:00:00Z") / 1000;
    const a = (period: string, token: string, exp = EXP): OfflineAllowance => ({ kind: "export", n: 5, period, exp, token });

    it("räknar bara kontots poster i den efterfrågade perioden", () => {
        const s = new MemoryStorage();
        const ledger = new ExportLedger(() => s);
        // En post från förra månaden som aldrig stämts av.
        ledger.rememberAllowance("u", a("2026-09", "sep", Date.parse("2026-10-01T00:00:00Z") / 1000));
        ledger.drawOffline("u", "gammal", new Date("2026-09-30T12:00:00Z"));
        ledger.rememberAllowance("u", a("2026-10", "okt"));
        ledger.drawOffline("u", "k1", NOW);
        ledger.drawOffline("u", "k2", NOW);
        ledger.rememberAllowance("annan", a("2026-10", "x"));
        ledger.drawOffline("annan", "k3", NOW);
        expect(ledger.pendingCount("u", "2026-10")).toBe(2);
        expect(ledger.pendingCount("u", "2026-09")).toBe(1);
        expect(ledger.pendingCount("annan", "2026-10")).toBe(1);
        ledger.removeKeys("u", "okt", ["k1"]);
        expect(ledger.pendingCount("u", "2026-10")).toBe(1);
    });
});

describe("transcript_exported: plan och scope", () => {
    const choice = { format: "pdf" as const, content: "both" as const };

    it("gratiskontot (online och offline) → plan free", () => {
        for (const via of ["online", "offline"] as const) {
            const p = exportedEventProps({ status: "saved", via, count: 1, bundle: "single" }, { ...choice, scope: "current" });
            expect(p).toEqual({ format: "pdf", scope: "current", count: 1, bundle: "single", content: "both", plan: "free" });
        }
    });

    it("Pro → plan pro, scope från Inspelningar följer med", () => {
        const p = exportedEventProps({ status: "saved", via: "pro", count: 3, bundle: "zip" }, { ...choice, scope: "selected" });
        expect(p).toEqual({ format: "pdf", scope: "selected", count: 3, bundle: "zip", content: "both", plan: "pro" });
    });
});

describe("exportdialogen skickar transcript_exported med exportedEventProps", () => {
    const src = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../components/dashboard/export-dialog.tsx"), "utf8");

    it("anropet bygger fälten med plan och scope", () => {
        expect(src).toMatch(/events\.transcriptExported\(exportedEventProps\(result, \{ format, scope, content \}\)\)/);
        expect(src.match(/transcriptExported\(/g)).toHaveLength(1);
    });
});
