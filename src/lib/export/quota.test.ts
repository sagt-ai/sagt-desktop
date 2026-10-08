import { describe, it, expect, vi } from "vitest";
import type { EntitlementCallOutcome } from "@/lib/api";
import { entitlementGate, type EntitlementsResponse, type OfflineAllowance } from "@/lib/entitlements";
import { ExportLedger, LEDGER_STORAGE_KEY, RECONCILE_CHUNK, exportClick, permitExport, reconcileOffline, type KeyValueStorage } from "./quota";
import { ExportKey, runExport } from "./run";
import type { ExportMeeting } from "./types";

const NOW = new Date("2026-10-06T12:00:00Z");
const EXP = Date.parse("2026-11-01T00:00:00Z") / 1000;
const allowance = (n: number, token = `tok${n}`, exp = EXP): OfflineAllowance => ({ kind: "export", n, period: "2026-10", exp, token });
const body = (a: OfflineAllowance | null = allowance(9, "ny")): EntitlementsResponse => ({
    plan: "free",
    counters: { export: { limit: 10, used: 1, remaining: 9, period: "2026-10", resets_at: "2026-11-01" } },
    offline_allowance: a,
});

class MemoryStorage implements KeyValueStorage {
    data = new Map<string, string>();
    getItem(k: string) { return this.data.get(k) ?? null; }
    setItem(k: string, v: string) { this.data.set(k, v); }
}

/** Lagring där varje åtkomst kastar, som en blockerad localStorage. */
class ThrowingStorage implements KeyValueStorage {
    getItem(): string | null { throw new Error("SecurityError: access denied"); }
    setItem(): void { throw new Error("QuotaExceededError"); }
}

/** En liggare med en egen lagring som består mellan anropen (som localStorage). */
const memLedger = () => { const s = new MemoryStorage(); return new ExportLedger(() => s); };

const networkDown = () => Promise.reject(new TypeError("Failed to fetch"));
const ok = (b = body()): Promise<EntitlementCallOutcome> => Promise.resolve({ kind: "ok", body: b });

function free(over: Partial<Parameters<typeof permitExport>[0]> = {}): Parameters<typeof permitExport>[0] {
    return {
        isSignedIn: true, isPro: false, userId: "user_a", token: "jwt", key: "key-00000001",
        consume: vi.fn(() => ok()), ledger: memLedger(), now: NOW,
        ...over,
    };
}

describe("permitExport: vem som får exportera", () => {
    it("Pro anropar aldrig servern", async () => {
        const consume = vi.fn(() => ok());
        const p = await permitExport(free({ isPro: true, consume }));
        expect(p).toEqual({ ok: true, via: "pro" });
        expect(consume).not.toHaveBeenCalled();
    });

    it("Pro exporterar utan nät, utan förskott", async () => {
        const p = await permitExport(free({ isPro: true, consume: vi.fn(networkDown) }));
        expect(p).toEqual({ ok: true, via: "pro" });
    });

    it("utloggad: konto först, inget anrop", async () => {
        const consume = vi.fn(() => ok());
        expect(await permitExport(free({ isSignedIn: false, consume }))).toEqual({ ok: false, reason: "sign_in" });
        expect(await permitExport(free({ token: null, consume }))).toEqual({ ok: false, reason: "sign_in" });
        expect(consume).not.toHaveBeenCalled();
    });

    it("gratiskonto: servern drar en enhet med nyckeln, och svaret läggs in", async () => {
        const consume = vi.fn(() => ok());
        const onBody = vi.fn();
        const p = await permitExport(free({ consume, onBody, key: "key-abcdefgh" }));
        expect(p).toEqual({ ok: true, via: "online" });
        expect(consume).toHaveBeenCalledWith("key-abcdefgh", "jwt");
        expect(onBody).toHaveBeenCalledWith(body());
    });

    it("402 från servern → kvoten slut med serverns siffror", async () => {
        const consume = vi.fn(() => Promise.resolve<EntitlementCallOutcome>({
            kind: "exhausted", quota: { kind: "export", limit: 10, used: 10, resets_at: "2026-11-01" },
        }));
        expect(await permitExport(free({ consume }))).toEqual({
            ok: false, reason: "quota_exhausted", origin: "server",
            quota: { used: 10, limit: 10, resets_at: "2026-11-01" },
        });
    });

    it("serverfel släpps inte igenom på förskottet", async () => {
        const ledger = memLedger();
        ledger.rememberAllowance("user_a", allowance(10));
        const consume = vi.fn(() => Promise.resolve<EntitlementCallOutcome>({ kind: "error", status: 500, detail: "boom" }));
        expect(await permitExport(free({ consume, ledger }))).toEqual({ ok: false, reason: "error", status: 500, detail: "boom" });
        expect(ledger.pending("user_a")).toEqual([]);
    });
});

