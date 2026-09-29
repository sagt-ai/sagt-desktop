import { describe, it, expect, vi, beforeEach } from "vitest";

// Ärliga fel från analysen. Servern svarar
// `analysis: null` och `result.analysis_failed: true` när transkriptet blev klart men
// analysen inte. Tidigare blev `job.analysis || {}` en tom analys som sparades över den
// befintliga i den lokala databasen. Rust-kommandona mockas, storarna är riktiga.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@/hooks/use-posthog-events", () => ({ captureEvent: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { captureEvent } from "@/hooks/use-posthog-events";
import { analysisFromJob, applyInlineCloudResult } from "./cloud-sync";
import { useSyncStore, type AnalysisData } from "@/store/sync-store";
import { useTranscriptionStore } from "@/store/transcription-store";
import type { Job } from "./api";

const OLD: AnalysisData = { summary: "Den gamla analysen", decisions: ["Lansera"], actions: [], template_used: "general" };
const TEXT = "Vi bestämde att lansera i oktober.";

function job(over: Partial<Job> = {}): Job {
    return {
        id: "j1", filename: "a.wav", status: "COMPLETED", created_at: "", retention_policy: "24h",
        result: { text: TEXT, segments: [] },
        analysis: { summary: "Ny analys", key_decisions: ["B"], action_items: ["Å"], template_used: "general" },
        ...over,
    };
}

const failedJob = () => job({ analysis: null as unknown as Job["analysis"], result: { text: TEXT, segments: [], analysis_failed: true } });

const rustCommands = () => vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);
const events = () => vi.mocked(captureEvent).mock.calls.map(([name]) => name);

// Storarna persisterar till localStorage, som saknas i node; tysta bara zustands varning.
const consoleWarn = console.warn;
vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("[zustand persist middleware]")) return;
    consoleWarn(...args);
});

beforeEach(() => {
    vi.mocked(invoke).mockClear();
    vi.mocked(captureEvent).mockClear();
    vi.mocked(toast.error).mockClear();
    useTranscriptionStore.getState().setSegments([]);
    useSyncStore.getState().setAnalysisData(OLD);
    useSyncStore.getState().setActiveJob({ id: 42, analysis_json: JSON.stringify(OLD), speaker_map: null });
});

describe("analysisFromJob", () => {
    it("mappar en lyckad analys", () => {
        expect(analysisFromJob(job())).toEqual({ summary: "Ny analys", decisions: ["B"], actions: ["Å"], template_used: "general" });
    });

    it("ger null när servern flaggat att analysen misslyckades", () => {
        expect(analysisFromJob(failedJob())).toBeNull();
    });

    it("ger null när jobbet bara transkriberades (skip-markör utan sammanfattning)", () => {
        const skipped = job({ analysis: { status: "skipped", message: "Analys hoppades över av användaren." } as unknown as Job["analysis"] });
        expect(analysisFromJob(skipped)).toBeNull();
    });

    it("ger null när sammanfattningen är tom", () => {
        expect(analysisFromJob(job({ analysis: { summary: "  ", key_decisions: [], action_items: [] } }))).toBeNull();
    });

    it("ger null när jobbet saknar analys", () => {
        expect(analysisFromJob(job({ analysis: undefined }))).toBeNull();
    });
});

describe("applyInlineCloudResult", () => {
    it("skriver inte över den befintliga analysen när analysen misslyckades", async () => {
        await applyInlineCloudResult(failedJob(), 42);

        expect(rustCommands()).not.toContain("save_analysis_to_db");
        expect(useSyncStore.getState().analysisData).toEqual(OLD);
        expect(useSyncStore.getState().activeJob.analysis_json).toBe(JSON.stringify(OLD));
    });

    it("sparar ändå transkriptet", async () => {
        await applyInlineCloudResult(failedJob(), 42);

        expect(vi.mocked(invoke)).toHaveBeenCalledWith("save_cloud_transcript_to_db", { id: 42, transcript: TEXT });
        expect(useSyncStore.getState().activeJob.cloud_transcript).toBe(TEXT);
    });

    it("säger att analysen misslyckades, inte att den lyckades", async () => {
        await applyInlineCloudResult(failedJob(), 42);

        expect(events()).toEqual(["analysis_failed"]);
        expect(toast.error).toHaveBeenCalledTimes(1);
    });

    it("skriver inte över den befintliga analysen vid transkribering utan analys", async () => {
        const skipped = job({ analysis: { status: "skipped", message: "Analys hoppades över av användaren." } as unknown as Job["analysis"] });
        await applyInlineCloudResult(skipped, 42);

        expect(rustCommands()).not.toContain("save_analysis_to_db");
        expect(useSyncStore.getState().analysisData).toEqual(OLD);
        // Användaren bad inte om analys, så det är inget fel att berätta om.
        expect(events()).toEqual([]);
        expect(toast.error).not.toHaveBeenCalled();
    });

    it("sparar en lyckad analys (positiv kontroll)", async () => {
        await applyInlineCloudResult(job(), 42);

        expect(rustCommands()).toContain("save_analysis_to_db");
        expect(useSyncStore.getState().analysisData?.summary).toBe("Ny analys");
        expect(events()).toEqual([]);
    });
});
