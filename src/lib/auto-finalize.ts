// Post-stop-pipelinen för PRO live-molnströmning (STEG 4 + 5). Extraherad ur ControlBars
// history-updated-gren (som var stor) och anropad därifrån. Kör efter att moln-kön dränerats:
//
//   1. Persistera de strömmade segmenten (Du/Mötet) — texten är redan läsbar.
//   2. PARALLELLT (oberoende indata): auto-analys (§5) på texten + auto-diarisering (§4) som
//      delar MÖTET-kanalen i Talare 1/2/3 och namnger dem. Analysen läser bara `text`,
//      diariseringen bara `speaker` → ingen kapplöpning om samma fält, snabbast till "allt klart".
//      Är backendens kill switch av körs bara namngivningen, på Du/Mötet som de strömmades.
//      Live-loopen namnger var 90:e sekund, så ett kortare möte fick annars aldrig några namn.
//
// All automatik är GATEAD på molnläge + structured + Pro + online + respektive toggle, och
// diariseringen dessutom på backendens kill switch (config-store.diarizeEnabled). Aldrig
// i lokal-läge (integritetslöftet). Fel degraderar TYST till dagens Du/Mötet-läge — de manuella
// reparationsmenyerna ("Transkribera om med talarseparering" när kill switchen är på, "Namnge
// talare igen", "Starta analys") finns kvar i SplitView.
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "@/store/settings-store";
import { useSyncStore } from "@/store/sync-store";
import { useTranscriptionStore, UISegment } from "@/store/transcription-store";
import { useAuthStore } from "@/store/auth-store";
import { useConfigStore } from "@/store/config-store";
import { diarizeMeeting, reanalyzeTranscript } from "@/lib/api";
import { applyDiarizationTurns } from "@/lib/diarize-relabel";
import { autoIdentify, buildTurnsFromSegments, mergeSuggestions, parseSpeakerData, serializeSpeakerData, speakerKey } from "@/lib/speaker-naming";
import { stripUnstableSpeakerMapKeys } from "@/lib/cloud-sync";
import { captureEvent } from "@/hooks/use-posthog-events";
import { waitForCloudStreamIdle } from "@/hooks/use-cloud-stream";

interface StoppedRecording {
    id: number | null;
    file_path: string;
}

/** Serialisera UI-segment till Rust `update_recording_segments`-payloaden (DB-formen). */
function toDbSegments(segs: UISegment[]) {
    return segs.map(s => ({
        start_time: s.start_time,
        end_time: s.end_time,
        text: s.text,
        speaker: s.speaker,
    }));
}

/**
 * True om `recordingId` fortfarande är den session som visas. Pipelinen är långkörande
 * (drän + extraktion + diarisering kan ta tiotals sekunder på ett långt möte); under tiden
 * kan användaren ha startat en NY inspelning eller öppnat ett annat historikjobb. GLOBALA
 * store-skrivningar (setSegments/setAnalysisData/setActiveJob) får då INTE ske — annars
 * klottrar det gamla mötets resultat över den nya vyn (setSegments över live-segmenten →
 * korrupt transkript). DB-skrivningar är nycklade på `recording.id` och alltid säkra.
 */
function isViewingRecording(recordingId: number | null): boolean {
    const st = useSyncStore.getState();
    return !st.isRecording && st.activeJob?.id === recordingId;
}

/**
 * Gällande talarkarta för mötet. Medan det visas är activeJob sanningskällan: SplitView skriver
 * en namnändring dit och till DB i samma steg. Annars gäller värdet som fångades vid
 * finalize-start. Att läsa activeJob då vore fel, eftersom det kan vara ett annat möte.
 */
function latestSpeakerMapRaw(recordingId: number | null, captured: string | null): string | null {
    return isViewingRecording(recordingId)
        ? (useSyncStore.getState().activeJob?.speaker_map ?? null)
        : captured;
}

/**
 * Kör auto-analysen (§steg 5) på den strömmade texten. Egen felhantering: analysfel får
 * ALDRIG påverka diariseringen eller den redan persisterade texten. Tyst degradering.
 */
