import { describe, it, expect } from "vitest";
import type { UISegment } from "@/store/transcription-store";
import {
    ChunkHttpError,
    MissingTokenError,
    MAX_CHUNK_ATTEMPTS,
    insertCloudSegment,
    isRetryableChunkError,
    retryDelayMs,
    stripOverlap,
} from "./cloud-chunks";

const seg = (start: number, speaker: string, text: string): UISegment => ({
    start_time: start, end_time: start + 4, timestamp: start * 1000, speaker, text,
});

describe("isRetryableChunkError", () => {
    it("gör om serverfel och timeout — 502 är backendens svar när Berget fallerar", () => {
        for (const s of [408, 500, 502, 503, 504]) {
            expect(isRetryableChunkError(new ChunkHttpError(`Chunk-transkribering misslyckades: x`, s))).toBe(true);
        }
    });
    it("gör om nätverksfel (fetch kastar utan status)", () => {
        expect(isRetryableChunkError(new TypeError("Failed to fetch"))).toBe(true);
    });
    it("gör inte om det som ger samma svar igen", () => {
        expect(isRetryableChunkError(new ChunkHttpError("Chunk-transkribering misslyckades: Tom ljud-chunk.", 400))).toBe(false);
        expect(isRetryableChunkError(new ChunkHttpError("Unauthorized: x", 401))).toBe(false);
        expect(isRetryableChunkError(new ChunkHttpError("Payment Required: x", 402))).toBe(false);
        expect(isRetryableChunkError(new ChunkHttpError("Chunk-transkribering misslyckades: för stor", 413))).toBe(false);
        expect(isRetryableChunkError(new ChunkHttpError("Quota: x", 429))).toBe(false);
        expect(isRetryableChunkError(new MissingTokenError())).toBe(false);
    });
});

describe("retryDelayMs", () => {
    it("ger fyra väntetider och sedan null — fem försök totalt", () => {
        const mid = () => 0.5;
        expect([0, 1, 2, 3, 4].map((a) => retryDelayMs(a, mid))).toEqual([500, 1500, 3500, 7000, null]);
        expect(MAX_CHUNK_ATTEMPTS).toBe(5);
    });
    it("håller jittern inom ±20 %", () => {
        expect(retryDelayMs(3, () => 0)).toBe(5600);
        expect(retryDelayMs(3, () => 0.999999)).toBe(8400);
    });
    it("täcker ett avbrott på några sekunder (2026-09-19): minst ~10 s väntan totalt", () => {
        const total = [0, 1, 2, 3].reduce((sum, a) => sum + (retryDelayMs(a, () => 0) ?? 0), 0);
        expect(total).toBeGreaterThanOrEqual(10_000);
    });
});

describe("stripOverlap", () => {
    it("trimmar ledande ord som dubblerar föregåendes slut", () => {
        expect(stripOverlap("vi ses på måndag", "på måndag klockan nio")).toBe("klockan nio");
    });
    it("rör inte ett ensamt gemensamt ord", () => {
        expect(stripOverlap("vi ses", "ses imorgon")).toBe("ses imorgon");
    });
});

describe("insertCloudSegment", () => {
    it("lägger en bit i ordning sist, och trimmar mot föregående med samma talare", () => {
        const out = insertCloudSegment([seg(0, "DU", "vi ses på måndag")], seg(4, "DU", "på måndag klockan nio"));
        expect(out?.map((s) => s.text)).toEqual(["vi ses på måndag", "klockan nio"]);
    });

    it("lägger en sen bit på sin plats i tid, inte sist", () => {
        const store = [seg(0, "DU", "ett"), seg(8, "DU", "tre")];
        const out = insertCloudSegment(store, seg(4, "DU", "två"));
        expect(out?.map((s) => s.start_time)).toEqual([0, 4, 8]);
    });

    it("trimmar NÄSTA bits lead-in när en försenad bit kommer in före den", () => {
        // Bit 8 kom först och bär lead-in:en "klockan nio" från bit 4, som kom sent.
        const store = [seg(0, "DU", "vi ses"), seg(8, "DU", "klockan nio tar vi kaffe")];
        const out = insertCloudSegment(store, seg(4, "DU", "på måndag klockan nio"));
        expect(out?.map((s) => s.text)).toEqual(["vi ses", "på måndag klockan nio", "tar vi kaffe"]);
    });

    it("trimmar bara mot samma talare", () => {
        const store = [seg(0, "MÖTET", "på måndag klockan")];
        const out = insertCloudSegment(store, seg(4, "DU", "på måndag klockan nio"));
        expect(out?.[1].text).toBe("på måndag klockan nio");
    });

    it("returnerar null när inget återstår efter trimningen", () => {
        expect(insertCloudSegment([seg(0, "DU", "vi ses på måndag")], seg(4, "DU", "på måndag"))).toBeNull();
    });

    it("raderar inte nästa bit även om all dess text vore dubblett", () => {
        const store = [seg(8, "DU", "klockan nio")];
        const out = insertCloudSegment(store, seg(4, "DU", "på måndag klockan nio"));
        expect(out?.map((s) => s.text)).toEqual(["på måndag klockan nio", "klockan nio"]);
    });

    it("muterar inte indata", () => {
        const store = [seg(0, "DU", "vi ses"), seg(8, "DU", "klockan nio tar vi kaffe")];
        const copy = JSON.parse(JSON.stringify(store));
        insertCloudSegment(store, seg(4, "DU", "på måndag klockan nio"));
        expect(store).toEqual(copy);
    });
});
