import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Rust-kommandona och nätanropen mockas, allt annat är på riktigt (storarna, grindarna,
// pipelinen). Testet mäter effekten: extraheras MÖTET-kanalen och laddas den upp till
// /diarize, eller inte?
vi.mock("@tauri-apps/api/core", () => ({
    invoke: vi.fn(async (cmd: string) =>
        cmd === "extract_meeting_channel" ? "/appdata/diarize_temp/meeting.wav" : undefined),
}));
vi.mock("@/lib/api", () => ({
    diarizeMeeting: vi.fn(async () => []),
    reanalyzeTranscript: vi.fn(async () => ({
        summary: "", key_decisions: [], action_items: [], template_used: "general",
    })),
    // Laddas dynamiskt av autoIdentify (speaker-naming.ts) och får då samma mock.
    identifySpeakers: vi.fn(async () => ({ speaker_map: { DU: "Daniel", MÖTET: "Anna" }, confidence: {} })),
}));
vi.mock("@/hooks/use-posthog-events", () => ({ captureEvent: vi.fn() }));
vi.mock("@/hooks/use-cloud-stream", () => ({ waitForCloudStreamIdle: vi.fn(async () => {}) }));

import { invoke } from "@tauri-apps/api/core";
import { diarizeMeeting, identifySpeakers, reanalyzeTranscript } from "@/lib/api";
import { finalizeStreamingSession } from "./auto-finalize";
import { useConfigStore } from "@/store/config-store";
import { useSettingsStore } from "@/store/settings-store";
import { useAuthStore } from "@/store/auth-store";
import { useSyncStore } from "@/store/sync-store";
import { useTranscriptionStore, type UISegment } from "@/store/transcription-store";

const RECORDING = { id: 42, file_path: "/recordings/42.wav" };

function seg(start: number, speaker: string, text: string): UISegment {
    return { start_time: start, end_time: start + 2, text, speaker, timestamp: start };
}

const rustCommands = () => vi.mocked(invoke).mock.calls.map(([cmd]) => cmd);

/** Talarnamnen som sparades i DB (save_speaker_map_to_db), eller null om inget sparades. */
function savedSpeakerData(): { map: Record<string, string>; participants: string[]; auto: string[] } | null {
    const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "save_speaker_map_to_db");
    return call ? JSON.parse((call[1] as { speakerMap: string }).speakerMap) : null;
}

/** Talarna i turerna som skickades till /identify-speakers, i anropsordning. */
const identifiedSpeakers = () =>
    vi.mocked(identifySpeakers).mock.calls.map(([turns]) => turns.map(t => t.speaker));

const speakerMap = (map: Record<string, string>, auto: string[] = []) =>
    JSON.stringify({ map, participants: [], auto });

const stop = (over: Partial<Parameters<typeof finalizeStreamingSession>[0]> = {}) =>
    finalizeStreamingSession({ recording: RECORDING, isCloudMode: true, token: "token", ...over });

// Storarna persisterar till localStorage, som saknas i node. zustand faller då tillbaka på
// minnet och varnar vid varje skrivning. Övriga varningar, som pipelinens egna, släpps igenom.
const consoleWarn = console.warn;
vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("[zustand persist middleware]")) return;
    consoleWarn(...args);
});