describe("offline: förskottet och liggaren", () => {
    it("nätfel drar av från förskottet och skriver nyckeln i liggaren på disk", async () => {
        const storage = new MemoryStorage();
        const ledger = new ExportLedger(() => storage);
        ledger.rememberAllowance("user_a", allowance(2));
        const p = await permitExport(free({ consume: vi.fn(networkDown), ledger, key: "offline-key-1" }));
        expect(p).toEqual({ ok: true, via: "offline" });
        expect(ledger.offlineRemaining("user_a", NOW)).toBe(1);
        // Liggaren ligger i lagringen, inte bara i minnet: den ska överleva en omstart.
        const fresh = new ExportLedger(() => storage);
        expect(fresh.pending("user_a")).toEqual([{ userId: "user_a", allowance: allowance(2), keys: ["offline-key-1"] }]);
        expect(storage.getItem(LEDGER_STORAGE_KEY)).toContain("offline-key-1");
    });

    it("samma nyckel offline igen drar inget nytt", async () => {
        const ledger = memLedger();
        ledger.rememberAllowance("user_a", allowance(2));
        await permitExport(free({ consume: vi.fn(networkDown), ledger, key: "offline-key-1" }));
        await permitExport(free({ consume: vi.fn(networkDown), ledger, key: "offline-key-1" }));
        expect(ledger.offlineRemaining("user_a", NOW)).toBe(1);
    });

    it("förskottet slut → kvoten slut, inget skrivs", async () => {
        const ledger = memLedger();
        ledger.rememberAllowance("user_a", allowance(1));
        expect((await permitExport(free({ consume: vi.fn(networkDown), ledger, key: "k-000001" }))).ok).toBe(true);
        expect(await permitExport(free({ consume: vi.fn(networkDown), ledger, key: "k-000002" })))
            .toEqual({ ok: false, reason: "quota_exhausted", origin: "offline", quota: null });
        expect(ledger.pending("user_a")[0].keys).toEqual(["k-000001"]);
    });

    it("inget förskott, eller ett som gått ut → nej", async () => {
        const ledger = memLedger();
        expect(await permitExport(free({ consume: vi.fn(networkDown), ledger }))).toEqual({ ok: false, reason: "offline_no_allowance" });
        ledger.rememberAllowance("user_a", allowance(5, "gammal", Date.parse("2026-10-01T00:00:00Z") / 1000));
        expect(await permitExport(free({ consume: vi.fn(networkDown), ledger }))).toEqual({ ok: false, reason: "offline_no_allowance" });
    });

    it("ett annat kontos förskott används inte", async () => {
        const ledger = memLedger();
        ledger.rememberAllowance("user_b", allowance(5));
        expect(await permitExport(free({ consume: vi.fn(networkDown), ledger }))).toEqual({ ok: false, reason: "offline_no_allowance" });
    });

    it("ett nytt förskott räknar av det som ännu inte stämts av", () => {
        const ledger = memLedger();
        ledger.rememberAllowance("user_a", allowance(3, "t1"));
        ledger.drawOffline("user_a", "k-000001", NOW);
        ledger.drawOffline("user_a", "k-000002", NOW);
        // Servern har inte sett de två än, så dess nya förskott säger fortfarande 3.
        ledger.rememberAllowance("user_a", allowance(3, "t2"));
        expect(ledger.offlineRemaining("user_a", NOW)).toBe(1);
    });

    it("lagring som kastar kraschar inte, och minneskopian bär sessionen", async () => {
        const ledger = new ExportLedger(() => new ThrowingStorage());
        expect(() => ledger.rememberAllowance("user_a", allowance(1))).not.toThrow();
        const p = await permitExport(free({ consume: vi.fn(networkDown), ledger }));
        expect(p).toEqual({ ok: true, via: "offline" });
        expect(ledger.pending("user_a")).toHaveLength(1);
    });

    it("lagring som inte går att nå alls (getter kastar) kraschar inte", async () => {
        const ledger = new ExportLedger(() => { throw new Error("localStorage is not available"); });
        expect(ledger.offlineRemaining("user_a", NOW)).toBe(0);
        expect(await permitExport(free({ consume: vi.fn(networkDown), ledger }))).toEqual({ ok: false, reason: "offline_no_allowance" });
    });

    it("full lagring (läsning går, skrivning kastar): dragen räknas ändå", () => {
        const storage = new MemoryStorage();
        const ledger = new ExportLedger(() => storage);
        ledger.rememberAllowance("user_a", allowance(2));
        storage.setItem = () => { throw new Error("QuotaExceededError"); };
        expect(ledger.drawOffline("user_a", "k-000001", NOW)).toBe(true);
        expect(ledger.drawOffline("user_a", "k-000002", NOW)).toBe(true);
        expect(ledger.drawOffline("user_a", "k-000003", NOW)).toBe(false);
        expect(ledger.pending("user_a")[0].keys).toEqual(["k-000001", "k-000002"]);
    });

    it("trasig JSON i lagringen ger en tom liggare", () => {
        const storage = new MemoryStorage();
        storage.setItem(LEDGER_STORAGE_KEY, "{inte json");
        expect(new ExportLedger(() => storage).pending("user_a")).toEqual([]);
    });
});

