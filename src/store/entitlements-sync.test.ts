import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/lib/api", () => ({
    getEntitlements: vi.fn(async () => ({ plan: "free", counters: { protocol: { limit: 3, used: 1, remaining: 2 } } })),
    reconcileEntitlements: vi.fn(),
}));

const consoleWarn = console.warn;
vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("[zustand persist middleware]")) return;
    consoleWarn(...args);
});

import { getEntitlements, reconcileEntitlements } from "@/lib/api";
import { useAuthStore } from "@/store/auth-store";
import { exportCounterFor, exportLedger, reconcileOfflineExports, startEntitlementsSync, useEntitlementsStore, visibleCounter } from "@/store/entitlements-store";

const exp = () => Math.floor(Date.now() / 1000) + 3600;
const signedIn = (stripeStatus: string | null) =>
    useAuthStore.setState({ token: "t", userId: "u", isSignedIn: true, expiresAt: exp(), stripeStatus });

describe("räknarna följer planbytet (jämför föregående och nytt tillstånd)", () => {
    let stop: () => void;
    beforeEach(() => {
        vi.mocked(getEntitlements).mockClear();
        useEntitlementsStore.getState().reset();
    });
    afterEach(() => stop?.());

    it("Pro → gratis med samma token: räknarna hämtas", () => {
        signedIn("active");
        stop = startEntitlementsSync();
        expect(getEntitlements).not.toHaveBeenCalled();
        useAuthStore.setState({ stripeStatus: "canceled" });
        expect(getEntitlements).toHaveBeenCalledTimes(1);
    });

    it("gratis → Pro: räknarna töms", async () => {
        signedIn(null);
        stop = startEntitlementsSync();
        await vi.waitFor(() => expect(useEntitlementsStore.getState().counters.protocol).toBeTruthy());
        useAuthStore.setState({ stripeStatus: "active" });
        expect(useEntitlementsStore.getState().counters).toEqual({});
    });

    it("en hämtning som pågår när räknarna töms skriver inte tillbaka dem", async () => {
        let release!: (v: any) => void;
        vi.mocked(getEntitlements).mockImplementationOnce(() => new Promise(r => { release = r; }));
        signedIn(null);
        const pending = useEntitlementsStore.getState().refresh();
        useEntitlementsStore.getState().reset();
        release({ plan: "free", counters: { protocol: { limit: 3, used: 3, remaining: 0 } } });
        await pending;
        expect(useEntitlementsStore.getState().counters).toEqual({});
    });
});

describe("vilken räknare som visas", () => {
    const now = new Date("2026-10-06T12:00:00Z");
    const c = { limit: 10, used: 1, remaining: 9, period: "2026-10", resets_at: "2026-11-01" };

    it("gratiskonto ser räknaren", () => {
        expect(visibleCounter({ isSignedIn: true, isPro: false, counter: c }, now)).toBe(c);
    });
    it("Pro ser ingen räknare", () => {
        expect(visibleCounter({ isSignedIn: true, isPro: true, counter: c }, now)).toBeNull();
    });
    it("utloggad ser ingen räknare", () => {
        expect(visibleCounter({ isSignedIn: false, isPro: false, counter: c }, now)).toBeNull();
    });
    it("räknare från en period som tagit slut visas inte", () => {
        expect(visibleCounter({ isSignedIn: true, isPro: false, counter: { ...c, period: "2026-09", resets_at: "2026-10-01" } }, now)).toBeNull();
    });
});

describe("exportdialogens räknare (store + liggare)", () => {
    const now = new Date("2026-10-06T12:00:00Z");
    const allowanceExp = Date.parse("2026-11-01T00:00:00Z") / 1000;
    const c = { limit: 10, used: 1, remaining: 9, period: "2026-10", resets_at: "2026-11-01" };

    it("9 av 10, och en export utan nätverk drar av lokalt", () => {
        const u = "räknare-u1";
        expect(exportCounterFor(u, c, now)).toEqual({ remaining: 9, limit: 10 });
        exportLedger.rememberAllowance(u, { kind: "export", n: 9, period: "2026-10", exp: allowanceExp, token: "tok-u1" });
        expect(exportLedger.drawOffline(u, "nyckel-1", now)).toBe(true);
        expect(exportCounterFor(u, c, now)).toEqual({ remaining: 8, limit: 10 });
        exportLedger.removeKeys(u, "tok-u1", ["nyckel-1"]);
        expect(exportCounterFor(u, c, now)).toEqual({ remaining: 9, limit: 10 });
    });

    it("ingen synlig räknare: ingen rad, även med väntande exporter", () => {
        expect(exportCounterFor("räknare-u1", null, now)).toBeNull();
    });
});

describe("avstämningen vars svar inte läggs in", () => {
    it("en hämtning som hann före: räknaren hämtas om efter avstämningen", async () => {
        const u = "räknare-u4";
        const stale = { plan: "free", counters: { export: { limit: 10, used: 1, remaining: 9, period: "2026-10" } }, offline_allowance: null };
        const fresh = { plan: "free", counters: { export: { limit: 10, used: 3, remaining: 7, period: "2026-10" } }, offline_allowance: null };
        useAuthStore.setState({ token: "t", userId: u, isSignedIn: true, expiresAt: exp(), stripeStatus: null });
        exportLedger.rememberAllowance(u, { kind: "export", n: 9, period: "2026-10", exp: Math.floor(Date.now() / 1000) + 86400, token: "tok-u4" });
        exportLedger.drawOffline(u, "a", new Date());
        exportLedger.drawOffline(u, "b", new Date());

        let release!: (v: any) => void;
        vi.mocked(reconcileEntitlements).mockImplementationOnce(() => new Promise(r => { release = r; }));
        vi.mocked(getEntitlements).mockReset();
        vi.mocked(getEntitlements).mockResolvedValueOnce(stale as never).mockResolvedValueOnce(fresh as never);

        const reconciling = reconcileOfflineExports();       // startar först
        await useEntitlementsStore.getState().refresh();     // men svarar efter hämtningen
        expect(useEntitlementsStore.getState().counters.export.remaining).toBe(9);
        release({ kind: "ok", body: fresh });
        expect(await reconciling).toBe(2);
        expect(exportLedger.pendingCount(u, "2026-10")).toBe(0);
        await vi.waitFor(() => expect(useEntitlementsStore.getState().counters.export.remaining).toBe(7));
        expect(getEntitlements).toHaveBeenCalledTimes(2);
    });
});
