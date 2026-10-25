import { describe, it, expect, vi, beforeEach } from "vitest";

// Rust-kommandot och fetch mockas; storarna, rapportören och felmappningen är på riktigt.
// Testet mäter effekten: vilket kommando anropas, vilket fel kastas, vilket event fyras.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/hooks/use-posthog-events", () => ({ captureEvent: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { captureEvent } from "@/hooks/use-posthog-events";
import { uploadJob, errorSlug } from "./api";
import { useConfigStore } from "@/store/config-store";
import { useSettingsStore } from "@/store/settings-store";
import { MAX_UPLOAD_FILE_BYTES } from "./upload-limits";

const JOB = { id: "j1", filename: "session.opus", status: "COMPLETED", created_at: "", retention_policy: "24h" };

function sent(status: number, body: unknown, extra: Partial<Record<string, unknown>> = {}) {
    return {
        outcome: "sent", status, body: typeof body === "string" ? body : JSON.stringify(body),
        format: "opus", size_bytes: 9_000_000, duration_secs: 2400, channels: 2, opus_bitrate: 24_000, ...extra,
    };
}

const events = () => vi.mocked(captureEvent).mock.calls.filter(c => c[0] === "cloud_upload_outcome").map(c => c[1] as any);

beforeEach(() => {
    vi.mocked(invoke).mockReset();
    vi.mocked(captureEvent).mockReset();
    vi.unstubAllGlobals();
    useSettingsStore.setState({ backendUrl: "https://api.example.test" } as any);
    useConfigStore.setState({ maxCloudJobMinutes: 60, uploadPolicy: { opusBitratePerChannel: 24_000, onlyWhenNeeded: true, source: "server" } });
});

