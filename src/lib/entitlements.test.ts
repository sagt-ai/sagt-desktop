import { describe, it, expect, vi } from "vitest";
import {
    AnalyzeHttpError,
    analyzeErrorFrom,
    conflictCode,
    entitlementGate,
    IdempotencyKeys,
    IN_PROGRESS_DELAYS_MS,
    requestProtocol,
    type EntitlementGate,
    type GateInput,
} from "./entitlements";
import { errorSlug } from "./error-slug";

const counter = (remaining: number, limit = 3) => ({ limit, used: limit - remaining, remaining });

describe("entitlementGate('protocol')", () => {
    // Uttömmande över inloggning × Pro × räknarens läge.
    const CASES: Array<[string, GateInput, EntitlementGate]> = [
        ["utloggad", { isSignedIn: false, isPro: false }, "sign_in"],
        ["utloggad med gammal räknare", { isSignedIn: false, isPro: false, counter: counter(2) }, "sign_in"],
        ["Pro utan räknare", { isSignedIn: true, isPro: true }, "allowed"],
        ["Pro med räknare på noll", { isSignedIn: true, isPro: true, counter: counter(0) }, "allowed"],
        ["gratis, räknaren ej hämtad", { isSignedIn: true, isPro: false, counter: null }, "allowed"],
        ["gratis, 2 kvar", { isSignedIn: true, isPro: false, counter: counter(2) }, "allowed"],
        ["gratis, 1 kvar", { isSignedIn: true, isPro: false, counter: counter(1) }, "allowed"],
        ["gratis, 0 kvar", { isSignedIn: true, isPro: false, counter: counter(0) }, "quota_exhausted"],
    ];
    it.each(CASES)("%s", (_, input, expected) => {
        expect(entitlementGate("protocol", input)).toBe(expected);
    });

    it("räknaren på noll från en period som tagit slut stoppar inte (servern avgör)", () => {
        const stale = { limit: 3, used: 3, remaining: 0, resets_at: "2026-11-01" };
        expect(entitlementGate("protocol", { isSignedIn: true, isPro: false, counter: stale, now: new Date("2026-10-31T23:59:00Z") })).toBe("quota_exhausted");
        expect(entitlementGate("protocol", { isSignedIn: true, isPro: false, counter: stale, now: new Date("2026-11-01T00:00:00Z") })).toBe("allowed");
    });

    it("mallar utöver standard: bara Pro", () => {
        expect(entitlementGate("template", { isSignedIn: true, isPro: true })).toBe("allowed");
        expect(entitlementGate("template", { isSignedIn: true, isPro: false, counter: counter(3) })).toBe("quota_exhausted");
        expect(entitlementGate("template", { isSignedIn: false, isPro: false })).toBe("sign_in");
    });
});

describe("analyzeErrorFrom", () => {
    const quotaBody = JSON.stringify({
        detail: "Du har använt 3 av 3 AI-protokoll den här månaden.",
        code: "quota_exhausted", kind: "protocol", limit: 3, used: 3, resets_at: "2026-11-01",
    });

    it("402 med kvotfält → quota, slug quota_exhausted", () => {
        const e = analyzeErrorFrom(402, null, quotaBody);
        expect(e.quota).toEqual({ kind: "protocol", limit: 3, used: 3, resets_at: "2026-11-01" });
        expect(e.message.startsWith("Payment Required")).toBe(true);
        expect(errorSlug(e)).toBe("quota_exhausted");
    });

    it("402 för mallen bär kind template", () => {
        const e = analyzeErrorFrom(402, null, JSON.stringify({
            detail: "Den här protokollmallen ingår i Pro.", code: "quota_exhausted", kind: "template",
            limit: 0, used: 0, resets_at: null,
        }));
        expect(e.quota?.kind).toBe("template");
    });

    it("402 utan code (Pro krävs) → ingen kvot, slug not_pro", () => {
        const e = analyzeErrorFrom(402, null, JSON.stringify({ detail: "Pro-prenumeration krävs för denna funktion." }));
        expect(e.quota).toBeNull();
        expect(errorSlug(e)).toBe("not_pro");
    });

    it("401, 413 och 503 behåller sina prefix", () => {
        expect(analyzeErrorFrom(401, null, '{"detail":"x"}').message).toMatch(/^Unauthorized/);
        expect(errorSlug(analyzeErrorFrom(413, null, '{"detail":"För lång"}'))).toBe("file_too_large");
        expect(analyzeErrorFrom(503, null, "inte json").detail).toBe("inte json");
    });

    it("409: svarshuvudet först, texten som reserv", () => {
        expect(analyzeErrorFrom(409, "request_in_progress", "{}").conflict).toBe("request_in_progress");
        expect(analyzeErrorFrom(409, "idempotency_key_reused", "{}").conflict).toBe("idempotency_key_reused");
        expect(analyzeErrorFrom(409, null, JSON.stringify({
            detail: "Begäran pågår redan. Försök igen om en stund med samma nyckel.",
        })).conflict).toBe("request_in_progress");
        expect(analyzeErrorFrom(409, null, JSON.stringify({
            detail: "Nyckeln är redan använd för en annan begäran. Skapa en ny nyckel.",
        })).conflict).toBe("idempotency_key_reused");
        expect(conflictCode(null, "något annat")).toBeNull();
    });
});