async function runAutoAnalysis(recordingId: number | null, segs: UISegment[], token: string): Promise<void> {
    try {
        captureEvent("analysis_requested", { source: "auto_stop" });
        const fullText = segs.map(s => s.text).join(" ");
        const raw = await reanalyzeTranscript(fullText, "general", token);
        // Publicera bara om detta möte fortfarande visas (annars klottrar vi den nya
        // sessionens analysvy). reset() vid ny inspelning har redan nollställt analysData.
        if (isViewingRecording(recordingId)) {
            useSyncStore.getState().setAnalysisData({
                summary: raw.summary || "",
                decisions: raw.key_decisions || [],
                actions: raw.action_items || [],
                template_used: raw.template_used || "general",
            });
        }
        captureEvent("analysis_completed", { source: "auto_stop" });
    } catch (e: any) {
        console.error("Auto-analys vid stopp misslyckades:", e);
        captureEvent("analysis_failed", { error: e?.message || "unknown", source: "auto_stop" });
    }
}

/**
 * Föreslå namn på talarna i `segs` och persistera. Två anropare vid stopp:
 *  - efter en lyckad diarisering, med `renumbered: true`: de nya MÖTET N-talarna. R4: strippa
 *    instabila (omnumrerbara) nycklar ur gällande map INNAN merge så gamla namn inte hänger
 *    kvar på fel omnumrerad röst.
 *  - när kill switchen stoppat diariseringen, med `renumbered: false`: Du/Mötet som de
 *    strömmades. Inget har numrerats om, så map:en används som den är. En strippning här
 *    hade kastat namn som användaren skrivit in under mötet.
 * Provenance bevaras i båda fallen (mergeSuggestions).
 */
async function autoNameSpeakers(
    recording: StoppedRecording,
    segs: UISegment[],
    baseSpeakerMapRaw: string | null,
    token: string,
    { renumbered }: { renumbered: boolean },
): Promise<void> {
    const hints = parseSpeakerData(latestSpeakerMapRaw(recording.id, baseSpeakerMapRaw)).participants;
    const suggested = await autoIdentify(segs, hints, token);

    // Merga mot FÄRSK state, som live-loopen: användaren kan ha döpt om en talare eller lagt
    // till en deltagare medan dräneringen, diariseringen och anropet pågick, och det ska vinna.
    const current = parseSpeakerData(latestSpeakerMapRaw(recording.id, baseSpeakerMapRaw));

    // R4: ta bort MÖTET N / DU N / TALARE N ur basen när diariseringen numrerat om dem.
    const baseMap = renumbered ? stripUnstableSpeakerMapKeys(current.map) : current.map;
    const baseAuto = current.auto.filter(k => k in baseMap);

    // Ingen namnhärledning → behåll basen (men persistera ändå en strippning nedan så en
    // tidigare namngiven, nu omnumrerad talare inte visar fel namn).
    const merged = suggested
        ? mergeSuggestions(baseMap, suggested, baseAuto)
        : { map: baseMap, autoKeys: baseAuto };

    // Ingen namnhärledning OCH inga instabila nycklar strippade → payloaden är identisk med
    // det redan sparade (stripping tar bara bort nycklar; lika längd ⇒ inget borttaget). Hoppa
    // persistensen så vi undviker en onödig DB-skrivning + activeJob-re-render.
    const nothingChanged =
        suggested == null &&
        Object.keys(baseMap).length === Object.keys(current.map).length;
    if (nothingChanged) return;

    const payload = serializeSpeakerData({
        map: merged.map,
        participants: current.participants,
        auto: merged.autoKeys,
    });
    if (recording.id != null) {
        await invoke("save_speaker_map_to_db", { id: recording.id, speakerMap: payload });
    }
    // Uppdatera activeJob så SplitView (post-stop läser activeJob.speaker_map) visar namnen —
    // men BARA om detta möte fortfarande visas. liveSpeakerMap rörs INTE (nollställd vid flush).
    if (isViewingRecording(recording.id)) {
        const latest = useSyncStore.getState().activeJob;
        useSyncStore.getState().setActiveJob(
            { ...latest, speaker_map: payload },
            useSyncStore.getState().activeJobFromHistory,
        );
    }
}

/**
 * Auto-diarisering vid stopp (§steg 4): extrahera MÖTET-kanalen i Rust → diarisera i molnet →
 * mappa turerna på de strömmade segmenten → persistera + namnge. Tyst degradering vid fel.
 */