beforeEach(() => {
    vi.clearAllMocks();
    // Node 22 har en navigator, men utan onLine. Utan stubben säger shouldAutoDiarize nej
    // på grund av navigator.onLine, och testerna nedan som väntar sig nej går igenom oavsett
    // kill switchen. Den positiva kontrollen fäller i så fall.
    vi.stubGlobal("navigator", { onLine: true });
    // Pro i molnläge, Du/Mötet, auto-diarisering på och ett MÖTET-segment att dela: allt
    // utom kill switchen talar för diarisering, så det är den som avgör utfallet.
    useConfigStore.setState(useConfigStore.getInitialState(), true);
    useSettingsStore.setState({ cloudDiarizationMode: "structured", autoDiarize: true, autoAnalyze: false });
    useAuthStore.setState({ stripeStatus: "active" });
    useSyncStore.setState({ isRecording: false, activeJob: { id: RECORDING.id, speaker_map: null }, activeJobFromHistory: false });
    useTranscriptionStore.setState({ segments: [seg(0, "DU", "Hej allihop."), seg(2, "MÖTET", "Hej, vi börjar.")] });
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("auto-diariseringen vid stopp", () => {
    // Positiv kontroll. Samma uppsättning som testerna nedan, med kill switchen på: bevisar
    // att det är kill switchen, och inget annat villkor, som stoppar dem.
    it("extraherar och laddar upp MÖTET-kanalen när kill switchen är på", async () => {
        useConfigStore.getState().setDiarizeEnabled(true);
        await stop();
        expect(rustCommands()).toContain("extract_meeting_channel");
        expect(diarizeMeeting).toHaveBeenCalledWith("/appdata/diarize_temp/meeting.wav", "token");
        expect(rustCommands()).toContain("delete_diarize_temp");
    });

    it("extraherar och laddar inte upp något när kill switchen är av", async () => {
        useConfigStore.getState().setDiarizeEnabled(false);
        await stop();
        expect(rustCommands()).not.toContain("extract_meeting_channel");
        expect(diarizeMeeting).not.toHaveBeenCalled();
        // Resten av pipelinen körde: de strömmade segmenten sparades som vanligt.
        expect(rustCommands()).toContain("update_recording_segments");
    });

    it("är av innan någon config hämtats, till exempel efter en start offline", async () => {
        expect(useConfigStore.getInitialState().diarizeEnabled).toBe(false);
        await stop();
        expect(rustCommands()).not.toContain("extract_meeting_channel");
        expect(diarizeMeeting).not.toHaveBeenCalled();
    });

    it("stoppar inte auto-analysen", async () => {
        useSettingsStore.setState({ autoAnalyze: true });
        await stop();
        expect(reanalyzeTranscript).toHaveBeenCalledTimes(1);
        expect(diarizeMeeting).not.toHaveBeenCalled();
    });
});

describe("namngivningen vid stopp när kill switchen är av", () => {
    // Positiv kontroll för grinden. Startvärdet i beforeEach är kill switchen av, Pro, molnläge,
    // Du/Mötet och online, och ingen talare har namn än: allt talar för namngivning.
    it("namnger Du/Mötet och sparar namnen", async () => {
        await stop();
        expect(identifiedSpeakers()).toEqual([["DU", "MÖTET"]]);
        expect(savedSpeakerData()).toEqual({
            map: { DU: "Daniel", MÖTET: "Anna" }, participants: [], auto: ["DU", "MÖTET"],
        });
        // activeJob får namnen direkt. SplitView speglar dem därifrån efter ett livestopp.
        expect(JSON.parse(useSyncStore.getState().activeJob.speaker_map).map)
            .toEqual({ DU: "Daniel", MÖTET: "Anna" });
    });

    // Ett fall per villkor i grinden, var och ett med övriga villkor uppfyllda.
    it.each<[string, () => Parameters<typeof stop>[0]]>([
        ["utan Pro", () => { useAuthStore.setState({ stripeStatus: null }); return {}; }],
        ["offline", () => { vi.stubGlobal("navigator", { onLine: false }); return {}; }],
        ["i läget Sammanhängande", () => { useSettingsStore.setState({ cloudDiarizationMode: "merged" }); return {}; }],
        ["i lokalt läge", () => ({ isCloudMode: false })],
        ["utan token", () => ({ token: null })],
        ["utan inspelnings-id", () => ({ recording: { ...RECORDING, id: null } })],
    ])("namnger inte %s", async (_, arrange) => {
        await stop(arrange());
        expect(identifySpeakers).not.toHaveBeenCalled();
        expect(savedSpeakerData()).toBeNull();
    });

    // Namngivningen vid stopp gäller när kill switchen är av. Är den på men diariseringen
    // avstängd av användaren (manuellt läge) är beteendet oförändrat.
    it("namnger inte när kill switchen är på och diariseringen är manuell", async () => {
        useConfigStore.getState().setDiarizeEnabled(true);
        useSettingsStore.setState({ autoDiarize: false });
        await stop();
        expect(identifySpeakers).not.toHaveBeenCalled();
    });

    it("namnger inte en gång till när kill switchen är på: diariseringen namnger själv", async () => {
        useConfigStore.getState().setDiarizeEnabled(true);
        vi.mocked(diarizeMeeting).mockResolvedValueOnce([
            { start: 2, end: 4, speaker: "MÖTET 1", channel: "right" },
        ]);
        await stop();
        // Ett enda anrop, på de omdöpta segmenten från diariseringen.
        expect(identifiedSpeakers()).toEqual([["DU", "MÖTET 1"]]);
    });

    it("sparar anropet när användaren redan namngett alla talare", async () => {
        useSyncStore.setState({ activeJob: { id: RECORDING.id, speaker_map: speakerMap({ DU: "Jag", MÖTET: "Kunden" }) } });
        await stop();
        expect(identifySpeakers).not.toHaveBeenCalled();
    });

    it("förfinar ett namn som live-loopen satt", async () => {
        useSyncStore.setState({
            activeJob: { id: RECORDING.id, speaker_map: speakerMap({ DU: "Jag", MÖTET: "Någon" }, ["MÖTET"]) },
        });
        await stop();
        expect(savedSpeakerData()?.map).toEqual({ DU: "Jag", MÖTET: "Anna" });
    });

    it("behåller namn som användaren skrivit in, även på numrerade talare", async () => {
        // Utan diarisering har inget numrerats om. Strippningen som följer på en diarisering
        // (R4) hade kastat användarens "Bo" på MÖTET 1.
        useTranscriptionStore.setState({
            segments: [seg(0, "DU", "Hej allihop."), seg(2, "MÖTET 1", "Bo här."), seg(4, "MÖTET 2", "Och Cilla.")],
        });
        useSyncStore.setState({ activeJob: { id: RECORDING.id, speaker_map: speakerMap({ "MÖTET 1": "Bo" }) } });
        vi.mocked(identifySpeakers).mockResolvedValueOnce({
            speaker_map: { DU: "Daniel", "MÖTET 1": "Bosse", "MÖTET 2": "Cilla" }, confidence: {},
        });
        await stop();
        expect(savedSpeakerData()?.map).toEqual({ "MÖTET 1": "Bo", DU: "Daniel", "MÖTET 2": "Cilla" });
    });

    // SplitView sparar en namnändring till DB och activeJob i samma steg (persistSpeakerData).
    // Förslagen ska slås ihop med den, inte med kartan som fångades vid stopp.
    it("en namnändring medan anropet pågår vinner", async () => {
        vi.mocked(identifySpeakers).mockImplementationOnce(async () => {
            const aj = useSyncStore.getState().activeJob;
            useSyncStore.setState({ activeJob: { ...aj, speaker_map: speakerMap({ MÖTET: "Kunden" }, []) } });
            return { speaker_map: { DU: "Daniel", MÖTET: "Anna" }, confidence: {} };
        });
        await stop();
        expect(savedSpeakerData()?.map).toEqual({ MÖTET: "Kunden", DU: "Daniel" });
        expect(JSON.parse(useSyncStore.getState().activeJob.speaker_map).map).toEqual({ MÖTET: "Kunden", DU: "Daniel" });
    });

    it("rör inte ett annat möte som öppnats medan anropet pågår", async () => {
        const other = { id: 7, speaker_map: speakerMap({ MÖTET: "Någon annan" }) };
        vi.mocked(identifySpeakers).mockImplementationOnce(async () => {
            useSyncStore.setState({ activeJob: other, activeJobFromHistory: true });
            return { speaker_map: { DU: "Daniel", MÖTET: "Anna" }, confidence: {} };
        });
        await stop();
        // Mötet som stoppades får sina namn, på kartan från stoppet.
        const call = vi.mocked(invoke).mock.calls.find(([cmd]) => cmd === "save_speaker_map_to_db");
        expect(call?.[1]).toMatchObject({ id: RECORDING.id });
        expect(savedSpeakerData()?.map).toEqual({ DU: "Daniel", MÖTET: "Anna" });
        // Det andra mötet, som nu visas, är orört.
        expect(useSyncStore.getState().activeJob).toBe(other);
    });

    it("ett fel i namngivningen stoppar inte analysen", async () => {
        useSettingsStore.setState({ autoAnalyze: true });
        vi.mocked(identifySpeakers).mockRejectedValueOnce(new Error("Talaridentifiering misslyckades"));
        await stop();
        expect(reanalyzeTranscript).toHaveBeenCalledTimes(1);
        expect(savedSpeakerData()).toBeNull();
        expect(useTranscriptionStore.getState().isProcessing).toBe(false);
    });
});