describe("IdempotencyKeys", () => {
    const keys = () => {
        let n = 0;
        return new IdempotencyKeys(() => `nyckel-${++n}`);
    };

    it("samma text och mall igen före ett lyckat svar → samma nyckel", () => {
        const k = keys();
        expect(k.keyFor("text", "general")).toBe("nyckel-1");
        expect(k.keyFor("text", "general")).toBe("nyckel-1");
    });

    it("ny text eller ny mall → ny nyckel", () => {
        const k = keys();
        k.keyFor("text", "general");
        expect(k.keyFor("annan text", "general")).toBe("nyckel-2");
        expect(k.keyFor("annan text", "standup")).toBe("nyckel-3");
    });

    it("efter ett lyckat svar är nästa begäran ny, även med samma text", () => {
        const k = keys();
        k.keyFor("text", "general");
        k.done("text", "general");
        expect(k.keyFor("text", "general")).toBe("nyckel-2");
    });

    it("två begäranden samtidigt behåller var sin nyckel", () => {
        const k = keys();
        expect(k.keyFor("möte A", "general")).toBe("nyckel-1");
        expect(k.keyFor("möte B", "general")).toBe("nyckel-2");
        k.done("möte A", "general");
        // B:s svar gick förlorat; omförsöket ska få B:s nyckel, inte en ny.
        expect(k.keyFor("möte B", "general")).toBe("nyckel-2");
    });

    it("standardnyckeln har formen servern kräver", () => {
        const key = new IdempotencyKeys().keyFor("t", "general");
        expect(key).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
        expect(key.startsWith("__")).toBe(false);
    });
});

describe("requestProtocol", () => {
    const conflict = (code: "request_in_progress" | "idempotency_key_reused") =>
        new AnalyzeHttpError("Re-analys misslyckades: konflikt", 409, "", null, code);
    const noSleep = vi.fn(async () => {});

    it("409 request_in_progress → väntar och försöker igen med SAMMA nyckel", async () => {
        const seen: string[] = [];
        const call = vi.fn(async (_t: string, _m: string, _tok: string, o: { idempotencyKey: string }) => {
            seen.push(o.idempotencyKey);
            if (seen.length < 3) throw conflict("request_in_progress");
            return { summary: "ok" };
        });
        const k = new IdempotencyKeys(() => `k-${seen.length}`);
        await expect(requestProtocol({ text: "t", templateId: "general", token: "x", keys: k, call, sleep: noSleep })).resolves.toEqual({ summary: "ok" });
        expect(new Set(seen).size).toBe(1);
        expect(seen.length).toBe(3);
    });

    it("409 request_in_progress för länge → kastar, utan att byta nyckel", async () => {
        const seen: string[] = [];
        const call = vi.fn(async (_t: string, _m: string, _tok: string, o: { idempotencyKey: string }) => {
            seen.push(o.idempotencyKey);
            throw conflict("request_in_progress");
        });
        let n = 0;
        const k = new IdempotencyKeys(() => `k-${++n}`);
        await expect(requestProtocol({ text: "t", templateId: "general", token: "x", keys: k, call, sleep: noSleep })).rejects.toBeInstanceOf(AnalyzeHttpError);
        expect(seen.length).toBe(IN_PROGRESS_DELAYS_MS.length + 1);
        expect(new Set(seen)).toEqual(new Set(["k-1"]));
    });

    it("409 idempotency_key_reused → en ny nyckel, ett försök", async () => {
        const seen: string[] = [];
        const call = vi.fn(async (_t: string, _m: string, _tok: string, o: { idempotencyKey: string }) => {
            seen.push(o.idempotencyKey);
            throw conflict("idempotency_key_reused");
        });
        let n = 0;
        const k = new IdempotencyKeys(() => `k-${++n}`);
        await expect(requestProtocol({ text: "t", templateId: "general", token: "x", keys: k, call, sleep: noSleep })).rejects.toBeInstanceOf(AnalyzeHttpError);
        expect(seen).toEqual(["k-1", "k-2"]);
    });

    it("nätfel → nyckeln står kvar, så att användarens omförsök inte drar ett protokoll till", async () => {
        let n = 0;
        const k = new IdempotencyKeys(() => `k-${++n}`);
        const failing = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
        await expect(requestProtocol({ text: "t", templateId: "general", token: "x", keys: k, call: failing, sleep: noSleep })).rejects.toThrow();
        const seen: string[] = [];
        const ok = vi.fn(async (_t: string, _m: string, _tok: string, o: { idempotencyKey: string }) => { seen.push(o.idempotencyKey); return {}; });
        await requestProtocol({ text: "t", templateId: "general", token: "x", keys: k, call: ok, sleep: noSleep });
        expect(seen).toEqual(["k-1"]);
    });

    it("nyckeln duger inte ens efter förnyelsen → släpps, nästa försök får en ny", async () => {
        let n = 0;
        const k = new IdempotencyKeys(() => `k-${++n}`);
        const call = vi.fn(async () => { throw conflict("idempotency_key_reused"); });
        await expect(requestProtocol({ text: "t", templateId: "general", token: "x", keys: k, call, sleep: noSleep })).rejects.toBeInstanceOf(AnalyzeHttpError);
        expect(k.keyFor("t", "general")).toBe("k-3");
    });

    it("402 kastas direkt, inga omförsök", async () => {
        const call = vi.fn(async () => { throw analyzeErrorFrom(402, null, '{"code":"quota_exhausted","kind":"protocol","limit":3,"used":3}'); });
        await expect(requestProtocol({ text: "t", templateId: "general", token: "x", keys: new IdempotencyKeys(), call, sleep: noSleep })).rejects.toMatchObject({ status: 402 });
        expect(call).toHaveBeenCalledTimes(1);
    });
});
