import { describe, expect, it, vi } from "vitest";
import { ChunkHttpError } from "./cloud-chunks";
import { processCloudChunk, type ChunkDeps, type CloudChunkEvent } from "./cloud-chunk-handler";

const chunk: CloudChunkEvent = { audio: [1, 2, 3], speaker: "DU", start: 12, duration: 4 };

function deps(overrides: Partial<ChunkDeps> = {}) {
    const d = {
        getToken: vi.fn(() => "token"),
        transcribe: vi.fn(async () => ({ text: "hej" })),
        isStale: vi.fn(() => false),
        sleep: vi.fn(async () => {}),
        apply: vi.fn(),
        capture: vi.fn(),
        onSuccess: vi.fn(),
        onFailure: vi.fn(),
        ...overrides,
    };
    return d;
}

describe("processCloudChunk", () => {
    it("ett fel vid infogningen ger exakt ett anrop mot servern", async () => {
        // 🔴 NEGATIVT TEST. Servern räknar varje lyckat anrop i kundens kvot. När
        // försöksslingan även
        // omslöt infogningen gav ett undantag där fyra omförsök av en bit som redan
        // transkriberats och debiterats: fem anrop totalt.
        const d = deps({ apply: vi.fn(() => { throw new TypeError("Cannot read properties of undefined"); }) });
        await processCloudChunk(chunk, d);
        expect(d.transcribe).toHaveBeenCalledTimes(1);
        expect(d.sleep).not.toHaveBeenCalled();
    });

    it("ett fel i analysanropet efter infogningen ger heller inget nytt anrop", async () => {
        const d = deps({ capture: vi.fn((event: string) => { if (event === "cloud_chunk_ok") throw new Error("posthog"); }) });
        await processCloudChunk(chunk, d);
        expect(d.transcribe).toHaveBeenCalledTimes(1);
        expect(d.apply).toHaveBeenCalledTimes(1);
    });

    it("nätverksfel görs om tills anropet lyckas, och segmentet läggs in en gång", async () => {
        const transcribe = vi.fn()
            .mockRejectedValueOnce(new TypeError("Failed to fetch"))
            .mockRejectedValueOnce(new ChunkHttpError("x", 502))
            .mockResolvedValue({ text: "hej" });
        const apply = vi.fn();
        const d = deps({ transcribe, apply });
        await processCloudChunk(chunk, d);
        expect(transcribe).toHaveBeenCalledTimes(3);
        expect(apply).toHaveBeenCalledTimes(1);
        expect(apply.mock.calls[0][0]).toMatchObject({ text: "hej", start_time: 12, end_time: 16, speaker: "DU" });
        expect(d.capture).toHaveBeenCalledWith("cloud_chunk_ok", { speaker: "DU", attempts: 3 });
    });

    it("kvot och Pro görs inte om", async () => {
        const d = deps({ transcribe: vi.fn(async () => { throw new ChunkHttpError("Quota: slut", 429); }) });
        await processCloudChunk(chunk, d);
        expect(d.transcribe).toHaveBeenCalledTimes(1);
        expect(d.onFailure).toHaveBeenCalledWith("Quota: slut");
    });

    it("en bit som blir inaktuell under anropet läggs inte in", async () => {
        const d = deps({ isStale: vi.fn(() => true) });
        await processCloudChunk(chunk, d);
        expect(d.apply).not.toHaveBeenCalled();
    });
});
