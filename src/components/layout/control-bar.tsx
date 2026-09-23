import { Mic, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAudioAmplitude } from "@/hooks/use-audio-amplitude";
import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { toast } from "sonner";
// import { open } from "@tauri-apps/plugin-shell"; // Removed for In-App Analysis
import { useSettingsStore } from "@/store/settings-store";
// import { useRecordingStore } from "@/store/recording-store";
import { useAuthStore } from "@/store/auth-store";
import { uploadJob, errorSlug } from "@/lib/api";
import { applyInlineCloudResult } from "@/lib/cloud-sync";
import { serializeSpeakerData } from "@/lib/speaker-naming";
import { finalizeStreamingSession } from "@/lib/auto-finalize";
import { useSyncStore } from "@/store/sync-store";
import { useTranscriptionStore } from "@/store/transcription-store";
import { usePostHogEvents, showError, captureEvent } from "@/hooks/use-posthog-events";
import { resetCloudStream } from "@/hooks/use-cloud-stream";
import { transcriptOutcomeProps, type SessionDiagnostics } from "@/lib/session-diagnostics";

interface Recording {
    id: number | null;
    filename: string;
    file_path: string;
    duration_sec: number;
    created_at: string;
    sync_status: string;
    cloud_job_id: string | null;
    audio_deleted: boolean;
    /** Sätts av sessions-recordern i Rust. Saknas i payloads från andra vägar. */
    diagnostics?: SessionDiagnostics;
}

interface ControlBarProps {
    onViewChange?: (view: 'dashboard' | 'settings' | 'recordings') => void;
}