async function runAutoDiarize(
    recording: StoppedRecording,
    segs: UISegment[],
    baseSpeakerMapRaw: string | null,
    token: string,
): Promise<void> {
    // Deklareras utanför try så finally alltid kan städa den extraherade mono-kopian (upp till
    // ~440 MB), oavsett om diariseringen lyckas, ger 0 turer eller kastar. Utan detta läcker
    // MÖTET-kopian till app_data/diarize_temp/ (utanför DB-gallringen) — lagring + integritet.
    let monoPath: string | null = null;
    try {
        monoPath = await invoke<string>("extract_meeting_channel", { path: recording.file_path });
        const turns = await diarizeMeeting(monoPath, token);
        if (!turns || turns.length === 0) return; // inget att applicera → behåll DU/MÖTET

        const relabeled = applyDiarizationTurns(segs, turns);

        // Persistera de omdöpta segmenten till DB (nyckel = recording.id → alltid säkert).
        if (recording.id != null) {
            await invoke("update_recording_segments", {
                recordingId: recording.id,
                segments: toDbSegments(relabeled),
            });
        }
        // Uppdatera live-vyn BARA om detta möte fortfarande visas — annars skulle vi klottra
        // en ny sessions live-segment (transcription-store är global och överlever flikbyte).
        if (isViewingRecording(recording.id)) {
            useTranscriptionStore.getState().setSegments(relabeled);
        }

        await autoNameSpeakers(recording, relabeled, baseSpeakerMapRaw, token, { renumbered: true });
    } catch (e: any) {
        console.warn("Auto-diarisering vid stopp misslyckades:", e?.message || e);
        captureEvent("diarization_failed", { reason: e?.message || "unknown", source: "auto_stop" });
        // behåll DU/MÖTET (dagens läge) — den manuella menyn finns kvar som reparation.
    } finally {
        // Best-effort radering. Rust vägrar sökvägar utanför diarize_temp och sväljer NotFound,
        // så detta är säkert även om filen redan städats av nästa extract_meeting_channel-körning.
        if (monoPath) {
            try {
                await invoke("delete_diarize_temp", { path: monoPath });
            } catch (e: any) {
                console.warn("Kunde inte radera diarize-temp-fil:", e?.message || e);
            }
        }
    }
}

/** True om auto-diarisering ska köras: kill switchen på + molnläge + structured + Pro + online +
 *  autoDiarize + ljudfil + minst ett MÖTET-segment att dela + token. */
function shouldAutoDiarize(isCloudMode: boolean, recording: StoppedRecording, segs: UISegment[], token: string | null): boolean {
    const s = useSettingsStore.getState();
    return (
        // Kill switchen måste stoppa oss här, före extraktionen. POST /diarize svarar visserligen
        // 503 när den är av, men först när hela MÖTET-kanalen (~110 MB/h) laddats upp.
        useConfigStore.getState().diarizeEnabled &&
        isCloudMode &&
        s.cloudDiarizationMode === "structured" &&
        s.autoDiarize &&
        useAuthStore.getState().isPro() &&
        navigator.onLine &&
        !!token &&
        recording.id != null &&
        !!recording.file_path &&
        segs.some(seg => speakerKey(String(seg.speaker ?? "")) === "MÖTET")
    );
}

/**
 * Namngivning vid stopp när kill switchen stoppat diariseringen. Live-loopen
 * (use-live-speaker-naming.ts) namnger var 90:e sekund, så utan detta fick en inspelning
 * kortare än 90 s aldrig några namn automatiskt. Samma anrop som efter en diarisering, på
 * Du/Mötet-segmenten som de strömmades. Tyst degradering vid fel, som live-loopen.
 */
async function runAutoNameWithoutDiarize(
    recording: StoppedRecording,
    segs: UISegment[],
    baseSpeakerMapRaw: string | null,
    token: string,
): Promise<void> {
    try {
        await autoNameSpeakers(recording, segs, baseSpeakerMapRaw, token, { renumbered: false });
    } catch (e: any) {
        console.warn("Namngivning vid stopp misslyckades:", e?.message || e);
    }
}

/** True om namngivningen ska köras utan diarisering: kill switchen av + live-loopens villkor
 *  (molnläge + structured + Pro + online) + token + inspelning + minst en talare vars namn
 *  saknas eller bara är auto-satt. */