describe("avstämningen", () => {
    function ledgerWith(keys: string[], a = allowance(keys.length + 5)) {
        const ledger = memLedger();
        ledger.rememberAllowance("user_a", a);
        for (const k of keys) ledger.drawOffline("user_a", k, NOW);
        return ledger;
    }

    it("skickar liggaren med förskottet och tömmer den vid 200", async () => {
        const ledger = ledgerWith(["k-000001", "k-000002"]);
        const call = vi.fn(() => ok());
        const onBody = vi.fn();
        expect(await reconcileOffline({ userId: "user_a", token: "jwt", ledger, call, onBody })).toBe(2);
        expect(call).toHaveBeenCalledTimes(1);
        expect(call).toHaveBeenCalledWith(allowance(7), ["k-000001", "k-000002"], "jwt");
        expect(ledger.pending("user_a")).toEqual([]);
        expect(onBody).toHaveBeenCalledTimes(1);
    });

    it("en andra avstämning skickar ingenting", async () => {
        const ledger = ledgerWith(["k-000001"]);
        const call = vi.fn(() => ok());
        await reconcileOffline({ userId: "user_a", token: "jwt", ledger, call });
        await reconcileOffline({ userId: "user_a", token: "jwt", ledger, call });
        expect(call).toHaveBeenCalledTimes(1);
    });

    it.each([
        ["nätfel", () => networkDown()],
        ["400", () => Promise.resolve<EntitlementCallOutcome>({ kind: "error", status: 400, detail: "ogiltigt" })],
        ["503", () => Promise.resolve<EntitlementCallOutcome>({ kind: "error", status: 503, detail: "" })],
        ["401", () => Promise.resolve<EntitlementCallOutcome>({ kind: "error", status: 401, detail: "" })],
    ])("%s: liggaren ligger kvar", async (_, fn) => {
        const ledger = ledgerWith(["k-000001", "k-000002"]);
        const call = vi.fn(fn);
        expect(await reconcileOffline({ userId: "user_a", token: "jwt", ledger, call })).toBe(0);
        expect(ledger.pending("user_a")[0].keys).toEqual(["k-000001", "k-000002"]);
    });

    it("en post som servern avvisar stoppar inte nästa", async () => {
        const ledger = ledgerWith(["k-000001"], allowance(5, "gammal"));
        ledger.rememberAllowance("user_a", allowance(4, "ny"));
        ledger.drawOffline("user_a", "k-000002", NOW);
        const call = vi.fn((a: OfflineAllowance) => a.token === "gammal"
            ? Promise.resolve<EntitlementCallOutcome>({ kind: "error", status: 400, detail: "ogiltigt" })
            : ok());
        expect(await reconcileOffline({ userId: "user_a", token: "jwt", ledger, call })).toBe(1);
        expect(call).toHaveBeenCalledTimes(2);
        // Den avvisade ligger kvar (töms bara vid 200), den godkända är borta.
        expect(ledger.pending("user_a")).toEqual([{ userId: "user_a", allowance: allowance(5, "gammal"), keys: ["k-000001"] }]);
    });

    it("högst RECONCILE_CHUNK nycklar per anrop", async () => {
        const keys = Array.from({ length: RECONCILE_CHUNK + 5 }, (_, i) => `k-${String(i).padStart(6, "0")}`);
        const ledger = ledgerWith(keys);
        const call = vi.fn(() => ok());
        await reconcileOffline({ userId: "user_a", token: "jwt", ledger, call });
        expect(call).toHaveBeenCalledTimes(2);
        expect((call.mock.calls[0] as unknown[])[1]).toHaveLength(RECONCILE_CHUNK);
        expect((call.mock.calls[1] as unknown[])[1]).toHaveLength(5);
        expect(ledger.pending("user_a")).toEqual([]);
    });

    it("rör bara det inloggade kontots poster", async () => {
        const ledger = ledgerWith(["k-000001"]);
        const call = vi.fn(() => ok());
        await reconcileOffline({ userId: "user_b", token: "jwt", ledger, call });
        expect(call).not.toHaveBeenCalled();
        expect(ledger.pending("user_a")).toHaveLength(1);
    });
});

