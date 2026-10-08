import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { resolveIntent, setBrowserAuthIntent, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, REOPEN_DEBOUNCE_MS, MAX_IN_FLIGHT, startBrowserAuth, stopBrowserAuth, stopBrowserAuthFor, useBrowserAuthStore } from "./browser-auth";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let clock = 0;
function deps(over: { newNonce?: () => string } = {}) {
    let n = 0;
    return {
        now: () => clock,
        openUrl: vi.fn(async (_url: string) => {}),
        fetchFn: vi.fn(async (_url: string) => new Response("{}", { status: 404 })),
        onSession: vi.fn(),
        apiBase: "http://api/api/v1",
        frontendUrl: "http://web",
        newNonce: () => `nonce-${++n}`,
        ...over,
    };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("inloggningen i webbläsaren", () => {
    beforeEach(() => { vi.useFakeTimers(); stopBrowserAuth(); clock = 0; });
    afterEach(() => { stopBrowserAuth(); vi.useRealTimers(); });

    const ok = (token: string) => new Response(JSON.stringify({ token }), { status: 200 });

    it("sessionen landar när servern svarar, och pollningen städas", async () => {
        const d = deps();
        startBrowserAuth(d, "panel");
        expect(useBrowserAuthStore.getState().isAuthenticating).toBe(true);
        d.fetchFn.mockResolvedValueOnce(ok("t"));
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        await flush();
        expect(d.onSession).toHaveBeenCalledWith({ token: "t" });
        expect(useBrowserAuthStore.getState().isAuthenticating).toBe(false);
        const calls = d.fetchFn.mock.calls.length;
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4);
        expect(d.fetchFn.mock.calls.length).toBe(calls);
    });

    it("dubbelklick öppnar bara en flik", async () => {
        const d = deps();
        startBrowserAuth(d, "panel");
        clock += REOPEN_DEBOUNCE_MS - 1;
        startBrowserAuth(d, "panel");
        await flush();
        expect(d.openUrl).toHaveBeenCalledTimes(1);
    });

    it("ett nytt klick öppnar SAMMA inloggning igen: en nonce, inloggning i första fliken landar", async () => {
        const d = deps();
        startBrowserAuth(d, "panel");
        clock += REOPEN_DEBOUNCE_MS + 1;
        startBrowserAuth(d, "upsell");
        await flush();
        expect(d.openUrl).toHaveBeenCalledTimes(2);
        expect(d.openUrl.mock.calls[0][0]).toBe(d.openUrl.mock.calls[1][0]);
        d.fetchFn.mockResolvedValueOnce(ok("flik1"));
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        await flush();
        expect(d.onSession).toHaveBeenCalledWith({ token: "flik1" });
    });

    it("den som släpper sitt intresse avbryter inte någon annans väntan", async () => {
        const d = deps();
        startBrowserAuth(d, "panel");
        startBrowserAuth(d, "upsell");
        stopBrowserAuthFor("upsell");
        expect(useBrowserAuthStore.getState().owners).toEqual(["panel"]);
        d.fetchFn.mockResolvedValueOnce(ok("p"));
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        await flush();
        expect(d.onSession).toHaveBeenCalledWith({ token: "p" });
    });

    it("när sista intresset släpps avbryts inloggningen", async () => {
        const d = deps();
        startBrowserAuth(d, "panel");
        startBrowserAuth(d, "upsell");
        stopBrowserAuthFor("panel");
        stopBrowserAuthFor("upsell");
        expect(useBrowserAuthStore.getState().isAuthenticating).toBe(false);
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
        expect(d.fetchFn).not.toHaveBeenCalled();
    });

    it("ett svar med sessionen tas emot även om inloggningen avbrutits medan det var på väg", async () => {
        const d = deps();
        let answer!: (r: Response) => void;
        d.fetchFn.mockImplementationOnce(() => new Promise<Response>(r => { answer = r; }));
        startBrowserAuth(d, "upsell");
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        stopBrowserAuthFor("upsell");
        answer({ ok: true, status: 200, json: async () => ({ token: "sen" }) } as unknown as Response);
        await flush();
        expect(d.onSession).toHaveBeenCalledWith({ token: "sen" });
    });

    it("ett svar från en avbruten inloggning tar inte över en ny som pågår", async () => {
        const d = deps();
        let answer!: (r: Response) => void;
        d.fetchFn.mockImplementationOnce(() => new Promise<Response>(r => { answer = r; }));
        startBrowserAuth(d, "upsell");
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        stopBrowserAuthFor("upsell");
        startBrowserAuth(d, "panel");
        vi.spyOn(console, "warn").mockImplementation(() => {});
        answer({ ok: true, status: 200, json: async () => ({ token: "gammal" }) } as unknown as Response);
        await flush();
        expect(d.onSession).not.toHaveBeenCalled();
        expect(useBrowserAuthStore.getState().owners).toEqual(["panel"]);
    });

    it("ett synkront kast när fliken öppnas avbryter inloggningen", async () => {
        const d = deps();
        d.openUrl.mockImplementation(() => { throw new Error("ingen IPC"); });
        vi.spyOn(console, "error").mockImplementation(() => {});
        startBrowserAuth(d, "panel");
        await flush();
        expect(useBrowserAuthStore.getState().isAuthenticating).toBe(false);
    });

    it("hängda förfrågningar staplas inte, och ett nytt klick släpper dem ur taket", async () => {
        const d = deps();
        d.fetchFn.mockImplementation(() => new Promise<Response>(() => {}));
        startBrowserAuth(d, "panel");
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 10);
        expect(d.fetchFn).toHaveBeenCalledTimes(MAX_IN_FLIGHT);
        // Dubbelklick släpper inte taket.
        startBrowserAuth(d, "panel");
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        expect(d.fetchFn).toHaveBeenCalledTimes(MAX_IN_FLIGHT);
        // Ett klick som öppnar fliken igen gör det.
        clock += REOPEN_DEBOUNCE_MS + 1;
        startBrowserAuth(d, "panel");
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        expect(d.fetchFn).toHaveBeenCalledTimes(MAX_IN_FLIGHT + 1);
    });

    it("går ingen flik att öppna avbryts inloggningen för alla", async () => {
        const d = deps();
        d.openUrl.mockImplementation(() => Promise.reject(new Error("nej")));
        vi.spyOn(console, "error").mockImplementation(() => {});
        startBrowserAuth(d, "panel");
        startBrowserAuth(d, "upsell"); // dubbelklick, öppnar ingen egen flik
        await flush();
        expect(useBrowserAuthStore.getState().isAuthenticating).toBe(false);
    });

    it("en flik som inte går att öppna stoppar inte inloggningen medan en annan flik öppnas", async () => {
        const d = deps();
        let resolveFirst!: () => void;
        d.openUrl.mockImplementationOnce(() => new Promise<void>(r => { resolveFirst = r; }));
        d.openUrl.mockImplementationOnce(() => Promise.reject(new Error("nej")));
        vi.spyOn(console, "error").mockImplementation(() => {});
        startBrowserAuth(d, "panel");
        clock += REOPEN_DEBOUNCE_MS + 1;
        startBrowserAuth(d, "upsell");
        await flush();
        expect(useBrowserAuthStore.getState().isAuthenticating).toBe(true);
        resolveFirst();
        await flush();
        expect(useBrowserAuthStore.getState().isAuthenticating).toBe(true);
    });

    it("avsikten följer ägarna: köp vinner, den som släpper tar sin avsikt med sig", async () => {
        const d = { ...deps(), onIntent: vi.fn() };
        startBrowserAuth(d, "upsell", { intent: "upgrade", source: "export" });
        startBrowserAuth(d, "panel", { intent: "free", source: "sign_in_button" });
        stopBrowserAuthFor("upsell");
        d.fetchFn.mockResolvedValueOnce(ok("t"));
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        await flush();
        expect(d.onIntent).toHaveBeenCalledWith({ intent: "free", source: "sign_in_button" });
    });

    it("ett köp som inte kan fortsätta räknas som gratisinloggning, men inloggningen lever", async () => {
        const d = { ...deps(), onIntent: vi.fn() };
        startBrowserAuth(d, "upsell", { intent: "upgrade", source: "export" });
        setBrowserAuthIntent("upsell", { intent: "free", source: "export" });
        expect(useBrowserAuthStore.getState().isAuthenticating).toBe(true);
        d.fetchFn.mockResolvedValueOnce(ok("t"));
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        await flush();
        expect(d.onIntent).toHaveBeenCalledWith({ intent: "free", source: "export" });
    });

    it("resolveIntent: köp före gratis, annars senaste", () => {
        expect(resolveIntent([{ intent: "upgrade", source: "export" }, { intent: "free", source: "sign_in_button" }])).toEqual({ intent: "upgrade", source: "export" });
        expect(resolveIntent([{ intent: "free", source: "export" }, { intent: "free", source: "sign_in_button" }])).toEqual({ intent: "free", source: "sign_in_button" });
        expect(resolveIntent([])).toBeNull();
    });

    it("tar slut efter tidsgränsen, även om webbläsaren aldrig svarar", async () => {
        const d = deps();
        d.openUrl.mockImplementation(() => new Promise<void>(() => {}));
        startBrowserAuth(d, "panel");
        await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS);
        expect(useBrowserAuthStore.getState().isAuthenticating).toBe(false);
    });

    it("ett fel när sessionen sparas fångas och loggas", async () => {
        const d = deps();
        d.onSession.mockImplementation(() => { throw new Error("trasig"); });
        const err = vi.spyOn(console, "error").mockImplementation(() => {});
        startBrowserAuth(d, "panel");
        d.fetchFn.mockResolvedValueOnce(ok("t"));
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        await flush();
        expect(err).toHaveBeenCalled();
    });

    // Felet som fanns: hooken stoppade inloggningen när komponenten avmonterades (vybyte),
    // så sessionen landade aldrig. Hooken får inte ha någon livscykelstädning som avbryter.
    it("en avmontering stoppar inte en pågående inloggning", () => {
        const hook = readFileSync(path.join(SRC, "hooks/use-browser-auth.ts"), "utf8");
        expect(hook).not.toMatch(/useEffect/);
        expect(hook).toMatch(/startBrowserAuth/);
        expect(hook).not.toMatch(/setInterval/);
        // Komponenterna avbryter bara på uttryckligt val: panelens knapp aldrig, fönstret
        // bara på ett ställe (stängning efter ett övergivet köp), aldrig i en effekt.
        const button = readFileSync(path.join(SRC, "components/dashboard/account-button.tsx"), "utf8");
        expect(button).not.toMatch(/stopAuth|stopBrowserAuth|stopPolling/);
        const modal = readFileSync(path.join(SRC, "components/dashboard/upsell-modal.tsx"), "utf8");
        const uses = modal.split("\n").filter(l => /\bstopAuth\b/.test(l) && !/useBrowserAuth\(/.test(l));
        expect(uses).toHaveLength(1);
        expect(modal).not.toMatch(/stopBrowserAuth/);
        const close = modal.slice(modal.indexOf("const close = () =>"), modal.indexOf("const chooseFree"));
        expect(close).toMatch(/\bstopAuth\b/);
    });

    // Ett fönster som försvinner med ett köp på gång: köpet glöms, inloggningen lever.
    it("fönstret glömmer köpet när det försvinner, utan att avbryta inloggningen", () => {
        const modal = readFileSync(path.join(SRC, "components/dashboard/upsell-modal.tsx"), "utf8");
        expect(modal).toMatch(/useEffect\(\(\) => \(\) => forgetUpgrade\(false\)/);
        const forget = modal.slice(modal.indexOf("const forgetUpgrade = (release: boolean) =>"), modal.indexOf("const chooseFree"));
        expect(forget).toMatch(/if \(release\) stopAuth\(\);\s*else setIntent\(\{ intent: 'free'/);
    });

    // Fönstrets val ska gå att klicka medan inloggningen väntar: ett nytt klick öppnar fliken igen.
    it("fönstrets knappar låses inte av en väntande inloggning", () => {
        const modal = readFileSync(path.join(SRC, "components/dashboard/upsell-modal.tsx"), "utf8");
        expect(modal).not.toMatch(/disabled=\{[^}]*(?:[Aa]uthenticating|authWaiting|myAuth)/);
    });
});
