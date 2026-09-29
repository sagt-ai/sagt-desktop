import { describe, it, expect, vi, beforeEach } from "vitest";

// "Analysera igen" på en synkad inspelning vars molnjobb TTL raderat gav 404,
// och appen visade ett fel i stället för att analysera den lokala texten. Här är bara fetch
// mockad; api.ts körs på riktigt, så att 404-klassningen testas mot samma svar som backend ger.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

import { invoke } from "@tauri-apps/api/core";
import { bestSavedText, forgetCloudJob, reanalyzeRecording } from "./reanalyze";
import { useSettingsStore } from "@/store/settings-store";

const ANALYSIS = { summary: "Lokal analys", key_decisions: ["B"], action_items: [], template_used: "general" };
const TEXT = "Vi bestämde att lansera i oktober.";

type Route = { status: number; body: unknown };
let routes: Record<string, Route>;
const fetchMock = vi.fn(async (url: string) => {
    const path = new URL(url, "http://x").pathname;
    const key = Object.keys(routes).find(k => path.endsWith(k));
    const r = key ? routes[key] : { status: 500, body: { detail: "oväntad väg" } };
    return new Response(JSON.stringify(r.body), { status: r.status });
});
const paths = () => fetchMock.mock.calls.map(([url]) => new URL(url, "http://x").pathname);

const consoleWarn = console.warn;
vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("[zustand persist middleware]")) return;
    consoleWarn(...args);
});

beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    useSettingsStore.setState({ backendUrl: "http://api.test/api/v1" });
    routes = { "/analyze": { status: 200, body: ANALYSIS } };
});

const run = (over: Partial<Parameters<typeof reanalyzeRecording>[0]> = {}) =>
    reanalyzeRecording({ cloudJobId: "job-1", cloudSync: true, fullText: TEXT, templateId: "general", token: "t", ...over });

describe("reanalyzeRecording", () => {
    it("analyserar den lokala texten när molnjobbet är raderat (404)", async () => {
        routes["/jobs/job-1/reanalyze"] = { status: 404, body: { detail: "Job not found" } };

        const out = await run();

        expect(out).toEqual({ raw: ANALYSIS, cloudJobGone: true });
        expect(paths()).toEqual(["/api/v1/jobs/job-1/reanalyze", "/api/v1/analyze"]);
        const [, init] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
        expect(JSON.parse(init.body as string).text).toBe(TEXT);
    });

    it("faller inte tillbaka vid andra fel: 503 är Berget nere, inte ett borttaget jobb", async () => {
        routes["/jobs/job-1/reanalyze"] = { status: 503, body: { detail: "AI-analysen är tillfälligt otillgänglig. (llm_upstream)" } };

        await expect(run()).rejects.toThrow(/tillfälligt otillgänglig/);
        expect(paths()).toEqual(["/api/v1/jobs/job-1/reanalyze"]);
    });

    it("kör om i molnet när jobbet finns (positiv kontroll)", async () => {
        routes["/jobs/job-1/reanalyze"] = { status: 200, body: { id: "job-1", analysis: { summary: "Moln" } } };

        const out = await run();

        expect(out).toEqual({ raw: { summary: "Moln" }, cloudJobGone: false });
        expect(paths()).toEqual(["/api/v1/jobs/job-1/reanalyze"]);
    });

    it.each([
        ["molnjobbet svarar 200 utan analys", { status: 200, body: { id: "job-1", analysis: null } }, true],
        ["molnjobbet svarar 200 med tom sammanfattning", { status: 200, body: { id: "job-1", analysis: { summary: "  ", key_decisions: [] } } }, true],
        ["/analyze svarar 200 utan sammanfattning", { status: 200, body: { key_decisions: ["B"] } }, false],
    ])("behandlar ett svar utan sammanfattning som misslyckat: %s", async (_namn, svar, moln) => {
        if (moln) routes["/jobs/job-1/reanalyze"] = svar as Route;
        else routes["/analyze"] = svar as Route;

        await expect(run({ cloudSync: moln as boolean })).rejects.toThrow(/ingen sammanfattning/);
    });

    it("går den stateless vägen direkt när molnsynk är av", async () => {
        const out = await run({ cloudSync: false });

        expect(out.cloudJobGone).toBe(false);
        expect(paths()).toEqual(["/api/v1/analyze"]);
    });
});

describe("forgetCloudJob", () => {
    it("gör inspelningen lokal igen och nollställer molnjobbet", async () => {
        vi.mocked(invoke).mockClear();

        expect(await forgetCloudJob(42)).toEqual({ sync_status: "local", cloud_job_id: null });
        expect(invoke).toHaveBeenCalledWith("update_recording_status", { id: 42, status: "local", cloudJobId: null });
    });

    it("ger null när databasen vägrar, så att activeJob inte ljuger om läget", async () => {
        vi.mocked(invoke).mockRejectedValueOnce(new Error("låst"));
        vi.spyOn(console, "error").mockImplementationOnce(() => {});

        expect(await forgetCloudJob(42)).toBeNull();
    });
});

describe("bestSavedText", () => {
    const local = [{ text: "lokal rad ett" }, { text: "lokal rad två" }];

    it("väljer molntranskriptet när det finns", () => {
        expect(bestSavedText({ cloud_transcript: "  Molnets text.  " }, local)).toBe("Molnets text.");
    });

    it("faller tillbaka på de lokala segmenten när molntext saknas eller är tom", () => {
        expect(bestSavedText({ cloud_transcript: null }, local)).toBe("lokal rad ett lokal rad två");
        expect(bestSavedText({ cloud_transcript: "   " }, local)).toBe("lokal rad ett lokal rad två");
        expect(bestSavedText(null, local)).toBe("lokal rad ett lokal rad två");
    });
});