export function ControlBar({ onViewChange }: ControlBarProps) {
    const amplitude = useAudioAmplitude();
    const [elapsedSeconds, setElapsedSeconds] = useState(0);
    // Robust timer start time
    const [startTime, setStartTime] = useState<number | null>(null);

    // Cloud Sync State from Store
    const {
        setUploadStatus,
        setUploadProgress,
        setErrorMessage,
        setSession,
        setActiveJob,
        reset,
        isRecording, setIsRecording,
    } = useSyncStore();
    
    const getToken = useAuthStore((s) => s.getToken);
    const isPro = useAuthStore((s) => s.isPro());
    const isSignedIn = useAuthStore((s) => s.isSignedIn);
    const events = usePostHogEvents();


    // Timer Logic: Use Date.now() for accuracy
    useEffect(() => {
        let interval: NodeJS.Timeout;
        if (isRecording) {
            // Set start time if not set (or use ref to track actual start)
            const start = startTime || Date.now();
            if (!startTime) setStartTime(start);

            setElapsedSeconds(Math.floor((Date.now() - start) / 1000)); // Immediate update

            interval = setInterval(() => {
                const now = Date.now();
                setElapsedSeconds(Math.floor((now - start) / 1000));
            }, 500); // Check twice a second for responsiveness
        }
        return () => clearInterval(interval);
    }, [isRecording, startTime]);

    // Format Timer
    const formatTime = (seconds: number) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    };

    // Track duration in ref for the listener to access latest value
    const durationRef = useRef(0);
    useEffect(() => {
        durationRef.current = elapsedSeconds;
    }, [elapsedSeconds]);

    // Listen for History Update (Backend Save Complete)
    useEffect(() => {
        const unlistenPromise = listen<Recording>("history-updated", async (event) => {
            console.log("ControlBar: Received history-updated", event.payload);
            const recording = event.payload;

            // Guard: if a NEW recording has already started while this event was in-flight
            // (e.g. previous session's transcription finished late), don't show the archive banner.
            if (useSyncStore.getState().isRecording) {
                console.log("ControlBar: Ignoring history-updated — new recording already active");
                return;
            }

            if (recording.id && recording.file_path) {
                events.recordingStopped(durationRef.current);
                setSession(recording.file_path, recording.id.toString());
                setUploadStatus('idle');
                setActiveJob(recording);
                useTranscriptionStore.getState().setIsProcessing(false);

                // Flusha talarnamn/chips som fyllts i UNDER live (buffrade i store, ej i den nu
                // ev. avmonterade SplitView). Körs för BÅDE lokal och moln, FÖRE den cloud-
                // streaming-gren som return:ar nedan. Lokal transkribering sparar inspelningen
                // asynkront efter stopp — ofta efter att användaren bytt flik (SplitView avmonterad)
                // → SplitViews egen persistens hinner inte. ControlBar är alltid monterad.
                // STEG 2: map:en kommer från liveSpeakerMap (sanningskälla under live — hook + SplitView
                // skriver dit); participants från pendingSpeakerData; auto-provenance från liveAutoKeys
                // så en användarredigering överlever återöppning och skyddas mot framtida auto.
                {
                    const st = useSyncStore.getState();
                    const liveMap = st.liveSpeakerMap;
                    const participants = st.pendingSpeakerData?.participants ?? [];
                    if (Object.keys(liveMap).length > 0 || participants.length > 0) {
                        try {
                            const payload = serializeSpeakerData({ map: liveMap, participants, auto: st.liveAutoKeys });
                            await invoke("save_speaker_map_to_db", { id: recording.id, speakerMap: payload });
                            st.setPendingSpeakerData(null);
                            st.clearLiveSpeakerData();
                            const aj = useSyncStore.getState().activeJob;
                            if (aj && aj.id === recording.id) {
                                setActiveJob({ ...aj, speaker_map: payload }, useSyncStore.getState().activeJobFromHistory);
                            }
                        } catch (e) {
                            console.error("Failed to flush pending speaker_map:", e);
                        }
                    }
                }

                // transcription_completed (lokal/gratis): sista steget i free-aktiveringsfunneln.
                // history-updated fyrar när Rust sparat den lokalt transkriberade inspelningen
                // (whisper-cli, pending=0). PRO live-molnströmning har egna server-events
                // (transcription_chunk_completed/cloud_chunk_ok) och hanteras i grenen nedan —
                // fyra därför bara när vi INTE strömmar mot molnet, annars dubbelräknas sessionen.
                //
                // Storen fylls bara medan SplitView är monterad (use-transcription lyssnar
                // där). En inspelning gjord medan användaren stod i Inspelningar eller
                // Inställningar sparades med text men räknades då som tom, och en där vyn
                // byttes halvvägs fick för lågt ordantal. Därför räknas det Rust sparade
                // (`diagnostics`) när det finns, och storen bara som reserv.
                if (!useSyncStore.getState().cloudStreamingActive) {
                    const segs = useTranscriptionStore.getState().segments;
                    const d = recording.diagnostics;
                    if (d) {
                        if (d.segments_saved > 0) events.transcriptionCompleted(d.word_count);
                    } else if (segs.length > 0) {
                        const wordCount = segs.reduce((n, s) => n + s.text.split(" ").length, 0);
                        events.transcriptionCompleted(wordCount);
                    }
                    // Utfallet för varje lokal inspelning, med eller utan text, så att de
                    // tomma kan jämföras med de lyckade (nivåer, VAD, whisper).
                    if (d && !d.cloud_streaming) {
                        captureEvent('local_transcript_outcome', transcriptOutcomeProps(d, durationRef.current));
                    }
                }
                
                // --- AUTO-SYNC LOGIC ---
                // Trigger auto-sync if effective mode says we should use cloud, and we are Pro
                const currentEffectiveMode = useSyncStore.getState().effectiveMode;
                const isCloudMode = currentEffectiveMode === 'cloud_analysis' || currentEffectiveMode === 'cloud';

                // PRO live-molnströmning: texten kom redan succesivt från molnet (Du/Mötet/MOLN).
                // Ladda INTE upp hela filen igen — det skulle skriva över de strömmade segmenten
                // med ett enda MOLN-stycke OCH kosta 2×. Post-stop-pipelinen (auto-finalize.ts)
                // persisterar de strömmade segmenten och kör sedan auto-analys (§5) + auto-
                // diarisering (§4) parallellt. Tyst degradering; texten är redan läsbar.
                if (useSyncStore.getState().cloudStreamingActive) {
                    setUploadStatus('idle');
                    await finalizeStreamingSession({
                        recording: { id: recording.id, file_path: recording.file_path },
                        isCloudMode,
                        token: getToken(),
                    });
                    return;
                }

                if (isCloudMode && isPro) {
                    try {
                        const token = getToken();
                        if (!token) {
                            toast.error("Autosynk misslyckades: Kunde inte hämta autentiseringstoken.");
                            return;
                        }

                        events.cloudSyncStarted();
                        setUploadStatus('uploading');
                        setErrorMessage(null);

                        // We use autoAnalyzeCloud from settings since we preserved it for backwards compat,
                        // or we could just check currentEffectiveMode === 'cloud_analysis'.
                        // Using explicit check for clarity.
                        const shouldAnalyze = currentEffectiveMode === 'cloud_analysis';
                        
                        toast.success(`Påbörjar automatisk uppladdning (${shouldAnalyze ? 'med analys' : 'endast transkribering'})...`);

                        const job = await uploadJob(recording.file_path, "general", token, shouldAnalyze);
                        setUploadStatus('success');

                        if (useSettingsStore.getState().cloudSync) {
                            // Synk PÅ → persisterat moln-jobb: markera synkat + polla (visas i dashboard)
                            await invoke("update_recording_status", {
                                id: recording.id,
                                status: 'uploaded',
                                cloudJobId: job.id,
                            });
                            await emit("recording-synced");
                            setActiveJob({ ...recording, sync_status: 'uploaded', cloud_job_id: job.id });
                            useSyncStore.getState().setUploadedJobId(job.id);
                            useSyncStore.getState().setProcessingStatus("PROCESSING");
                            toast.success(shouldAnalyze
                                ? "Inspelningen är uppladdad! Analyserar i molnet..."
                                : "Inspelningen är uppladdad! Transkriberar med KB-Whisper Large...");
                        } else {
                            // Synk AV (default, privacy-first) → resultatet kom inline, inget sparas i molnet
                            const wc = await applyInlineCloudResult(job, recording.id);
                            events.cloudSyncCompleted(wc);
                            toast.success("Transkriberad med KB-Whisper Large (resultat endast lokalt).");
                        }

                    } catch (error: any) {
                        console.error("Auto-sync failed:", error);
                        events.cloudSyncFailed(error?.message || 'unknown');
                        setUploadStatus('error');
                        setErrorMessage(error.message || "Ett okänt fel inträffade vid autosynk.");
                        showError(errorSlug(error), "Autosynk misslyckades: " + (error?.message || error?.toString() || "Okänt fel"), { action: 'cloud_sync' });
                    }
                } else if (isCloudMode && !isPro && isSignedIn) {
                    toast.warning("Molnläge kräver Pro. Inspelningen sparades lokalt.");
                }
            }
        });

        return () => { unlistenPromise.then(f => f()); };
    }, [setSession, setUploadStatus, setActiveJob, setUploadProgress, setErrorMessage, getToken, isPro]);

    // Ett lokalt segment som blev klart efter att inspelningen sparats. Texten syntes
    // live men finns inte i den sparade inspelningen. Ska vara noll.
    useEffect(() => {
        const unlistenPromise = listen("transcription-after-save", () => {
            captureEvent('local_segment_after_save');
        });
        return () => { unlistenPromise.then(f => f()); };
    }, []);

    const toggleRecording = async () => {
        try {
            if (isRecording) {
                // STOP RECORDING
                // Backend handles saving now.
                // We just stop and wait for event.
                await invoke("stop_recording");
                setIsRecording(false);
                useTranscriptionStore.getState().setIsProcessing(true); // Show Finalizing state
                setStartTime(null);

                // Note: We don't setSession here anymore. 
                // We wait for 'history-updated' event which contains the DB ID.

            } else {
                // START RECORDING
                // Avgör PRO live-molnströmning och informera Rust FÖRE inspelning startar.
                // streaming=true → Rust skickar VAD-segment till molnet (ingen lokal small).
                // Offline eller icke-Pro → false → lokal small-fallback (offline-first).
                const cfg = useSettingsStore.getState();
                const cloudMode = cfg.recordingMode === 'cloud' || cfg.recordingMode === 'cloud_analysis';
                const streaming = isPro && navigator.onLine && cloudMode;
                const merge = cfg.cloudDiarizationMode === 'merged';
                // Ny session: nollställ moln-köns avbrotts-/felstatus från föregående session.
                resetCloudStream();
                try {
                    await invoke("set_cloud_mode", { cloudStreaming: streaming, mergeChannels: merge });
                } catch (e) {
                    console.error("set_cloud_mode failed:", e);
                }
                useSyncStore.getState().setCloudStreamingActive(streaming);

                await invoke("start_recording");
                events.recordingStarted();

                /**
                 * clearSegments() is intentionally called AFTER start_recording.
                 * Calling it before caused stale Tauri transcription-chunk events
                 * (buffered from the previous session) to repopulate segments before
                 * the new session cleared them. By clearing after the Rust side has
                 * started, any in-flight events from the old session are discarded.
                 */
                useTranscriptionStore.getState().clearSegments();

                setStartTime(Date.now());
                setIsRecording(true);
                setElapsedSeconds(0);
                setActiveJob(null);
                setSession(null, null);
                reset(); // Clears uploadedJobId, processingStatus, analysisData, uploadStatus
                useSyncStore.getState().setPendingSpeakerData(null); // nollställ talar-buffert för ny session
                useSyncStore.getState().clearLiveSpeakerData(); // nollställ live-namn + auto-provenance
            }
        } catch (error: any) {
            console.error("Failed to toggle recording:", error);
            setIsRecording(false);
            setStartTime(null);
            showError(errorSlug(error), "Transkriberingsfel: " + (error?.message || error?.toString() || "Okänt fel"), { action: 'transcription' });
        }
    };

    return (
        <div className="h-24 border-t bg-white flex items-center justify-between px-8 relative z-30 shadow-[0_-4px_6px_-1px_rgba(0,0,0,0.05)]">
            <div className="text-sm font-medium text-muted-foreground flex flex-col min-w-[120px]">
                {/*
                  * `key` tvingar React att BYTA UT noden i stället för att mutera dess
                  * text. Utan den smetade "Spelar in..." ovanpå "Redo" på macOS: WebKit
                  * befordrar ett element med en oändlig CSS-animation (`animate-pulse`)
                  * till ett eget kompositlager, och när textnoden inuti ett sådant lager
                  * byts ut invalideras inte alltid den gamla glyfraden. Resultatet blir
                  * två texter ovanpå varandra — vilket ser ut som ett layoutfel men inte
                  * kan vara det, eftersom det bara finns ETT element.
                  *
                  * Uppmätt att det INTE är ett överlapp: vid 1040 px fönsterbredd slutar
                  * den här kolumnen på 152 px och inspelningsknappen börjar på 232 px.
                  */}
                <span
                    key={isRecording ? "recording" : "idle"}
                    className={`font-semibold transition-colors ${isRecording ? "text-red-500 animate-pulse" : "text-ink-muted"}`}
                >
                    {isRecording ? "Spelar in..." : "Redo"}
                </span>
                <span className="text-xs text-muted-foreground/60 font-mono">{formatTime(elapsedSeconds)}</span>
            </div>

            {/* AI Control removed and migrated to SplitView */}
            <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2" style={{ left: 'calc(50vw - 16rem)' }}>
                <div className="relative">
                    <Button
                        size="icon"
                        onClick={toggleRecording}
                        className={`relative h-16 w-16 rounded-full shadow-xl transition-all duration-300 hover:scale-105 active:scale-95 ${isRecording
                            ? "bg-red-600 hover:bg-red-700 border-4 border-white ring-4 ring-red-100"
                            : "bg-green-500/15 hover:bg-green-500/25 border-2 border-green-400/60"
                            }`}
                    >
                        <Mic className={`h-6 w-6 transition-colors duration-300 ${isRecording ? "text-white" : "text-green-600"}`} />
                    </Button>
                </div>
            </div>

            <div className="flex items-center gap-4">
                {/* Audio Visualizers */}
                <div className="flex gap-2 items-end h-8">
                    <div className="flex flex-col items-center gap-1">
                        <div className="w-1.5 h-6 bg-paper-dim rounded-full overflow-hidden relative">
                            <div
                                className={`absolute bottom-0 w-full ${isRecording ? 'bg-brand' : 'bg-line'} transition-all duration-75 ease-out rounded-full`}
                                style={{ height: isRecording ? `${Math.min(amplitude.mic * 500, 100)}%` : '0%' }}
                            />
                        </div>
                        <span className="text-[10px] text-ink-muted font-mono uppercase">Mic</span>
                    </div>
                    <div className="flex flex-col items-center gap-1">
                        <div className="w-1.5 h-6 bg-paper-dim rounded-full overflow-hidden relative">
                            <div
                                className={`absolute bottom-0 w-full ${isRecording ? 'bg-verified' : 'bg-line'} transition-all duration-75 ease-out rounded-full`}
                                style={{ height: isRecording ? `${Math.min(amplitude.system * 500, 100)}%` : '0%' }}
                            />
                        </div>
                        <span className="text-[10px] text-ink-muted font-mono uppercase">Sys</span>
                    </div>
                </div>

                <div onClick={() => { events.settingsOpened(); onViewChange?.('settings'); }} className="flex items-center gap-2 text-xs bg-paper-dim px-3 py-1.5 rounded-full border border-line text-ink-soft hover:bg-line cursor-pointer transition-colors">
                    <Settings2 className="w-3 h-3" />
                    Systemljud + Mic
                </div>
            </div>
        </div>
    );
}