describe("uploadJob via Opus i Rust", () => {
    it("skickar sökväg, adress, tak och fält till Rust och returnerar jobbet", async () => {
        vi.mocked(invoke).mockResolvedValueOnce(sent(200, JOB));
        const job = await uploadJob("desktop_retranscribe", "C:/app/recordings/a.wav", "general", "tok", true, true, true, 3, 1);
        expect(job.id).toBe("j1");
        const [cmd, args] = vi.mocked(invoke).mock.calls[0] as [string, any];
        expect(cmd).toBe("upload_cloud_audio");
        expect(args.url).toBe("https://api.example.test/api/v1/jobs");
        expect(args.maxBytes).toBe(MAX_UPLOAD_FILE_BYTES);
        expect(args.maxMinutes).toBe(60);
        expect(args.opusBitratePerChannel).toBe(24_000);
        expect(args.wavWhenFits).toBe(true);
        expect(Object.fromEntries(args.fields)).toMatchObject({
            template_id: "general", perform_analysis: "true", persist: "true",
            diarize: "true", num_speakers: "3", mic_speakers: "1",
        });
        expect(events()).toEqual([expect.objectContaining({
            path: "desktop_retranscribe", outcome: "ok", format: "opus", channels: 2, duration_min: 40, http_status: 200,
            opus_bitrate: 24_000, policy_source: "server",
        })]);
    });

    it("för långt möte: sant fel, eget utfall, inget annat anrop", async () => {
        vi.mocked(invoke).mockResolvedValueOnce({ ...sent(0, ""), outcome: "blocked_duration", format: "wav", duration_secs: 3700 });
        const err = await uploadJob("desktop_autosync", "a.wav", "general", "tok").catch(e => e);
        expect(err.message).toBe("För långt: Mötet är 62 minuter. Molnet tar emot högst 60 minuter per möte.");
        expect(errorSlug(err)).toBe("file_too_large");
        expect(events().map(e => e.outcome)).toEqual(["blocked_duration"]);
        expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    });

    it("för stort även som Opus: storleksfelet", async () => {
        vi.mocked(invoke).mockResolvedValueOnce({ ...sent(0, ""), outcome: "blocked_size", size_bytes: 40 * 1024 * 1024 });
        const err = await uploadJob("desktop_sync_list", "a.wav", "general", "tok").catch(e => e);
        expect(err.message).toMatch(/^För stort: Filen är 40 MB/);
        expect(events().map(e => e.outcome)).toEqual(["blocked_size"]);
    });

    it("serverns 413 och 402 blir samma fel som förut", async () => {
        vi.mocked(invoke).mockResolvedValueOnce(sent(413, { detail: "Ljudet är för långt." }));
        await expect(uploadJob("desktop_autosync", "a.wav", "general", "tok")).rejects.toThrow("För stort: Ljudet är för långt.");
        vi.mocked(invoke).mockResolvedValueOnce(sent(402, { detail: "x" }));
        await expect(uploadJob("desktop_autosync", "a.wav", "general", "tok")).rejects.toThrow(/^Payment Required/);
        expect(events().map(e => [e.outcome, e.http_status])).toEqual([["blocked_size", 413], ["failed_server", 402]]);
    });

    it("serverns längdtak (413 För långt) visas utan dubbla prefix", async () => {
        vi.mocked(invoke).mockResolvedValueOnce(sent(413, { detail: "För långt: Mötet är 61 minuter. Molnet tar emot högst 60 minuter per möte." }));
        const err = await uploadJob("desktop_autosync", "a.wav", "general", "tok").catch(e => e);
        expect(err.message).toBe("För långt: Mötet är 61 minuter. Molnet tar emot högst 60 minuter per möte.");
        expect(errorSlug(err)).toBe("file_too_large");
    });

    it("inget svar från servern: nätverksfel och samma text som förut", async () => {
        vi.mocked(invoke).mockRejectedValueOnce("NETWORK: connection refused");
        await expect(uploadJob("desktop_autosync", "a.wav", "general", "tok")).rejects.toThrow(/^Kunde inte nå servern/);
        expect(events().map(e => e.outcome)).toEqual(["failed_network"]);
    });

    it("fil som inte kan kodas: WAV-vägen tar över, och bara ett event fyras", async () => {
        vi.mocked(invoke).mockImplementation(async (cmd: string) => {
            if (cmd === "upload_cloud_audio") throw "UNSUPPORTED: 44100 Hz";
            if (cmd === "read_audio_file") return [82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69]; // "RIFF....WAVE"
            throw new Error(cmd);
        });
        const fetchMock = vi.fn(async () => new Response(JSON.stringify(JOB), { status: 200 }));
        vi.stubGlobal("fetch", fetchMock);
        const job = await uploadJob("desktop_retranscribe", "a.wav", "general", "tok");
        expect(job.id).toBe("j1");
        expect(vi.mocked(invoke).mock.calls.map(c => c[0])).toEqual(["upload_cloud_audio", "read_audio_file"]);
        expect(fetchMock).toHaveBeenCalledWith("https://api.example.test/api/v1/jobs", expect.anything());
        expect(events()).toEqual([expect.objectContaining({ outcome: "ok", format: "wav" })]);
    });

    it("andra fel från Rust går inte till WAV-vägen", async () => {
        // Negativt prov: en reserv som tar över vid VARJE fel hade dolt ett trasigt kodsteg.
        vi.mocked(invoke).mockRejectedValueOnce("Åtkomst nekad: sökvägen ligger utanför appens datakatalog.");
        await expect(uploadJob("desktop_autosync", "a.wav", "general", "tok")).rejects.toThrow(/^Uppladdningen misslyckades: Åtkomst nekad/);
        expect(vi.mocked(invoke)).toHaveBeenCalledTimes(1);
    });
});

describe("serverns val når Rust", () => {
    it("alltid WAV: bitrate 0 skickas vidare och eventet säger wav och fallback-källa när den gäller", async () => {
        useConfigStore.setState({ uploadPolicy: { opusBitratePerChannel: 0, onlyWhenNeeded: true, source: "fallback" } });
        vi.mocked(invoke).mockResolvedValueOnce(sent(200, JOB, { format: "wav", opus_bitrate: 0 }));
        await uploadJob("desktop_autosync", "a.wav", "general", "tok");
        const [, args] = vi.mocked(invoke).mock.calls[0] as [string, any];
        expect(args.opusBitratePerChannel).toBe(0);
        expect(events()).toEqual([expect.objectContaining({ format: "wav", opus_bitrate: null, policy_source: "fallback" })]);
    });
});