describe("runExport: ett tryck på Exportera", () => {
    const meetings = (n: number): ExportMeeting[] => Array.from({ length: n }, (_, i) => ({
        createdAt: `2026-10-0${i + 1}T10:00:00Z`, lines: [{ label: "Du", text: `Möte ${i}` }], analysis: null,
    }));
    function setup(permitResult: Awaited<ReturnType<Parameters<typeof runExport>[0]["permit"]>>, saveResults: boolean[] = [true]) {
        let k = 0;
        const key = new ExportKey(() => `key-${String(++k).padStart(6, "0")}`);
        const permit = vi.fn(async (_key: string) => permitResult);
        const save = vi.fn(async () => saveResults.shift() ?? true);
        const build = vi.fn(async () => ({ name: "f", bytes: new Uint8Array([1]) }));
        return { key, permit, save, build };
    }

    it("kvoten slut (servern 402): ingen fil skrivs", async () => {
        const s = setup({ ok: false, reason: "quota_exhausted", origin: "server", quota: { used: 10, limit: 10 } });
        const r = await runExport({ loadMeetings: async () => meetings(1), format: "pdf", content: "transcript", bundle: "single", ...s });
        expect(r.status).toBe("denied");
        expect(s.save).not.toHaveBeenCalled();
    });

    it("zip med tre möten är en export: en fråga, en nyckel", async () => {
        const s = setup({ ok: true, via: "online" });
        const r = await runExport({ loadMeetings: async () => meetings(3), format: "docx", content: "transcript", bundle: "zip", ...s });
        expect(r).toEqual({ status: "saved", via: "online", count: 3, bundle: "zip" });
        expect(s.permit).toHaveBeenCalledTimes(1);
    });

    it("avbruten Spara som → samma nyckel vid nästa försök; sparad fil → ny nyckel", async () => {
        const s = setup({ ok: true, via: "online" }, [false, true, true]);
        const go = () => runExport({ loadMeetings: async () => meetings(1), format: "txt", content: "transcript", bundle: "single", ...s });
        expect((await go()).status).toBe("cancelled");
        expect((await go()).status).toBe("saved");
        expect((await go()).status).toBe("saved");
        const keys = s.permit.mock.calls.map(c => c[0]);
        expect(keys[0]).toBe(keys[1]);
        expect(keys[2]).not.toBe(keys[1]);
    });

    it("ett fel när filen byggs kostar ingen export", async () => {
        const s = setup({ ok: true, via: "online" });
        s.build.mockRejectedValueOnce(new Error("render"));
        await expect(runExport({ loadMeetings: async () => meetings(1), format: "pdf", content: "transcript", bundle: "single", ...s })).rejects.toThrow();
        expect(s.permit).not.toHaveBeenCalled();
    });

    it("inget att exportera: ingen fråga till servern", async () => {
        const s = setup({ ok: true, via: "online" });
        const r = await runExport({ loadMeetings: async () => meetings(1), format: "pdf", content: "analysis", bundle: "single", ...s });
        expect(r.status).toBe("empty");
        expect(s.permit).not.toHaveBeenCalled();
    });

    it("nyckeln har den form servern godtar", () => {
        // Samma regel som servern: 8–128 tecken ur A–Z a–z 0–9 _ -, inte två understreck först.
        const re = /^(?!__)[A-Za-z0-9_-]{8,128}$/;
        for (let i = 0; i < 20; i++) expect(new ExportKey().current()).toMatch(re);
    });
});

describe("klicket på Exportera", () => {
    const gate = (isSignedIn: boolean, isPro: boolean, remaining: number | null) => entitlementGate("export", {
        isSignedIn, isPro, now: NOW,
        counter: remaining === null ? null : { limit: 10, used: 10 - remaining, remaining, resets_at: "2026-11-01" },
    });

    it("gratis på noll: kvotraden och klientens quota_exhausted, en gång", () => {
        const capture = vi.fn();
        const r = exportClick(gate(true, false, 0), { used: 10, limit: 10, resets_at: "2026-11-01" }, capture, NOW);
        expect(r).toEqual({ source: "quota_export", quota: { used: 10, limit: 10, resets_at: "2026-11-01" } });
        expect(capture).toHaveBeenCalledWith("quota_exhausted", { kind: "export", limit: 10, used: 10, period: "2026-10", plan: "free", origin: "client" });
        expect(capture.mock.calls.filter(c => c[0] === "quota_exhausted")).toHaveLength(1);
    });

    it("gratis med exporter kvar, okänd räknare och Pro öppnar inte fönstret", () => {
        const capture = vi.fn();
        for (const g of [gate(true, false, 3), gate(true, false, null), gate(true, true, 0)]) {
            expect(exportClick(g, null, capture, NOW)).toBeNull();
        }
        expect(capture).not.toHaveBeenCalled();
    });

    it("utloggad → konto först", () => {
        expect(exportClick(gate(false, false, 5), null, vi.fn(), NOW)).toEqual({ source: "export", quota: null });
    });
});