function shouldAutoNameWithoutDiarize(
    isCloudMode: boolean,
    recording: StoppedRecording,
    segs: UISegment[],
    token: string | null,
    baseSpeakerMapRaw: string | null,
): boolean {
    const s = useSettingsStore.getState();
    if (
        useConfigStore.getState().diarizeEnabled ||
        !isCloudMode ||
        s.cloudDiarizationMode !== "structured" ||
        !useAuthStore.getState().isPro() ||
        !navigator.onLine ||
        !token ||
        recording.id == null
    ) return false;
    // Samma vila som live-loopen: har användaren redan namngett varje talare finns inget att
    // föreslå (mergeSuggestions rör aldrig ett användarsatt namn), så anropet kan sparas.
    const { map, auto } = parseSpeakerData(latestSpeakerMapRaw(recording.id, baseSpeakerMapRaw));
    const speakers = new Set(buildTurnsFromSegments(segs).map(t => t.speaker));
    return [...speakers].some(k => !(k in map) || auto.includes(k));
}

/**
 * Post-stop-pipelinen för en STRÖMMAD molnsession. Anropas av ControlBar i history-updated
 * när `cloudStreamingActive`. Persisterar strömmade segment, kör sedan analys + diarisering
 * (eller bara namngivning, när kill switchen är av) parallellt. Blockerar inte UI:t med
 * toaster — texten är redan läsbar; en diskret "Förfinar talare…"-indikator styrs via
 * isProcessing i anroparen.
 */
export async function finalizeStreamingSession(params: {
    recording: StoppedRecording;
    isCloudMode: boolean;
    token: string | null;
}): Promise<void> {
    const { recording, isCloudMode, token } = params;
    const tStore = useTranscriptionStore.getState();
    tStore.setIsProcessing(true);
    // Fånga talarmap-basen NU, medan activeJob garanterat är detta möte (satt + flushat i
    // history-updated före detta anrop). autoNameSpeakers faller tillbaka på detta värde när
    // activeJob har bytts av en ny session/historiköppning under diariseringen.
    const baseSpeakerMapRaw: string | null = useSyncStore.getState().activeJob?.speaker_map ?? null;
    try {
        // Vänta tills moln-kön dränerats så de sista chunkarna hinner in (analysen ska köra
        // på KOMPLETT text; eftersläpande chunks vid mötesslut tar ofta >8 s).
        await waitForCloudStreamIdle(60000);
        const segs = useTranscriptionStore.getState().segments;

        // Persistera de strömmade segmenten som baslinje (Du/Mötet-vy) INNAN diariseringen.
        // Detta är avsiktligt: om runAutoDiarize kastar eller aldrig hinner klart (t.ex. appen
        // stängs) finns texten redan i DB. På success-vägen skriver runAutoDiarize över med de
        // omdöpta segmenten — det andra skrivet är alltså inte redundant utan en förfining.
        if (recording.id != null && segs.length > 0) {
            await invoke("update_recording_segments", {
                recordingId: recording.id,
                segments: toDbSegments(segs),
            });
        }

        // Analys (§5) + diarisering (§4) parallellt — oberoende indata. allSettled: den ena
        // får misslyckas utan att stoppa den andra. Med kill switchen av tar namngivningen
        // diariseringens plats.
        const settings = useSettingsStore.getState();
        const tasks: Promise<void>[] = [];
        if (isCloudMode && settings.autoAnalyze && segs.length > 0 && token) {
            tasks.push(runAutoAnalysis(recording.id, segs, token));
        }
        if (shouldAutoDiarize(isCloudMode, recording, segs, token)) {
            tasks.push(runAutoDiarize(recording, segs, baseSpeakerMapRaw, token as string));
        } else if (shouldAutoNameWithoutDiarize(isCloudMode, recording, segs, token, baseSpeakerMapRaw)) {
            tasks.push(runAutoNameWithoutDiarize(recording, segs, baseSpeakerMapRaw, token as string));
        }
        if (tasks.length > 0) await Promise.allSettled(tasks);
    } catch (e: any) {
        console.error("Streaming post-stop finalize failed:", e);
    } finally {
        // Rensa "Bearbetar…"-indikatorn bara om detta möte fortfarande visas ELLER ingen ny
        // inspelning pågår — en ny session äger då flaggan själv (undviker att släcka dess spinner).
        if (!useSyncStore.getState().isRecording) {
            useTranscriptionStore.getState().setIsProcessing(false);
        }
    }
}
