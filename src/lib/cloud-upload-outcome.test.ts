import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { cloudUploadOutcomeProps, onceReporter, outcomeForStatus, wavInfo } from "./cloud-upload-outcome";

/** WAV-huvud (44 byte) + `dataBytes` nollor. `declaredData` är storleken huvudet påstår. */
function wav(channels: number, sampleRate: number, dataBytes: number, declaredData = dataBytes): Uint8Array {
    const b = new Uint8Array(44 + dataBytes);
    const v = new DataView(b.buffer);
    const put = (i: number, s: string) => [...s].forEach((c, k) => (b[i + k] = c.charCodeAt(0)));
    put(0, "RIFF"); v.setUint32(4, 36 + declaredData, true); put(8, "WAVE");
    put(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, channels, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * channels * 2, true);
    v.setUint16(32, channels * 2, true); v.setUint16(34, 16, true);
    put(36, "data"); v.setUint32(40, declaredData, true);
    return b;
}

describe("wavInfo", () => {
    it("läser kanaler och längd ur en stereofil (sessionsfilens format)", () => {
        // 16 kHz, 16 bit, stereo = 64 000 byte per sekund; 3 s.
        expect(wavInfo(wav(2, 16000, 192000))).toEqual({ format: "wav", channels: 2, durationSec: 3 });
    });

    it("räknar längden ur filens storlek när huvudet har kvar platshållaren", () => {
        // Huvudet säger 0 byte data, filen har 2 s mono. En längd ur huvudet hade gett 0.
        expect(wavInfo(wav(1, 16000, 64000, 0)).durationSec).toBe(2);
    });

    it("hoppar över okända block före data", () => {
        const base = wav(1, 16000, 32000);
        const list = new Uint8Array(10); // "LIST" + storlek 1 (udda → en utfyllnadsbyte) + 1 + 1
        list.set([0x4c, 0x49, 0x53, 0x54, 1, 0, 0, 0, 0x41, 0]);
        const b = new Uint8Array(base.length + list.length);
        b.set(base.subarray(0, 36)); b.set(list, 36); b.set(base.subarray(36), 46);
        expect(wavInfo(b)).toEqual({ format: "wav", channels: 1, durationSec: 1 });
    });

    it("gissar inte för annat än WAV", () => {
        const ogg = new TextEncoder().encode("OggS\u0000\u0002rest-of-page-goes-here");
        expect(wavInfo(ogg)).toEqual({ format: "unknown", channels: null, durationSec: null });
        expect(wavInfo(new Uint8Array(0))).toEqual({ format: "unknown", channels: null, durationSec: null });
    });
});

describe("outcomeForStatus", () => {
    it("413 är storlekstaket, andra felsvar är serverfel", () => {
        expect(outcomeForStatus(200)).toBe("ok");
        expect(outcomeForStatus(413)).toBe("blocked_size");
        expect(outcomeForStatus(402)).toBe("failed_server");
        expect(outcomeForStatus(500)).toBe("failed_server");
    });
});

describe("cloud_upload_outcome", () => {
    const info = wavInfo(wav(2, 16000, 64000 * 600)); // 10 min stereo
    const base = { path: "desktop_retranscribe" as const, sizeBytes: 44 + 64000 * 600, info, plan: "pro" as const };

    it("bär storlek, längd, format, kanaler, plan och mekanism, men inget filnamn", () => {
        const p = cloudUploadOutcomeProps({ ...base, outcome: "blocked_size" });
        expect(p).toEqual({
            path: "desktop_retranscribe", outcome: "blocked_size", mechanism: "multipart",
            size_mb: 36.62, duration_min: 10, format: "wav", channels: 2, plan: "pro", http_status: null,
            opus_bitrate: null, policy_source: null,
        });
    });

    it("fyrar exakt ett event även när flera utgångar rapporterar", () => {
        const capture = vi.fn();
        const report = onceReporter(capture, base);
        report("blocked_size");
        report("failed_network");
        expect(capture).toHaveBeenCalledTimes(1);
        expect(capture).toHaveBeenCalledWith("cloud_upload_outcome", expect.objectContaining({
            path: "desktop_retranscribe", outcome: "blocked_size",
        }));
    });

    it("ett fel i mätningen fäller inte uppladdningen", () => {
        const report = onceReporter(() => { throw new Error("posthog"); }, base);
        expect(() => report("ok", 200)).not.toThrow();
    });
});

describe("varje uppladdningsväg säger var den startade", () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
    const read = (f: string) => readFileSync(path.join(root, f), "utf8");
    const calls = (src: string) => [...src.matchAll(/uploadJob\(\s*"([a-z_]+)"/g)].map(m => m[1]);

    it("de fyra anroparna anger rätt path", () => {
        expect(calls(read("components/dashboard/split-view.tsx")).sort()).toEqual(["desktop_autosync", "desktop_retranscribe"]);
        expect(calls(read("components/layout/control-bar.tsx"))).toEqual(["desktop_autosync"]);
        expect(calls(read("pages/recordings-page.tsx"))).toEqual(["desktop_sync_list"]);
    });

    it("mönstret hittar anrop: ingen anropare utan path i källan", () => {
        // Spärr mot en tom matchning: räkna alla uploadJob-anrop och jämför med de som har en path.
        for (const f of ["components/dashboard/split-view.tsx", "components/layout/control-bar.tsx", "pages/recordings-page.tsx"]) {
            const src = read(f);
            const all = [...src.matchAll(/await uploadJob\(/g)].length;
            expect(all).toBeGreaterThan(0);
            expect(calls(src)).toHaveLength(all);
        }
    });

    it("både uploadJob och talaridentifieringen vid Stopp rapporterar", () => {
        const api = read("lib/api.ts");
        expect(api).toMatch(/uploadReporter\(path, fileBytes\)/);
        expect(api).toMatch(/uploadReporter\("desktop_diarize_stop", fileBytes\)/);
        // Opus-vägen, WAV-vägen och talaridentifieringen vid Stopp.
        expect([...api.matchAll(/report\("blocked_size"\)/g)]).toHaveLength(3);
        expect(api).toMatch(/report\("blocked_duration"\)/);
    });
});
