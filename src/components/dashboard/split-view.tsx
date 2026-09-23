// Removed ScrollArea import
import { Card } from "@/components/ui/card";
import { FileText, Sparkles, History, Loader2, Copy, RefreshCw, Play, Cloud, Check, LogOut, Lock, Users, X } from "lucide-react";
import { useTranscription } from "@/hooks/use-transcription";
import { cancelCloudStream } from "@/hooks/use-cloud-stream";
import { useSyncStore } from "@/store/sync-store";
import { useSettingsStore } from "@/store/settings-store";
import { useTranscriptionStore, UISegment } from "@/store/transcription-store";
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { getJob, reanalyzeTranscript, reanalyzeJob, uploadJob, identifySpeakers, SpeakerTurn, Job, errorSlug } from "@/lib/api";
import { applyInlineCloudResult, cloudSegmentsJsonFromJob, segmentsHaveDiarizationLabels, invalidateStaleSpeakerMap, stripUnstableSpeakerMapKeys } from "@/lib/cloud-sync";
import { speakerKey, mergeSuggestions, parseSpeakerData, serializeSpeakerData } from "@/lib/speaker-naming";
import { AnalysisData } from "@/store/sync-store";
import { useAuthStore, WAS_PRO_KEY } from "@/store/auth-store";
import { useConfigStore } from "@/store/config-store";
import { toast } from "sonner";
import { ModePill } from "./mode-pill";
import { UpsellModal } from "./upsell-modal";
import type { UpsellSource } from "@/lib/upsell-state";
import { usePostHogEvents, showError, captureEvent } from "@/hooks/use-posthog-events";
import { useSlowLocalHint } from "@/hooks/use-slow-local-hint";

/**
 * Enda statusindikatorn under pågående inspelning. Visas centrerad medan panelen är tom
 * och glider sedan ned under texten när första segmentet landar — samma element hela
 * vägen, så tillståndet aldrig byter visuellt språk mitt i inspelningen.
 *
 * Den säger medvetet INTE om transkriberingen sker lokalt eller i molnet: det ägs av
 * ModePill i headern. Tidigare stod läget på tre ställen samtidigt.
 */
function ListeningIndicator() {
    return (
        <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
            </span>
            <span className="text-xs text-ink-muted">Lyssnar…</span>
        </div>
    );
}

export function SplitView() {
    const isSignedIn = useAuthStore((s) => s.isSignedIn);
    const getToken = useAuthStore((s) => s.getToken);
    const isPro = useAuthStore((s) => s.isPro());
    // Backendens kill switch för talarseparering. Av → "Transkribera om med talarseparering"
    // döljs, eftersom servern släpper `diarize` utan felsvar och valet vore en tyst no-op.
    const diarizeEnabled = useConfigStore((s) => s.diarizeEnabled);
    const email = useAuthStore((s) => s.email);
    const clearSession = useAuthStore((s) => s.clearSession);
    const events = usePostHogEvents();
    const [showUpsellModal, setShowUpsellModal] = useState(false);
    // Varifrån modalen senast öppnades. Sätts i samma händelse som showUpsellModal, så
    // modalen ser rätt källa redan vid öppningen (React batchar de två uppdateringarna).
    const [upsellSource, setUpsellSource] = useState<UpsellSource>('locked_panel');
    const openUpsell = (source: UpsellSource) => {
        setUpsellSource(source);
        setShowUpsellModal(true);
    };
    const [showUserMenu, setShowUserMenu] = useState(false);
    const userMenuRef = useRef<HTMLDivElement>(null);

    // Close user menu on click outside
    useEffect(() => {
        if (!showUserMenu) return;
        const handleClick = (e: MouseEvent) => {
            if (userMenuRef.current && !userMenuRef.current.contains(e.target as Node)) {
                setShowUserMenu(false);
            }
        };
        document.addEventListener("mousedown", handleClick);
        return () => document.removeEventListener("mousedown", handleClick);
    }, [showUserMenu]);

    // Derive initials from email
    const initials = email
        ? email.split("@")[0].slice(0, 2).toUpperCase()
        : "?";

    useEffect(() => {
        if (isSignedIn && !isPro) {
            events.upsellShown('ai_insights_panel');
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isSignedIn, isPro]);

    const { segments: rawSegments, isProcessing } = useTranscription();
    const scrollRef = useRef<HTMLDivElement>(null);

    // Polling Logic for In-App Data
    const {
        uploadedJobId, setUploadedJobId, analysisData, setAnalysisData, processingStatus, setProcessingStatus,
        activeJob, activeJobFromHistory, setActiveJob, resetToLive, reset,
        setTemplateId, setUploadStatus, currentSessionPath, currentSessionId, setErrorMessage, isRecording,
        effectiveMode, cloudStreamingActive, liveSpeakerMap, liveAutoKeys
    } = useSyncStore();
    // Access store actions to populate segments for archive view
    const { setSegments, clearSegments } = useTranscriptionStore();
    const { recordingMode, pauseBreakMs, autoAnalyze } = useSettingsStore();

    // "Lokalt"-indikatorn ska bara visas som ÄKTA fallback — när molnet var avsett (Pro valde
    // moln) men inte är aktivt (offline) — aldrig när användaren medvetet valt lokalt läge.
    // Och endast medan inspelning pågår, så den inte ligger kvar efteråt.
    const cloudIntended = recordingMode === 'cloud' || recordingMode === 'cloud_analysis';
    const showLocalFallbackBadge = cloudIntended && !cloudStreamingActive && isRecording;

    // Pro-hint vid långsam lokal transkribering: samma villkor som slutför-
    // indikatorn i JSX:en nedan, begränsat till icke-Pro utan aktiv moln-ström.
    // ≥ 15 s sammanhängande väntan → inline-kort (use-slow-local-hint).
    // !isPro täcker även utloggad (stripeStatus null ⇒ false). WAS_PRO_KEY
    // skyddar betalande kund vars JWT gått ut offline — loadPersisted wipear
    // hela auth-sessionen vid expiry, men "köp Pro" ska aldrig visas för
    // någon som redan betalar.
    const isFinalizingLocal = isProcessing && !isRecording && processingStatus !== 'PROCESSING';
    const { showSlowHint, dismissSlowHint } = useSlowLocalHint(
        isFinalizingLocal && !isPro && !cloudStreamingActive
        && !localStorage.getItem(WAS_PRO_KEY)
    );

    // Per-modell-vy: en inspelning kan ha BÅDE lokala segment (Du/Mötet) och ett
    // molnresultat (KB-Whisper Large i cloud_transcript). Resultaten skriver aldrig
    // över varandra — användaren växlar vy och ser skillnaden mellan modellerna.
    const [transcriptView, setTranscriptView] = useState<'local' | 'cloud'>('local');
    const cloudTranscript: string | null = activeJob?.cloud_transcript?.trim() || null;

    // Fas 1c: strukturerade molnsegment (DU/MÖTET-turer från stereo-omtranskribering).
    // När de finns renderar molnvyn äkta turer i stället för den flata textblobben — och
    // Fas 1:s namnsättning ("Identifiera talare") fungerar då även på molnresultatet.
    // Faller tillbaka till flat blob (cloud_transcript) för mono/gamla inspelningar.
    const cloudStructured = useMemo((): UISegment[] => {
        const raw: string | undefined = activeJob?.cloud_segments;
        if (!raw) return [];
        try {
            const parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return [];
            return parsed
                .filter((s: any) => String(s?.text ?? "").trim())
                .map((s: any, i: number) => ({
                    id: -(i + 1),
                    start_time: s.start_time ?? 0,
                    end_time: s.end_time ?? 0,
                    text: String(s.text).trim(),
                    speaker: s.speaker || "MÖTET",
                    timestamp: 0,
                }));
        } catch {
            return [];
        }
    }, [activeJob?.cloud_segments]);

    const hasCloudResult = !!cloudTranscript || cloudStructured.length > 0;
    const hasModelToggle = hasCloudResult && rawSegments.length > 0;

    // Derive displayed segments synchronously so the first render after a tab switch
    // already shows the cloud result — no flash of stale local segments.
    const segments = useMemo((): UISegment[] => {
        // Molnvyn: strukturerade turer om de finns, annars flat MOLN-blob (gamla/mono).
        const cloudSeg = (): UISegment[] => {
            if (cloudStructured.length > 0) return cloudStructured;
            if (cloudTranscript) return [{
                id: -1,
                start_time: 0,
                end_time: 0,
                text: cloudTranscript,
                speaker: "MOLN" as const,
                timestamp: 0,
            }];
            return [];
        };
        if (hasModelToggle && transcriptView === 'cloud') return cloudSeg();
        if (rawSegments.length > 0) {
            // Molnchunks kan slutföras i annan ordning än de talades — sortera på start_time.
            return [...rawSegments].sort((a, b) => (a.start_time || 0) - (b.start_time || 0));
        }
        if (hasCloudResult) return cloudSeg();
        return [];
    }, [cloudTranscript, cloudStructured, hasCloudResult, hasModelToggle, transcriptView, rawSegments]);

    // Visa molnresultatet som standard när det finns (bästa modellen) — både vid
    // återöppning från historiken och när en omtranskribering/auto-synk blir klar.
    // Manuell växling påverkas inte (deps ändras bara när molnresultatet byts).
    useEffect(() => {
        setTranscriptView((activeJob?.cloud_transcript || activeJob?.cloud_segments) ? 'cloud' : 'local');
    }, [activeJob?.id, activeJob?.cloud_transcript, activeJob?.cloud_segments]);

    // Sammanhängande-läge: alla segment är "MOLN" → rendera som ETT flöde med styckesbryt
    // vid pauser (gap mellan segment ≥ pauseBreakMs). Pausbryt härleds ur Rusts VAD-timing.
    const isMerged = segments.length > 0 && segments.every(s => s.speaker === "MOLN");
    const mergedParagraphs = useMemo((): string[] => {
        if (!isMerged) return [];
        const paras: string[] = [];
        let cur = "";
        let prevEnd: number | null = null;
        for (const s of segments) {
            const t = s.text.trim();
            if (!t) continue;
            if (prevEnd != null && (s.start_time - prevEnd) * 1000 >= pauseBreakMs) {
                if (cur) paras.push(cur);
                cur = t;
            } else {
                cur = cur ? `${cur} ${t}` : t;
            }
            prevEnd = s.end_time || s.start_time;
        }
        if (cur) paras.push(cur);
        return paras;
    }, [isMerged, segments, pauseBreakMs]);

    // Talaridentifiering (Fas 1): namnmappning (kanonisk etikett → namn) + deltagarlista.
    // Icke-förstörande — segmenten rörs aldrig, namnen appliceras ovanpå Du/Mötet i vyn.
    const [speakerMap, setSpeakerMap] = useState<Record<string, string>>({});
    const [participants, setParticipants] = useState<string[]>([]);
    // STEG 2: provenance — vilka nycklar som satts av auto-namngivning (ej av användaren).
    // Persisteras i speaker_map-payloaden (`auto`) och styr mergeSuggestions så en
    // användarredigering aldrig skrivs över av en senare auto-körning.
    const [autoKeys, setAutoKeys] = useState<string[]>([]);
    const [editingTurnIndex, setEditingTurnIndex] = useState<number | null>(null);
    const [editingName, setEditingName] = useState("");
    const [newParticipant, setNewParticipant] = useState("");
    const [isIdentifying, setIsIdentifying] = useState(false);

    // §13.1: refs så auto-namngivningen (som körs efter en diarisering) läser FÄRSK map +
    // deltagarlista även från den stale polling-effekt-closuren (dess deps utelämnar dessa
    // avsiktligt). Utan detta skulle auto-kedjan merga ovanpå ett inaktuellt map.
    const speakerMapRef = useRef(speakerMap);
    const participantsRef = useRef(participants);
    const autoKeysRef = useRef(autoKeys);
    useEffect(() => { speakerMapRef.current = speakerMap; }, [speakerMap]);
    useEffect(() => { participantsRef.current = participants; }, [participants]);
    useEffect(() => { autoKeysRef.current = autoKeys; }, [autoKeys]);
    // §13.3: in-flight-guard för slå-ihop (popovern stängs synkront, men skyddar mot
    // blixtsnabb återöppning + nytt merge medan första invoken är i luften).
    const mergingRef = useRef(false);

    // Kanonisk etikett (mic/DU → "DU", sys/MÖTET → "MÖTET") importeras från speaker-naming.ts
    // — delad med hook + libbet så de två varianterna aldrig splittras.
    const defaultLabel = (sp: string) => {
        const k = speakerKey(sp);
        if (k === "DU") return "Du";
        if (k === "MÖTET") return "Mötet";
        // Fas 2: numrerade diariserings-etiketter → svensk titelform (TALARE 1 → "Talare 1").
        const m = k.match(/^(DU|MÖTET|TALARE)\s+(\d+)$/);
        if (m) {
            const base = m[1] === "TALARE" ? "Talare" : m[1] === "DU" ? "Du" : "Mötet";
            return `${base} ${m[2]}`;
        }
        return sp;
    };

    // Fas 2: deterministisk färg per talare (kanonisk nyckel) så flera röster särskiljs visuellt.
    // Full literala Tailwind-klasser (JIT måste se dem). Nyckeln — inte råetiketten — så DU/mic
    // och MÖTET/sys hamnar på samma färg.
    const SPEAKER_COLORS = [
        "text-blue-600 dark:text-blue-400",
        "text-emerald-600 dark:text-emerald-400",
        "text-amber-600 dark:text-amber-400",
        "text-violet-600 dark:text-violet-400",
        "text-rose-600 dark:text-rose-400",
        "text-cyan-600 dark:text-cyan-400",
    ];
    const speakerColor = (sp: string) => {
        const key = speakerKey(sp);
        let h = 0;
        for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
        return SPEAKER_COLORS[h % SPEAKER_COLORS.length];
    };

    // #9: gruppera på varandra följande segment med SAMMA talare till en "tur" (som mockupen
    // på startsidan): fet "Mötet:"/"Du:" inline + text, ny tur bara vid talarbyte eller paus.
    // Namnet hämtas ur speakerMap (kanonisk nyckel), annars Du/Mötet-default.
    const speakerLabel = (sp: string) => speakerMap[speakerKey(sp)] || defaultLabel(sp);
    const turns = useMemo(() => {
        const out: { speaker: string; text: string; start_time: number; end_time: number }[] = [];
        for (const s of segments) {
            if (s.text.includes('<|nospeech|>')) continue;
            const t = s.text.trim();
            if (!t) continue;
            const last = out[out.length - 1];
            const gap = last ? (s.start_time - last.end_time) * 1000 : 0;
            if (last && last.speaker === s.speaker && gap < pauseBreakMs) {
                last.text += " " + t;
                last.end_time = s.end_time || s.start_time;
            } else {
                out.push({ speaker: s.speaker, text: t, start_time: s.start_time, end_time: s.end_time || s.start_time });
            }
        }
        return out;
    }, [segments, pauseBreakMs]);

    // Det finns talaretiketter att namnsätta (Du/Mötet/Talare-N) — inte sammanhängande
    // molntext (MOLN, ett enda flöde utan talare). Styr chips-raden + "Identifiera talare".
    const hasNamableSpeakers = !isMerged && turns.some(t => t.speaker !== "MOLN");

    // Kopiera EXAKT det som visas i vyn: samma turer (gruppering per talare) som renderas,
    // inte ett prefix per råsegment/mening. Merged-läget kopierar styckena.
    const buildCopyText = (): string => {
        if (isMerged) return mergedParagraphs.join("\n\n");
        return turns
            .map(turn => {
                const label = turn.speaker === "MOLN" ? "" : speakerLabel(turn.speaker);
                return label ? `${label}: ${turn.text}` : turn.text;
            })
            .join("\n\n");
    };

    useEffect(() => {
        if (scrollRef.current) {
            const scrollContainer = scrollRef.current.closest('[data-radix-scroll-area-viewport]');
            if (scrollContainer) {
                const { scrollTop, scrollHeight, clientHeight } = scrollContainer;
                if (scrollHeight - scrollTop - clientHeight < 150) {
                    scrollRef.current.scrollIntoView({ behavior: "smooth" });
                }
            } else {
                scrollRef.current.scrollIntoView({ behavior: "smooth" });
            }
        }
    }, [segments, isProcessing]);

    // Re-analyze state
    const [isReanalyzing, setIsReanalyzing] = useState(false);
    const [isRetranscribing, setIsRetranscribing] = useState(false);
    const [copiedKey, setCopiedKey] = useState<string | null>(null);

    const handleCopy = (text: string, key: string, e: React.MouseEvent<HTMLButtonElement>) => {
        if (!text) return;
        navigator.clipboard.writeText(text);
        e.currentTarget.blur();
        setCopiedKey(key);
        events.transcriptCopied();
        setTimeout(() => setCopiedKey(null), 2000);
    };

    const handleCancel = async () => {
        setIsReanalyzing(false);
        setUploadStatus('idle');
        setUploadedJobId(null);
        // #11: töm moln-kön också — annars fortsätter buffrade chunks att POSTas och text dimpa in.
        cancelCloudStream();
        useTranscriptionStore.getState().setIsProcessing(false);
        try {
            // Kill the active whisper-cli child process in Rust
            await invoke('cancel_transcription');
        } catch (e) {
            console.error("Failed to kill transcription process:", e);
        }
        try {
            await invoke("stop_recording");
        } catch (e) {
            console.error("Failed to stop backend recording:", e);
        }
    };

    // §13.2: `diarize` skickas explicit från dropdown-valen (inte via async toggle-state) → immun
    // mot att en state-uppdatering inte hunnit landa vid klick.
    const handleRetranscribe = async (diarize: boolean = false) => {
        if (!isSignedIn || !isPro) { openUpsell('retranscribe'); return; }
        if (!navigator.onLine) { toast.error("Denna funktion kräver internetanslutning."); return; }
        if (activeJob?.audio_deleted) {
            toast.error("Ljudfilen är raderad — molntranskribering kräver ljudet. Transkript och analys finns kvar.");
            return;
        }

        const uploadPath = activeJob?.file_path || currentSessionPath;
        if (!uploadPath) {
            toast.error("Inspelningsfil saknas. Spela in igen och försök.");
            return;
        }

        const token = getToken();
        if (!token) { toast.error("Kunde inte hämta autentiseringstoken. Logga in igen."); return; }

        setIsRetranscribing(true);
        setUploadStatus('uploading');
        try {
            const job = await uploadJob(
                uploadPath, "general", token, true, undefined,
                diarize,
                diarize && participants.length > 0 ? participants.length : undefined,
                // §13.4: hint om att mikrofonkanalen (DU) bara har en talare → hindrar
                // Du 1/Du 2-översegmentering. Skickas bara vid diarisering; backend
                // applicerar den enbart på stereo-vägens DU-kanal (mono ignorerar).
                diarize && useSettingsStore.getState().micIsSingleSpeaker ? 1 : undefined,
            );
            setUploadStatus('success');
            if (useSettingsStore.getState().cloudSync) {
                setUploadedJobId(job.id);
                setProcessingStatus("PROCESSING");
                toast.success("Transkriberar med KB-Whisper Large...");
            } else {
                const dbId = activeJob?.id ?? (currentSessionId ? parseInt(currentSessionId) : null);
                const wc = await applyInlineCloudResult(job, dbId);
                // R4: applyInlineCloudResult invaliderade speaker_map i DB/activeJob vid ny
                // diarisering — spegla det i in-memory-staten (load-effekten refreshar bara
                // history-jobb, så live-vägen måste strippas här också). Gate på det FAKTISKA
                // resultatet (samma villkor som DB-invalideringen) — inte på valet — så DB
                // och minne aldrig divergerar om kill switch är av och inga etiketter kom.
                const hadDiar = segmentsHaveDiarizationLabels(cloudSegmentsJsonFromJob(job));
                let baseMap = speakerMapRef.current;
                let baseAuto = autoKeysRef.current;
                if (hadDiar) {
                    baseMap = stripUnstableSpeakerMapKeys(baseMap);
                    // Auto-provenance för bortstrippade (omnumrerade) nycklar är också inaktuell → filtrera.
                    baseAuto = baseAuto.filter(k => k in baseMap);
                    setSpeakerMap(baseMap);
                    setAutoKeys(baseAuto);
                }
                events.cloudSyncCompleted(wc);
                setTranscriptView('cloud'); // visa det nya molnresultatet direkt
                toast.success("Transkriberad med KB-Whisper Large (resultat endast lokalt).");
                // §13.1: auto-kedja namngivningen (tyst) direkt efter en diarisering → namn dyker
                // upp av sig själv när cues finns; annars står "Talare N" kvar. Pro/online-guard
                // ligger i runIdentify. Turer byggs ur det FÄRSKA jobbet (inte den stale `turns`-memon).
                if (hadDiar) {
                    await runIdentify(turnsFromJob(job), participantsRef.current, baseMap, baseAuto, { silent: true });
                }
            }
        } catch (error: any) {
            setUploadStatus('error');
            setUploadedJobId(null);
            if (error?.message?.startsWith("Unauthorized")) {
                clearSession();
                showError('unauthorized', "Din session är inte längre giltig. Logga in igen.", { action: 'retranscribe' });
            } else {
                showError(errorSlug(error), "Uppladdning misslyckades: " + (error?.message || error?.toString() || "Okänt fel"), { action: 'retranscribe' });
            }
        } finally {
            setIsRetranscribing(false);
        }
    };

    // Ladda persisterad namnmappning + deltagarlista. SPARAD inspelning (öppnad från historik):
    // läs recordings.speaker_map. Live→sparad (fromHistory=false) hanteras INTE här — ControlBar
    // flushar den live-buffrade datan (pendingSpeakerData i store) vid history-updated, eftersom
    // SplitView kan vara avmonterad när lokal transkribering sparar inspelningen efter stopp.
    useEffect(() => {
        if (!activeJob) { setSpeakerMap({}); setParticipants([]); setAutoKeys([]); return; }
        if (!useSyncStore.getState().activeJobFromHistory) return;
        const raw = activeJob.speaker_map;
        if (!raw) { setSpeakerMap({}); setParticipants([]); setAutoKeys([]); return; }
        const parsed = parseSpeakerData(raw);
        setSpeakerMap(parsed.map);
        setParticipants(parsed.participants);
        setAutoKeys(parsed.auto);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeJob?.id, activeJob?.speaker_map]);

    // Efter ett livestopp (inte historik) läser effekten ovan inte om speaker_map. Namn som
    // auto-finalize sparar vid stopp syntes därför först när mötet öppnades igen, och ett
    // flikbyte tömde vyns namn. Spegla dem hit. null betyder att inget sparats för mötet än:
    // vyn behåller då namnen från inspelningen i stället för att tömmas.
    useEffect(() => {
        if (isRecording || activeJobFromHistory) return;
        const raw = activeJob?.speaker_map;
        if (!raw) return;
        const parsed = parseSpeakerData(raw);
        setSpeakerMap(parsed.map);
        setParticipants(parsed.participants);
        setAutoKeys(parsed.auto);
    }, [isRecording, activeJobFromHistory, activeJob?.speaker_map]);

    // STEG 2: under LIVE (inspelning pågår, ej ett historik-jobb) speglar SplitView store:ns
    // liveSpeakerMap/liveAutoKeys — den alltid-monterade hook:en skriver namn dit och de dyker
    // upp i vyn löpande. Gaten på isRecording: när inspelningen stoppar fryses den lokala
    // staten som den är (flushen persisterar liveSpeakerMap till DB och nollställer live-fälten,
    // så utan gaten skulle namnen försvinna ur vyn vid stopp).
    useEffect(() => {
        if (!isRecording || activeJobFromHistory) return;
        setSpeakerMap(liveSpeakerMap);
        setAutoKeys(liveAutoKeys);
    }, [isRecording, activeJobFromHistory, liveSpeakerMap, liveAutoKeys]);

    // Persistera namnmappning + deltagarlista. SPARAD inspelning (id finns) → skriv direkt till
    // recordings.speaker_map. LIVE (inget id än) → buffra i global store; ControlBar flushar den
    // vid history-updated (alltid monterad → fungerar även när SplitView avmonterats vid flikbyte,
    // vilket händer i lokalt läge där inspelningen sparas asynkront efter stopp).
    const persistSpeakerData = async (map: Record<string, string>, parts: string[], auto: string[] = autoKeysRef.current) => {
        const id = activeJob?.id ?? (currentSessionId ? parseInt(currentSessionId) : null);
        if (!id) {
            // LIVE: liveSpeakerMap/liveAutoKeys är sanningskällan (hook läser + flushen persisterar);
            // participants buffras i pendingSpeakerData (flushen läser deltagarlistan därifrån).
            const sync = useSyncStore.getState();
            sync.setLiveSpeakerMap(map);
            sync.setLiveAutoKeys(auto);
            sync.setPendingSpeakerData({ map, participants: parts });
            return;
        }
        const payload = serializeSpeakerData({ map, participants: parts, auto });
        try {
            // camelCase: Rust-param speaker_map → speakerMap i JS-invoke (annars None tyst).
            await invoke("save_speaker_map_to_db", { id, speakerMap: payload });
            useSyncStore.getState().setPendingSpeakerData(null);
            const aj = useSyncStore.getState().activeJob;
            // Bevara fromHistory-flaggan (annars tappas historik-bannern vid namnbyte).
            if (aj && aj.id === id) setActiveJob({ ...aj, speaker_map: payload }, useSyncStore.getState().activeJobFromHistory);
        } catch (e) {
            console.error("Failed to persist speaker map:", e);
        }
    };

    const openRename = (turnIndex: number, sp: string) => {
        const k = speakerKey(sp);
        // "Du" förifyller fältet med e-postens lokaldel (auth-store har bara e-post) — ett
        // förslag som bekräftas med Enter, inte ett auto-applicerat namn.
        const prefill = speakerMap[k] || (k === "DU" && email ? email.split("@")[0] : "");
        setEditingName(prefill);
        setEditingTurnIndex(turnIndex);
    };

    const cancelRename = () => {
        setEditingTurnIndex(null);
        setEditingName("");
    };

    const commitRename = (sp: string) => {
        const k = speakerKey(sp);
        const name = editingName.trim();
        const next = { ...speakerMap };
        if (name) next[k] = name; else delete next[k];
        setSpeakerMap(next);
        // Användaren vinner: nyckeln blir användarsatt → bort ur auto-provenance så en
        // framtida auto-körning aldrig skriver över den (mergeSuggestions-invarianten).
        const nextAuto = autoKeys.filter(x => x !== k);
        setAutoKeys(nextAuto);
        persistSpeakerData(next, participants, nextAuto);
        cancelRename();
    };

    // §13.3: slå-ihop gäller bara diariserade molnturer (cloud_segments) — det är där
    // översegmentering (Du 1/Du 2) uppstår. Lokala live-segment (rena DU/MÖTET) berörs ej.
    const mergeableView = cloudStructured.length > 0 && (!hasModelToggle || transcriptView === 'cloud');

    // §13.3: slå ihop talare `fromSp` → `toKey`: relabela cloud_segments (kanoniska nycklar,
    // målets RÅETIKETT bevaras) + persistera DB→activeJob→speaker_map i den ordningen så
    // persistSpeakerData:s färska getState-läsning ser de nya segmenten (store↔DB-synk, R4).
    // Irreversibelt per design — en ny "Transkribera om med talarseparering" återskapar etiketterna.
    const mergeSpeakers = async (fromSp: string, toKey: string) => {
        const fromKey = speakerKey(fromSp);
        // Stäng popovern SYNKRONT före async-arbetet — annars kan ett andra chip-klick i samma
        // popover köra mot samma stale closure och tyst skriva över det första merget.
        cancelRename();
        if (fromKey === toKey) return;
        if (mergingRef.current) return; // blixtsnabb återöppning under pågående merge
        mergingRef.current = true;
        try {
            const rawJson = activeJob?.cloud_segments;
            const id = activeJob?.id ?? (currentSessionId ? parseInt(currentSessionId) : null);
            if (!rawJson || id == null) { toast.error("Ihopslagning kräver ett sparat molnresultat."); return; }
            let arr: any[];
            try { arr = JSON.parse(rawJson); } catch { toast.error("Kunde inte läsa talarturerna."); return; }
            if (!Array.isArray(arr)) { toast.error("Kunde inte läsa talarturerna."); return; }
            // Målets råetikett (första förekomsten) — skriv den, inte den kanoniska nyckeln, så
            // formatet i cloud_segments förblir vad backend producerade.
            const toRaw = arr.find(s => speakerKey(String(s?.speaker ?? "")) === toKey)?.speaker ?? toKey;
            const nextArr = arr.map(s =>
                speakerKey(String(s?.speaker ?? "")) === fromKey ? { ...s, speaker: toRaw } : s
            );
            const nextJson = JSON.stringify(nextArr);
            try {
                await invoke("save_cloud_segments_to_db", { id, cloudSegments: nextJson });
            } catch (e) {
                console.error("Kunde inte spara ihopslagning:", e);
                toast.error("Kunde inte spara ihopslagningen.");
                return;
            }
            // Färsk state + bevara fromHistory (samma mönster som persistSpeakerData).
            const aj = useSyncStore.getState().activeJob;
            if (aj && aj.id === id) {
                setActiveJob({ ...aj, cloud_segments: nextJson }, useSyncStore.getState().activeJobFromHistory);
            }
            // speaker_map: källans post bort; målet ärver namnet bara om det själv saknar ett.
            const nextMap = { ...speakerMap };
            const fromName = nextMap[fromKey];
            delete nextMap[fromKey];
            if (fromName && !nextMap[toKey]) nextMap[toKey] = fromName;
            setSpeakerMap(nextMap);
            // Ihopslagning är ett medvetet användarval → både käll- och målnyckel blir användarsatta
            // (bort ur auto-provenance) så auto-loopen inte återuppväcker den sammanslagna talaren.
            const nextAuto = autoKeys.filter(x => x !== fromKey && x !== toKey);
            setAutoKeys(nextAuto);
            await persistSpeakerData(nextMap, participants, nextAuto);
            toast.success(`Slog ihop ${defaultLabel(fromSp)} med ${nextMap[toKey] || defaultLabel(toKey)}.`);
        } finally {
            mergingRef.current = false;
        }
    };

    const addParticipant = () => {
        const name = newParticipant.trim();
        if (!name || participants.includes(name)) { setNewParticipant(""); return; }
        const next = [...participants, name];
        setParticipants(next);
        persistSpeakerData(speakerMap, next);
        setNewParticipant("");
    };

    const removeParticipant = (name: string) => {
        const next = participants.filter(p => p !== name);
        setParticipants(next);
        persistSpeakerData(speakerMap, next);
    };

    // §13.1: bygg kanoniska turer ur ett FÄRSKT jobbresultat (inte den stale `turns`-memon) —
    // används av auto-namngivningen direkt efter en diarisering, innan React räknat om `turns`.
    const turnsFromJob = (job: Job): SpeakerTurn[] => {
        const raw: any[] = Array.isArray(job.result?.segments) ? job.result.segments : [];
        return raw
            .map(s => ({ speaker: String(s?.speaker ?? ""), text: String(s?.text ?? "").trim(), start: typeof s?.start === "number" ? s.start : null }))
            .filter(t => t.text && t.speaker && t.speaker !== "MOLN")
            .map(t => ({ speaker: speakerKey(t.speaker), text: t.text, start: t.start }));
    };

    // §13.1: kärnan i talaridentifiering, delad av den manuella "Namnge talare igen" och
    // auto-kedjan. Icke-förstörande: mergar LLM-förslag ovanpå `baseMap` (turerna rörs aldrig).
    // Provenance-styrt via `baseAuto` (mergeSuggestions): ett användarsatt namn skrivs ALDRIG
    // över — bara osatta/auto-satta nycklar får förslaget (fixar dagens `{...baseMap,...suggested}`).
    // silent = auto-läget: dämpade toaster + fel sväljs (ska aldrig gnälla på användaren).
    const runIdentify = async (
        apiTurns: SpeakerTurn[],
        parts: string[],
        baseMap: Record<string, string>,
        baseAuto: string[],
        opts: { silent?: boolean } = {},
    ) => {
        const silent = !!opts.silent;
        if (!isSignedIn || !isPro) { if (!silent) openUpsell('identify_speakers'); return; }
        if (!navigator.onLine) { if (!silent) toast.error("Denna funktion kräver internetanslutning."); return; }
        const token = getToken();
        if (!token) { if (!silent) toast.error("Kunde inte hämta autentiseringstoken. Logga in igen."); return; }
        if (apiTurns.length === 0) { if (!silent) toast.error("Inga talarsegment att identifiera."); return; }

        setIsIdentifying(true);
        // Metriken speglar ANVÄNDARINITIERAD identifiering — fyra den inte på auto-kedjan
        // (silent), annars inflateras "requested" av de automatiska anropen.
        if (!silent) events.speakersIdentifyRequested();
        try {
            const result = await identifySpeakers(apiTurns, parts, token);
            const suggested = result.speaker_map || {};
            if (Object.keys(suggested).length === 0) {
                if (!silent) toast.info("Kunde inte härleda namn ur samtalet. Klicka på en etikett för att namnge manuellt.");
                return;
            }
            const merged = mergeSuggestions(baseMap, suggested, baseAuto);
            // Antal FAKTISKT applicerade namn (förslag mot användarsatta nycklar avvisas).
            let count = 0;
            for (const [k, v] of Object.entries(merged.map)) if (baseMap[k] !== v) count++;
            if (count === 0) {
                if (!silent) toast.info("Namnen är redan satta. Klicka på en etikett för att ändra manuellt.");
                return;
            }
            setSpeakerMap(merged.map);
            setAutoKeys(merged.autoKeys);
            persistSpeakerData(merged.map, parts, merged.autoKeys);
            toast.success(
                silent
                    ? `Namngav ${count} talare automatiskt. Klicka på ett namn för att ändra.`
                    : `Identifierade ${count} talare. Klicka på ett namn för att ändra.`
            );
        } catch (error: any) {
            if (silent) { console.warn("Auto-namngivning misslyckades:", error?.message || error); return; }
            if (error?.message?.startsWith("Unauthorized")) {
                clearSession();
                showError('unauthorized', "Din session är inte längre giltig. Logga in igen.", { action: 'identify_speakers' });
            } else if (error?.message?.includes("Payment Required")) {
                // Visar upsell-modal i stället för toast → capture-only (ingen showError).
                captureEvent('error_shown', { surface: 'desktop', code: 'not_pro', action: 'identify_speakers' });
                openUpsell('identify_speakers_402');
            } else {
                showError(errorSlug(error), "Talaridentifiering misslyckades: " + (error?.message || "Okänt fel"), { action: 'identify_speakers' });
            }
        } finally {
            setIsIdentifying(false);
        }
    };

    // Manuell "Namnge talare igen": bygger turer ur den visade vyn (hoppar MOLN).
    const handleIdentifySpeakers = () => {
        const apiTurns: SpeakerTurn[] = turns
            .filter(t => t.speaker !== "MOLN")
            .map(t => ({ speaker: speakerKey(t.speaker), text: t.text, start: t.start_time ?? null }));
        return runIdentify(apiTurns, participants, speakerMap, autoKeys, { silent: false });
    };

    const handleAction = async () => {
        if (!navigator.onLine) {
            toast.error("Denna funktion kräver internetanslutning.");
            return;
        }

        if (!isSignedIn || !isPro) {
            openUpsell('analysis');
            return;
        }

        const token = getToken();
        if (!token) {
            toast.error("Kunde inte hämta autentiseringstoken. Logga in igen.");
            return;
        }

        const isUploaded = activeJob && (activeJob.cloud_job_id || activeJob.sync_status === 'uploaded' || activeJob.sync_status === 'synced');
        const hasTranscription = segments.length > 0;

        if (isUploaded || analysisData || hasTranscription) {
            if (!activeJob && segments.length === 0) return;
            events.analysisRequested();
            setIsReanalyzing(true);
            try {
                const fullText = segments.map(s => s.text).join(" ");

                // Synkat moln-jobb → kör om i molnet (job.analysis uppdateras → dashboard matchar
                // desktop). Osynkat/lokalt → stateless analys på den visade texten.
                // OBS: activeJob kan vara null direkt efter stopp (history-updated ej landad) —
                // segmenten finns redan, så analysera texten statelesst i det fallet.
                const raw = (activeJob?.cloud_job_id && useSettingsStore.getState().cloudSync)
                    ? ((await reanalyzeJob(activeJob.cloud_job_id, "general", token)).analysis || {})
                    : await reanalyzeTranscript(fullText, "general", token);

                const mappedAnalysis = {
                    summary: raw.summary || "",
                    decisions: raw.key_decisions || [],
                    actions: raw.action_items || [],
                    template_used: raw.template_used || "general"
                };

                setAnalysisData(mappedAnalysis as AnalysisData);
                events.analysisCompleted();
                // Stop polling so it doesn't overwrite this re-analysis result
                setUploadedJobId(null);

                // Persistens kräver en sparad inspelning — hoppa över tyst om activeJob
                // saknas (analysen visas ändå; sparas när inspelningen öppnas/synkas).
                if (activeJob?.id) {
                    await invoke("save_analysis_to_db", {
                        id: activeJob.id,
                        analysis: JSON.stringify(mappedAnalysis),
                        template: "general"
                    });

                    const updatedJob = {
                        ...activeJob,
                        analysis_json: JSON.stringify(mappedAnalysis),
                        ai_template_used: "general"
                    };
                    setActiveJob(updatedJob);
                }
                setTemplateId("general"); // Ensure global store is updated
                console.log("Analys uppdaterad!");
            } catch (e: any) {
                console.error("Re-analyze failed:", e);
                events.analysisFailed(e?.message || 'unknown');
                if (e.message?.includes("Payment Required")) {
                    openUpsell('analysis_402');
                } else {
                    toast.error("Kunde inte uppdatera analys.");
                }
            } finally {
                setIsReanalyzing(false);
            }
        } else {
            // Initial Sync
            if (activeJob?.audio_deleted) {
                toast.error("Ljudfilen är raderad — molnsynk kräver ljudet. Transkript och analys finns kvar.");
                return;
            }
            const uploadPath = activeJob ? activeJob.file_path : currentSessionPath;

            /**
             * Guard: uploadPath may be null if the Rust backend hasn't emitted the
             * 'history-updated' event yet (e.g. WAV finalisation is still in progress).
             * We surface this as a toast rather than failing silently.
             */
            if (!uploadPath) {
                toast.error("Uppladdning saknas: Inspelningsfilen är inte klar än. Försök igen om ett ögonblick.");
                return;
            }

            events.cloudSyncStarted();
            setUploadStatus('uploading');
            setErrorMessage(null);

            try {
                const job = await uploadJob(uploadPath, "general", token, useSettingsStore.getState().autoAnalyzeCloud);
                setUploadStatus('success');

                const targetDbId = activeJob ? activeJob.id : (currentSessionId ? parseInt(currentSessionId) : null);

                if (useSettingsStore.getState().cloudSync) {
                    // Synk PÅ → persistera + polla (visas i dashboard)
                    if (targetDbId) {
                        try {
                            await invoke("update_recording_status", {
                                id: targetDbId,
                                status: 'uploaded',
                                cloudJobId: job.id
                            });
                            if (activeJob) {
                                setActiveJob({ ...activeJob, sync_status: 'uploaded', cloud_job_id: job.id });
                            }
                        } catch (e) {
                            console.error("Failed to update DB status:", e);
                        }
                    }
                    setUploadedJobId(job.id);
                } else {
                    // Synk AV (default, privacy-first) → inline-resultat, inget sparas i molnet
                    const wc = await applyInlineCloudResult(job, targetDbId);
                    events.cloudSyncCompleted(wc);
                }
            } catch (error: any) {
                console.error("Upload failed", error);
                setUploadStatus('error');
                setProcessingStatus('FAILED');
                setUploadedJobId(null);
                setErrorMessage(String(error));
                if (error.message?.startsWith("Unauthorized")) {
                    clearSession();
                    toast.error("Din session är inte längre giltig. Logga in igen.");
                } else if (error.message?.includes("Payment Required")) {
                    toast.error(error.message);
                } else {
                    toast.error(`Uppladdning misslyckades: ${error.message || error.toString()}`);
                }
            }
        }
    };

    // Fetch segments when activeJob changes.
    // Prefer cloud_transcript on activeJob (survives tab switches) over DB segments.
    useEffect(() => {
        if (activeJob) {
            if (activeJob.ai_template_used) {
                setTemplateId(activeJob.ai_template_used);
            } else {
                setTemplateId("general");
            }

            // #14: hämta diariserade DB-segment FÖRST; batch-blobben (cloud_transcript) är
            // bara fallback när inga segment finns — så strömmade inspelningar behåller
            // Du/Mötet-layouten även efter synk.
            invoke<any[]>("get_recording_segments", { recordingId: activeJob.id })
                .then(dbSegments => {
                    const currentActiveJob = useSyncStore.getState().activeJob;
                    if (!currentActiveJob && !uploadedJobId) return;
                    const storeSegs = useTranscriptionStore.getState().segments;
                    const sid = useSyncStore.getState().currentSessionId;
                    const isCurrentSession = !!sid && String(activeJob.id) === sid;
                    if (dbSegments.length > 0) {
                        // #12: DB kan ligga efter live-storen medan sena chunks persisteras —
                        // skriv aldrig över en fylligare live-vy med en partiell DB-lista.
                        if (isCurrentSession && dbSegments.length < storeSegs.length) return;
                        setSegments(dbSegments.map(s => ({
                            ...s,
                            timestamp: s.start_time * 1000
                        })));
                    } else if (isCurrentSession && storeSegs.length > 0) {
                        return; // DB tom men live har text (persist ej klar) — behåll live-vyn
                    } else {
                        // Ingen lokal text för denna inspelning — töm storen så föregående
                        // inspelnings segment inte ligger kvar. Ett ev. molnresultat visas
                        // via cloud_transcript-fallbacken i segments-memon, INTE via storen
                        // (annars tror modellväxlaren att det finns två olika resultat).
                        clearSegments();
                    }
                })
                .catch(err => {
                    console.error("Failed to load segments:", err);
                    if (useTranscriptionStore.getState().segments.length === 0) setSegments([]);
                });
        } else {
            clearSegments();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeJob?.id, activeJob?.cloud_transcript, activeJob?.cloud_segments, setSegments, clearSegments]);

    const formatDuration = (seconds: number) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = seconds % 60;
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    };

    useEffect(() => {
        if (!activeJob?.id) return;


        const interval = setInterval(async () => {
            // Guard: If we are no longer interested in this job (e.g. user clicked "Back to Live"), stop polling.
            // We check local variable `uploadedJobId` but also need to check if the store has been reset.
            // Since `uploadedJobId` in dependency array triggers re-run, if it becomes null, this specific interval *should* be cleared by cleanup.
            // BUT, if the async `getJob` is in flight, it might resolve AFTER we reset.

            // To fix "Zombie Analysis":
            // 1. Check if we still have a valid ID in the store (or passed prop).
            // 2. Check if we are in "Active Job" mode (which should be null for live).
            // However, `uploadedJobId` IS for live-analysis polling. `activeJob` is for archive.

            // If the user clicked "Back to Live", `uploadedJobId` becomes null.
            // The cleanup function `clearInterval(interval)` runs.
            // BUT an existing `await getJob(uploadedJobId)` might be running.

            try {
                if (!uploadedJobId) return;

                // Double check validity before setting state
                const currentJobId = useSyncStore.getState().uploadedJobId;
                if (!currentJobId) return;

                const token = getToken();
                if (!token) return;

                const job = await getJob(uploadedJobId, token);

                // Final guard before updating state
                const currentActiveJob = useSyncStore.getState().activeJob;
                if (!currentActiveJob && !useSyncStore.getState().uploadedJobId) return;

                setProcessingStatus(job.status);

                if (job.status === 'COMPLETED') {
                    const analysis = job.analysis || {};

                    const completedAnalysis: AnalysisData = {
                        summary: analysis.summary || "",
                        decisions: analysis.key_decisions || [],
                        actions: analysis.action_items || [],
                        template_used: analysis.template_used
                    };

                    // Guard again
                    if (!useSyncStore.getState().uploadedJobId) return;

                    setAnalysisData(completedAnalysis);
                    events.analysisCompleted();

                    // Replace local whisper segments with the superior Berget cloud transcription
                    const cloudText = job.result?.text;
                    // Fas 1c: strukturerade DU/MÖTET-turer (stereo) → molnvyn renderar turer i
                    // stället för flat blob. Null för mono (inga talare) → flat blob behålls.
                    const cloudSegmentsJson = cloudSegmentsJsonFromJob(job);
                    if (cloudText) {
                        const wordCount = cloudText.trim().split(/\s+/).filter(Boolean).length;
                        events.cloudSyncCompleted(wordCount);
                    }
                    // Stop polling — prevents future intervals from overwriting re-analysis
                    setUploadedJobId(null);
                    if (cloudText && cloudText.trim()) {
                        // Skriv ALDRIG över lokala/diariserade segment — molnresultatet visas
                        // via modellväxlaren (activeJob.cloud_transcript/cloud_segments). Endast när
                        // inget annat resultat finns OCH molnet saknar strukturerade turer sätts den
                        // flata blobben direkt (batch-only); med turer renderar molnvyn dem via
                        // activeJob.cloud_segments (ingen falsk "lokal"-flik med samma text).
                        if (useTranscriptionStore.getState().segments.length === 0 && !cloudSegmentsJson) {
                            setSegments([{
                                id: -1,
                                start_time: 0,
                                end_time: 0,
                                text: cloudText.trim(),
                                speaker: "MOLN", // Special marker: cloud-sourced
                                timestamp: Date.now(),
                            }]);
                        }
                        setTranscriptView('cloud');
                    }

                    // Save to Local DB
                    const currentActiveJob = useSyncStore.getState().activeJob;
                    if (currentActiveJob?.id) {
                        try {
                            await invoke("save_analysis_to_db", {
                                id: currentActiveJob.id,
                                analysis: JSON.stringify(completedAnalysis),
                                template: completedAnalysis.template_used || "general"
                            });
                            // Persistera molnresultatet i sqlite — överlever omstart och
                            // gör att modellväxlaren fungerar när inspelningen återöppnas.
                            if (cloudText && cloudText.trim()) {
                                await invoke("save_cloud_transcript_to_db", {
                                    id: currentActiveJob.id,
                                    transcript: cloudText.trim(),
                                });
                            }
                            // Skriv ALLTID cloud_segments (tom sträng = rensa) så DB och
                            // in-memory aldrig divergerar — annars skulle en stereo→mono-
                            // omtranskribering lämna kvar gamla turer i DB medan activeJob
                            // nollställs → stale turer vid återöppning.
                            await invoke("save_cloud_segments_to_db", {
                                id: currentActiveJob.id,
                                cloudSegments: cloudSegmentsJson || "",
                            });

                            // R4: ny diarisering (numrerade etiketter) → invalidera instabila
                            // speaker_map-nycklar så gamla namn inte fastnar på fel omnumrerad röst.
                            let speakerMapRaw: string | null = currentActiveJob.speaker_map ?? null;
                            if (segmentsHaveDiarizationLabels(cloudSegmentsJson)) {
                                const invalidated = await invalidateStaleSpeakerMap(currentActiveJob.id, speakerMapRaw);
                                if (invalidated) speakerMapRaw = invalidated;
                                // Spegla invalideringen i in-memory-staten (se inline-vägen ovan).
                                setSpeakerMap(prev => stripUnstableSpeakerMapKeys(prev));
                                // Auto-provenance för omnumrerade nycklar är också inaktuell → filtrera.
                                setAutoKeys(prev => prev.filter(k => k in stripUnstableSpeakerMapKeys(speakerMapRef.current)));
                            }

                            // Persist cloud_transcript + cloud_segments so segments survive tab switches
                            const updatedJob = {
                                ...currentActiveJob,
                                analysis_json: JSON.stringify(completedAnalysis),
                                cloud_transcript: cloudText || null,
                                cloud_segments: cloudSegmentsJson,
                                speaker_map: speakerMapRaw,
                            };
                            setActiveJob(updatedJob);
                        } catch (e) {
                            console.error("Failed to save analysis to DB:", e);
                        }
                    }

                    // §13.1: auto-kedja namngivningen (tyst) efter en molndiarisering. Turer ur
                    // det FÄRSKA jobbet; basmap ur ref (polling-closuren är avsiktligt stale).
                    // Guard: bara vid diarisering — Pro/online-kontrollen ligger i runIdentify.
                    if (segmentsHaveDiarizationLabels(cloudSegmentsJson)) {
                        const base = stripUnstableSpeakerMapKeys(speakerMapRef.current);
                        const baseAuto = autoKeysRef.current.filter(k => k in base);
                        await runIdentify(turnsFromJob(job), participantsRef.current, base, baseAuto, { silent: true });
                    }

                    clearInterval(interval);
                } else if (job.status === 'FAILED') {
                    console.error("Job failed processing:", job.error_message);
                    clearInterval(interval);
                }
            } catch (err) {
                console.error("Polling error:", err);
            }
        }, 2000);

        return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [uploadedJobId, setAnalysisData, setProcessingStatus, activeJob?.id, setActiveJob, setUploadedJobId]);

    // Helper to get status text
    const getStatusText = () => {
        const withAnalysis = effectiveMode === 'cloud_analysis';
        switch (processingStatus) {
            case 'PENDING': return withAnalysis ? "Köar för transkribering och analys..." : "Köar för transkribering...";
            case 'PROCESSING': return withAnalysis ? "Transkriberar och analyserar med KB-Whisper Large..." : "Transkriberar med KB-Whisper Large...";
            case 'FAILED': return withAnalysis ? "Transkribering/analys misslyckades." : "Transkribering misslyckades.";
            default: return "Bearbetar i molnet...";
        }
    };

    return (
        <div className="grid grid-cols-5 h-full overflow-hidden bg-paper-dim/50">
            {/* Left: Live Transcription (60% -> 3/5 cols) */}
            <div className="col-span-3 flex flex-col h-full overflow-hidden min-w-0 bg-white border-r border-line/60 shadow-[4px_0_24px_-12px_rgba(0,0,0,0.1)] z-10 relative">
                <div className="px-8 py-6 flex-none flex justify-between items-center bg-white border-b border-line z-50">
                    <h2 className="text-xl font-semibold tracking-tight flex items-center gap-2.5 text-ink">
                        <div className="p-1.5 bg-brand/5 rounded-lg text-brand">
                            <FileText className="w-4 h-4" />
                        </div>
                        Transkription
                        {segments.length > 0 && (
                            <Button
                                variant="ghost"
                                size="icon"
                                className="h-6 w-6 text-ink-muted hover:text-ink-soft ml-1 rounded-full"
                                onClick={(e) => handleCopy(buildCopyText(), "transcript", e)}
                                title="Kopiera transkription"
                            >
                                {copiedKey === "transcript" ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
                            </Button>
                        )}
                        {/* §13.2: ETT åtgärdsmenyvalv i stället för tre separata knappar (toggle +
                            omtranskribera + identifiera). "Det bara fungerar" — omtranskribering
                            med/utan talarseparering (med: bara när backendens kill switch är på)
                            + manuell "Namnge talare igen" (auto-kedjan kör annars namngivningen av
                            sig själv efter en diarisering). Döljs helt när ingen åtgärd är möjlig
                            (t.ex. ljudet gallrat + inga talare att namnge). */}
                        {(() => {
                            const canRetranscribe = segments.length > 0 && !isRecording && !uploadedJobId &&
                                !isRetranscribing && !activeJob?.audio_deleted &&
                                (recordingMode === 'cloud' || recordingMode === 'cloud_analysis');
                            const canIdentify = segments.length > 0 && !isRecording && hasNamableSpeakers;
                            if (!canRetranscribe && !canIdentify) return null;
                            const busy = isRetranscribing || isIdentifying;
                            return (
                                <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-6 w-6 text-ink-muted hover:text-brand hover:bg-brand/5 ml-0.5 rounded-full"
                                            disabled={busy}
                                            title="Fler åtgärder"
                                        >
                                            {busy
                                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                                : (hasCloudResult ? <RefreshCw className="h-3.5 w-3.5" /> : <Cloud className="h-3.5 w-3.5" />)}
                                        </Button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="start" className="w-64">
                                        {canRetranscribe && (
                                            <>
                                                {diarizeEnabled && (
                                                    <DropdownMenuItem onClick={() => handleRetranscribe(true)} className="gap-2 cursor-pointer">
                                                        <Users className="h-3.5 w-3.5 text-brand" />
                                                        <span className="flex-1">Transkribera om med talarseparering</span>
                                                        <span className="rounded bg-brand/10 px-1 py-0.5 text-[9px] font-semibold text-brand">Beta</span>
                                                    </DropdownMenuItem>
                                                )}
                                                <DropdownMenuItem onClick={() => handleRetranscribe(false)} className="gap-2 cursor-pointer">
                                                    <RefreshCw className="h-3.5 w-3.5 text-ink-muted" />
                                                    {/* "(standard)" skiljer valet från talarsepareringen ovanför. Utan den finns inget att skilja från. */}
                                                    {diarizeEnabled ? "Transkribera om (standard)" : "Transkribera om"}
                                                </DropdownMenuItem>
                                            </>
                                        )}
                                        {canRetranscribe && canIdentify && <DropdownMenuSeparator />}
                                        {canIdentify && (
                                            <DropdownMenuItem onClick={handleIdentifySpeakers} className="gap-2 cursor-pointer">
                                                <Sparkles className="h-3.5 w-3.5 text-ink-muted" />
                                                Namnge talare igen
                                            </DropdownMenuItem>
                                        )}
                                    </DropdownMenuContent>
                                </DropdownMenu>
                            );
                        })()}
                    </h2>
                    <div className="flex items-center gap-3">
                        <ModePill onUpsellClick={() => openUpsell('mode_pill')} />
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto min-h-0 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-line [&::-webkit-scrollbar-thumb]:rounded-full">
                    <div className="p-8 pt-4 max-w-3xl mx-auto space-y-8">
                        {/* History Banner — only shown when user explicitly opened a recording from history */}
                        {activeJob && activeJobFromHistory && (
                            <div className="bg-paper-dim border border-line rounded-lg px-4 py-2.5 flex items-center justify-between animate-in fade-in slide-in-from-top-2">
                                <div className="flex items-center gap-2 text-ink-soft">
                                    <History className="w-4 h-4 flex-shrink-0" />
                                    <span className="text-sm">
                                        {(() => {
                                            const date = new Date(activeJob.created_at || activeJob.createdAt);
                                            const isToday = date.toDateString() === new Date().toDateString();
                                            const dateStr = isToday ? 'Idag' : date.toLocaleDateString('sv-SE', { day: 'numeric', month: 'long' });
                                            const dur = formatDuration((activeJob.duration_sec || activeJob.durationSeconds) ?? 0);
                                            return `${dateStr} • ${dur}`;
                                        })()}
                                    </span>
                                </div>
                                <button
                                    className="text-xs text-ink-muted hover:text-ink-soft transition-colors ml-4"
                                    onClick={() => {
                                        reset();
                                        resetToLive();
                                        clearSegments();
                                    }}
                                >
                                    Stäng
                                </button>
                            </div>
                        )}

                        {/* Modellväxlare — visas när inspelningen har resultat från BÅDA
                            modellerna (lokala segment + KB-Whisper Large) så användaren kan
                            jämföra och se värdet av Pro. */}
                        {hasModelToggle && (
                            <div className="flex items-center gap-1.5">
                                <button
                                    onClick={() => setTranscriptView('local')}
                                    className={`text-[10px] font-bold tracking-widest uppercase px-2 py-0.5 rounded-md border transition-colors ${
                                        transcriptView === 'local'
                                            ? 'bg-paper-dim text-ink-soft border-line'
                                            : 'bg-transparent text-ink-muted border-transparent hover:text-ink-soft'
                                    }`}
                                >
                                    🖥 Lokal
                                </button>
                                <button
                                    onClick={() => setTranscriptView('cloud')}
                                    className={`text-[10px] font-bold tracking-widest uppercase px-2 py-0.5 rounded-md border transition-colors ${
                                        transcriptView === 'cloud'
                                            ? 'bg-brand/5 text-brand border-brand/10'
                                            : 'bg-transparent text-ink-muted border-transparent hover:text-brand'
                                    }`}
                                >
                                    ☁ KB-Whisper Large
                                </button>
                            </div>
                        )}

                        {!activeJob && segments.length === 0 ? (
                            // Två skilda tillstånd, medvetet olika tyngd:
                            //   Vilar  → panelen är genuint tom, ett block som säger vad man gör.
                            //   Spelar in → något händer redan; då räcker samma diskreta rad som
                            //     visas under texten så fort första segmentet landar. Läget
                            //     (Moln/Lokal) ägs av ModePill i headern och upprepas inte här.
                            <div className="flex flex-col items-center justify-center h-[50vh] text-center animate-in fade-in duration-1000">
                                {isRecording ? (
                                    <ListeningIndicator />
                                ) : (
                                    <div className="space-y-4 opacity-40">
                                        <div className="p-4 rounded-full bg-paper-dim w-fit mx-auto">
                                            <Sparkles className="w-8 h-8 text-ink-muted" />
                                        </div>
                                        <div className="space-y-1">
                                            <p className="text-ink font-medium">Redo för mötet</p>
                                            <p className="text-sm text-ink-muted max-w-xs mx-auto">
                                                Starta inspelningen för att se transkribering i realtid.
                                            </p>
                                        </div>
                                    </div>
                                )}
                            </div>
                        ) : isMerged ? (
                            // Sammanhängande (1×): ett flöde, styckesbryt vid pauser
                            <div className="space-y-4 animate-in fade-in duration-500">
                                {/* Badge redundant när modellväxlaren redan visar källan */}
                                {!hasModelToggle && (
                                    <span className="inline-block text-[10px] font-bold tracking-widest uppercase px-2 py-0.5 rounded-md bg-brand/5 text-brand border border-brand/10">
                                        ☁ KB-Whisper Large
                                    </span>
                                )}
                                {mergedParagraphs.map((para, i) => (
                                    <p key={i} className="leading-relaxed text-[15px] pl-1 border-l-2 border-brand/20 text-ink">
                                        {para}
                                    </p>
                                ))}
                            </div>
                        ) : (
                            <div className="space-y-0">
                                {showLocalFallbackBadge && (
                                    <span className="inline-block text-[10px] font-medium px-2 py-0.5 rounded-md bg-paper-dim text-ink-muted border border-line mb-3">
                                        🖥 Lokalt (molnet ej tillgängligt)
                                    </span>
                                )}
                                {/* Click-outside: stänger en öppen namnbyte-popover. z under popovern (z-50). */}
                                {editingTurnIndex !== null && (
                                    <div className="fixed inset-0 z-40" onClick={cancelRename} />
                                )}
                                {/* Deltagar-chips (frivilligt) — "Vilka är med?". Skickas som
                                    participant_hints vid identifiering + snabbval i namnbyte-popovern. */}
                                {hasNamableSpeakers && (
                                    <div className="flex flex-wrap items-center gap-1.5 mb-4 pb-3 border-b border-line/60">
                                        <Users className="w-3.5 h-3.5 text-ink-muted mr-0.5" />
                                        <span className="text-xs text-ink-muted mr-1">Vilka är med?</span>
                                        {participants.map((p) => (
                                            <span key={p} className="inline-flex items-center gap-1 text-xs bg-brand/5 text-brand border border-brand/10 rounded-full pl-2.5 pr-1 py-0.5">
                                                {p}
                                                <button onClick={() => removeParticipant(p)} className="hover:bg-brand/10 rounded-full p-0.5" title="Ta bort">
                                                    <X className="w-2.5 h-2.5" />
                                                </button>
                                            </span>
                                        ))}
                                        <input
                                            value={newParticipant}
                                            onChange={(e) => setNewParticipant(e.target.value)}
                                            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addParticipant(); } }}
                                            onBlur={addParticipant}
                                            placeholder="Lägg till namn…"
                                            className="text-xs bg-transparent border-b border-dashed border-line focus:border-brand outline-none px-1 py-0.5 w-28 text-ink placeholder:text-ink-muted/60"
                                        />
                                    </div>
                                )}
                                {turns.map((turn, index, arr) => {
                                    // Pausbryt: extra luft när gapet till föregående tur ≥ pauseBreakMs.
                                    const prev = arr[index - 1];
                                    const pauseBreak = !!prev && (turn.start_time - prev.end_time) * 1000 >= pauseBreakMs;
                                    const isDu = turn.speaker === "DU" || turn.speaker === "mic";
                                    const isMoln = turn.speaker === "MOLN";
                                    const isEditing = editingTurnIndex === index;
                                    return (
                                        <p
                                            key={index}
                                            className={`leading-relaxed text-[15px] animate-in fade-in slide-in-from-bottom-1 duration-500 fill-mode-backwards ${pauseBreak ? 'mt-5' : 'mt-1.5'}`}
                                        >
                                            {!isMoln && (
                                                <span className="relative inline-block">
                                                    <button
                                                        type="button"
                                                        onClick={() => openRename(index, turn.speaker)}
                                                        className={`font-semibold rounded hover:underline decoration-dotted underline-offset-2 transition-colors ${isDu ? "text-brand" : speakerColor(turn.speaker)}`}
                                                        title="Namnge talaren"
                                                    >
                                                        {speakerLabel(turn.speaker)}:
                                                    </button>
                                                    {/* Namnbyte-popover (span-only inuti <p>; div är ogiltigt i p) */}
                                                    {isEditing && (
                                                        <span className="absolute left-0 top-full mt-1 z-50 flex flex-col gap-2 bg-white border border-line rounded-lg shadow-lg p-3 w-64 font-normal normal-case text-left">
                                                            <input
                                                                autoFocus
                                                                value={editingName}
                                                                onChange={(e) => setEditingName(e.target.value)}
                                                                onKeyDown={(e) => {
                                                                    if (e.key === 'Enter') { e.preventDefault(); commitRename(turn.speaker); }
                                                                    if (e.key === 'Escape') { e.preventDefault(); cancelRename(); }
                                                                }}
                                                                placeholder={`Namn för "${defaultLabel(turn.speaker)}"`}
                                                                className="text-sm border border-line rounded-md px-2 py-1 outline-none focus:border-brand text-ink"
                                                            />
                                                            {participants.length > 0 && (
                                                                <span className="flex flex-wrap gap-1">
                                                                    {participants.map((p) => (
                                                                        <button
                                                                            key={p}
                                                                            type="button"
                                                                            onClick={() => setEditingName(p)}
                                                                            className="text-xs bg-paper-dim hover:bg-brand/10 text-ink-soft hover:text-brand border border-line rounded-full px-2 py-0.5"
                                                                        >
                                                                            {p}
                                                                        </button>
                                                                    ))}
                                                                </span>
                                                            )}
                                                            {/* §13.3: slå ihop denna talare med en annan (läker Du 1/Du 2-
                                                                översegmentering). Bara i cloud-vyn där diariserade turer finns. */}
                                                            {mergeableView && (() => {
                                                                const selfKey = speakerKey(turn.speaker);
                                                                const others = [...new Set(
                                                                    turns.filter(t => t.speaker !== "MOLN").map(t => speakerKey(t.speaker))
                                                                )].filter(k => k !== selfKey);
                                                                if (others.length === 0) return null;
                                                                return (
                                                                    <span className="flex flex-col gap-1 pt-1 border-t border-line/60">
                                                                        <span className="text-[10px] text-ink-muted">Samma röst? Slå ihop med:</span>
                                                                        <span className="flex flex-wrap gap-1">
                                                                            {others.map((k) => (
                                                                                <button
                                                                                    key={k}
                                                                                    type="button"
                                                                                    onClick={() => mergeSpeakers(turn.speaker, k)}
                                                                                    title={`Alla "${speakerLabel(turn.speaker)}"-turer blir "${speakerMap[k] || defaultLabel(k)}"`}
                                                                                    className="text-xs bg-paper-dim hover:bg-brand/10 text-ink-soft hover:text-brand border border-line rounded-full px-2 py-0.5"
                                                                                >
                                                                                    {speakerMap[k] || defaultLabel(k)}
                                                                                </button>
                                                                            ))}
                                                                        </span>
                                                                    </span>
                                                                );
                                                            })()}
                                                            <span className="flex items-center justify-end gap-2">
                                                                <button type="button" onClick={cancelRename} className="text-xs text-ink-muted hover:text-ink-soft px-2 py-1">Avbryt</button>
                                                                <button type="button" onClick={() => commitRename(turn.speaker)} className="text-xs font-medium bg-brand text-paper rounded-md px-3 py-1 hover:bg-brand-deep">Spara</button>
                                                            </span>
                                                        </span>
                                                    )}
                                                </span>
                                            )}
                                            {!isMoln && " "}
                                            <span className="text-ink-soft">{turn.text}</span>
                                        </p>
                                    );
                                })}
                            </div>
                        )}
                        {/* Samma element som visas i det tomma tillståndet — när första segmentet
                            landar glider raden bara ned under texten i stället för att bytas ut. */}
                        {isRecording && segments.length > 0 && (
                            <div className="pl-1 mt-2">
                                <ListeningIndicator />
                            </div>
                        )}
                        {/* Cloud Processing Indicator — shown while polling for Berget result */}
                        {!activeJob && !isRecording && processingStatus === 'PROCESSING' && (
                            <div className="flex items-center gap-2 pl-1 mt-2">
                                <Loader2 className="w-3.5 h-3.5 animate-spin text-brand" />
                                <span className="text-xs text-brand font-medium">{getStatusText()}</span>
                            </div>
                        )}
                        {/* GDPR 24h-notice — visas när cloud-synk slutförts */}
                        {!isRecording && processingStatus === 'COMPLETED' && activeJob?.cloud_job_id && (
                            <span className="text-[10px] text-ink-muted pl-1 mt-1 block">
                                ℹ Ljud raderas automatiskt om 24 h (GDPR)
                            </span>
                        )}
                        {/* Local Finalizing Indicator */}
                        {/* #11: gata INTE på !activeJob — activeJob sätts direkt vid stopp medan
                            moln-kön fortfarande processar; indikatorn + Avbryt ska lysa tills klart. */}
                        {isFinalizingLocal && (
                            <div className="flex flex-col gap-3 animate-pulse pl-1 mt-4">
                                <div className="flex items-center gap-2">
                                    <Loader2 className="w-4 h-4 animate-spin text-brand" />
                                    <span className="text-xs font-medium text-brand">Slutför transkribering... vänta</span>
                                </div>
                                <div>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        onClick={handleCancel}
                                        className="text-xs text-ink-muted hover:text-red-600"
                                    >
                                        Avbryt
                                    </Button>
                                </div>
                            </div>
                        )}
                        {/* Pro-hint: långsam lokal transkribering (≥15 s slutför-väntan, icke-Pro).
                            Eget block utanför animate-pulse-containern så kortet inte blinkar.
                            isFinalizingLocal-grinden är LASTBÄRANDE, inte redundant: när läget
                            bryts släcker hookens effekt showSlowHint först en render senare —
                            utan grinden flashar kortet en frame precis när resultatet visas. */}
                        {isFinalizingLocal && showSlowHint && (
                            <div className="max-w-sm rounded-xl border border-line bg-paper-dim p-4 mt-3 ml-1">
                                <div className="flex items-start justify-between gap-3">
                                    <h4 className="text-xs font-semibold text-ink">Därför tar det tid</h4>
                                    <button
                                        onClick={dismissSlowHint}
                                        className="text-ink-muted hover:text-ink transition-colors flex-none"
                                        aria-label="Visa inte igen"
                                        title="Visa inte igen"
                                    >
                                        <X className="w-3.5 h-3.5" />
                                    </button>
                                </div>
                                <p className="text-xs text-ink-muted mt-1.5 leading-relaxed">
                                    AI-transkribering kräver ett kraftfullt grafikkort — utan det kör
                                    appen den minsta modellen långsamt på processorn. Pro kör samma jobb
                                    på dedikerade GPU-servrar med den största KB-Whisper-modellen:
                                    snabbare och med högre kvalitet.
                                </p>
                                <Button
                                    size="sm"
                                    className="mt-3 h-8 text-xs bg-brand text-paper hover:bg-brand-deep"
                                    onClick={() => openUpsell('slow_hint')}
                                >
                                    Se Pro
                                </Button>
                            </div>
                        )}
                        <div ref={scrollRef} className="h-10" />
                    </div>
                </div>
            </div>

            {/* Right: AI Insights (40% -> 2/5 cols) */}
            <div className="col-span-2 flex flex-col h-full overflow-hidden bg-paper/60 relative">
                <div className="px-8 py-6 flex-none bg-paper/60 border-b border-line z-50 flex justify-between items-center">
                    <h2 className="text-lg font-medium tracking-tight flex items-center gap-2 text-ink-soft">
                        <Sparkles className="w-4 h-4 text-ochre" />
                        <span className="text-[11px] font-semibold uppercase tracking-widest text-ochre">Protokoll</span>
                    </h2>

                    {/* User button */}
                    {isSignedIn && (
                        <div className="relative" ref={userMenuRef}>
                            <button
                                onClick={() => setShowUserMenu((v) => !v)}
                                className="w-8 h-8 rounded-full bg-brand text-paper text-xs font-semibold flex items-center justify-center hover:bg-brand-deep transition-colors focus:outline-none focus:ring-2 focus:ring-brand/40 focus:ring-offset-2"
                                title={email || "Konto"}
                            >
                                {initials}
                            </button>
                            {showUserMenu && (
                                <div className="absolute right-0 top-full mt-2 w-56 bg-white rounded-xl shadow-lg border border-line py-2 z-50 animate-in fade-in slide-in-from-top-1 duration-150">
                                    <div className="px-4 py-2 border-b border-line">
                                        <p className="text-sm font-medium text-ink truncate">{email}</p>
                                        <p className="text-xs text-ink-muted mt-0.5">{isPro ? "Sagt Pro" : "Free"}</p>
                                    </div>
                                    <button
                                        onClick={() => { setShowUserMenu(false); clearSession(); }}
                                        className="w-full px-4 py-2 text-left text-sm text-red-600 hover:bg-red-50 transition-colors flex items-center gap-2"
                                    >
                                        <LogOut className="w-3.5 h-3.5" />
                                        Logga ut
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <div className="flex-1 flex flex-col gap-4 p-8 pt-4 overflow-y-auto min-h-0 [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:bg-line [&::-webkit-scrollbar-thumb]:rounded-full">
                        {/* Summary Section */}
                        {(analysisData || uploadedJobId || (isSignedIn && isPro)) && (
                            <Card className="border border-brand/10 shadow-sm bg-white/80 p-6 space-y-4 relative overflow-hidden flex-none">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                    <h3 className="font-semibold text-xs text-ink uppercase tracking-widest opacity-70">Sammanfattning</h3>
                                    {analysisData?.summary && (
                                        <Button
                                            variant="ghost"
                                            size="icon"
                                            className="h-5 w-5 text-brand/60 hover:text-brand hover:bg-brand/5 rounded-full"
                                            onClick={(e) => handleCopy(analysisData.summary, "summary", e)}
                                            title="Kopiera sammanfattning"
                                        >
                                            {copiedKey === "summary" ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                                        </Button>
                                    )}
                                </div>
                                {/* Analyze / re-analyze button: shown whenever there is a transcription and user is Pro */}
                                {!isReanalyzing && isPro && isSignedIn && segments.length > 0 && !isRecording && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-6 w-6 text-ink-muted hover:text-brand hover:bg-brand/5 rounded-full"
                                      title={analysisData ? "Analysera igen" : "Starta analys"}
                                      onClick={handleAction}
                                    >
                                      {analysisData ? <RefreshCw className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                                    </Button>
                                )}
                            </div>

                            {isReanalyzing ? (
                                <div className="flex flex-col items-center justify-center h-[50vh] space-y-4 p-8 text-center animate-in fade-in zoom-in-95 duration-500">
                                    <div className="relative">
                                        <div className="absolute inset-0 bg-brand/20 rounded-full animate-ping opacity-25"></div>
                                        <div className="relative w-12 h-12 bg-brand/10 rounded-full flex items-center justify-center text-brand">
                                            <Loader2 className="w-6 h-6 animate-spin" />
                                        </div>
                                    </div>
                                    <div className="text-center space-y-1">
                                        <h3 className="text-sm font-medium text-ink">Uppdaterar analys...</h3>
                                        <p className="text-xs text-ink-muted animate-pulse">
                                            Analyserar kontext, beslut och åtgärder...
                                        </p>
                                    </div>
                                </div>
                            ) : analysisData ? (
                                <div className="space-y-4 animate-in fade-in slide-in-from-bottom-2 duration-500">
                                    <div className="prose prose-sm prose-slate max-w-none">
                                        <p className="text-sm text-ink-soft leading-relaxed bg-white p-3 rounded-lg border border-line shadow-sm">
                                            {analysisData.summary || "Ingen sammanfattning tillgänglig."}
                                        </p>
                                    </div>

                                    {/* Decisions Block */}
                                    <div className="space-y-2 mt-4">
                                        <div className="flex items-center gap-2">
                                            <h4 className="text-xs font-semibold text-ink uppercase tracking-wide flex items-center gap-1.5">
                                                <div className="w-1.5 h-1.5 rounded-full bg-verified"></div>
                                                Beslut
                                            </h4>
                                            {analysisData.decisions && analysisData.decisions.length > 0 && (
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-5 w-5 text-ink-muted hover:text-ink-soft hover:bg-paper-dim rounded-full"
                                                    onClick={(e) => handleCopy(analysisData.decisions!.join("\n"), "decisions", e)}
                                                    title="Kopiera beslut"
                                                >
                                                    {copiedKey === "decisions" ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                                                </Button>
                                            )}
                                        </div>
                                        {analysisData.decisions && analysisData.decisions.length > 0 ? (
                                            <ul className="space-y-2">
                                                {analysisData.decisions.map((decision: string, i: number) => (
                                                    <li key={i} className="text-xs text-ink-soft bg-verified/[0.04] p-2 rounded border border-verified/10 flex gap-2 items-start">
                                                        <span className="text-verified font-bold">•</span>
                                                        {decision}
                                                    </li>
                                                ))}
                                            </ul>
                                        ) : (
                                            <p className="text-xs text-ink-muted italic">Inga beslut identifierade.</p>
                                        )}
                                    </div>

                                    {/* Actions Block */}
                                    <div className="space-y-2 mt-4">
                                        <div className="flex items-center gap-2">
                                            <h4 className="text-xs font-semibold text-ink uppercase tracking-wide flex items-center gap-1.5">
                                                <div className="w-1.5 h-1.5 rounded-full bg-brand"></div>
                                                Åtgärder
                                            </h4>
                                            {analysisData.actions && analysisData.actions.length > 0 && (
                                                <Button
                                                    variant="ghost"
                                                    size="icon"
                                                    className="h-5 w-5 text-ink-muted hover:text-ink-soft hover:bg-paper-dim rounded-full"
                                                    onClick={(e) => handleCopy(analysisData.actions!.join("\n"), "actions", e)}
                                                    title="Kopiera åtgärder"
                                                >
                                                    {copiedKey === "actions" ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
                                                </Button>
                                            )}
                                        </div>
                                        {analysisData.actions && analysisData.actions.length > 0 ? (
                                            <ul className="space-y-2">
                                                {analysisData.actions.map((action: string, i: number) => (
                                                    <li key={i} className="text-xs text-ink-soft bg-brand/[0.03] p-2 rounded border border-brand/10 flex gap-2 items-start">
                                                        <div className="w-3 h-3 rounded border border-brand/20 mt-0.5 flex-shrink-0"></div>
                                                        {action}
                                                    </li>
                                                ))}
                                            </ul>
                                        ) : (
                                            <p className="text-xs text-ink-muted italic">Inga åtgärder identifierade.</p>
                                        )}
                                    </div>
                                </div>
                            ) : uploadedJobId ? (
                                <div className="flex flex-col items-center justify-center p-8 space-y-4 animate-in fade-in zoom-in-95 duration-500">
                                    <div className="relative">
                                        <div className="absolute inset-0 bg-brand/20 rounded-full animate-ping opacity-25"></div>
                                        <div className="relative w-12 h-12 bg-brand/10 rounded-full flex items-center justify-center text-brand">
                                            <Sparkles className="w-6 h-6 animate-pulse" />
                                        </div>
                                    </div>
                                    <div className="text-center space-y-1">
                                        <h3 className="text-sm font-medium text-ink">{getStatusText()}</h3>
                                        <p className="text-xs text-ink-muted">
                                            Analyserar kontext, beslut och åtgärder.
                                        </p>
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <div className="space-y-3 opacity-50">
                                        <div className="h-2 bg-paper-dim rounded w-3/4"></div>
                                        <div className="h-2 bg-paper-dim rounded w-full"></div>
                                        <div className="h-2 bg-paper-dim rounded w-5/6"></div>
                                    </div>
                                    {/* Säger vad som gäller DENNA panel. Att upprepa "Transkriberar…"
                                        här var tredje gången samma sak stod på skärmen samtidigt.

                                        Löftet om AUTOMATISK start måste spegla samma villkor som
                                        faktiskt driver den (auto-finalize.ts: isCloudMode &&
                                        autoAnalyze). Vi gatar på cloudStreamingActive i stället för
                                        recordingMode — molnläge med nedet nere degraderar till lokalt,
                                        och då körs ingen finalizeStreamingSession. */}
                                    <p className="text-sm text-ink-muted pt-2 text-center">
                                        {isRecording
                                            ? (cloudStreamingActive && autoAnalyze
                                                ? "AI-analysen startar när du stoppar inspelningen."
                                                : "AI-analysen kan startas när inspelningen är klar.")
                                            : "Starta inspelningen för att se transkribering i realtid."}
                                    </p>
                                </>
                            )}
                        </Card>
                        )}

                        {/* Skeleton — syns genom blur-overlay för ej Pro-användare */}
                        {(!isSignedIn || !isPro) && (
                            <div className="space-y-5 pointer-events-none select-none" aria-hidden="true">

                                {/* Sammanfattning */}
                                <div className="space-y-2">
                                    <p className="text-[10px] font-semibold text-ink-muted uppercase tracking-widest">Sammanfattning</p>
                                    <div className="space-y-1.5">
                                        <div className="h-2 bg-paper-dim rounded-full w-full" />
                                        <div className="h-2 bg-paper-dim rounded-full w-5/6" />
                                        <div className="h-2 bg-paper-dim rounded-full w-4/6" />
                                    </div>
                                </div>

                                {/* Beslut */}
                                <div className="space-y-2">
                                    <p className="text-[10px] font-semibold text-ink-muted uppercase tracking-widest">Beslut</p>
                                    <div className="space-y-2">
                                        <div className="flex items-start gap-2">
                                            <div className="w-1.5 h-1.5 rounded-full bg-paper-dim mt-1.5 flex-shrink-0" />
                                            <div className="h-2 bg-paper-dim rounded-full w-4/5" />
                                        </div>
                                        <div className="flex items-start gap-2">
                                            <div className="w-1.5 h-1.5 rounded-full bg-paper-dim mt-1.5 flex-shrink-0" />
                                            <div className="h-2 bg-paper-dim rounded-full w-3/5" />
                                        </div>
                                    </div>
                                </div>

                                {/* Åtgärder */}
                                <div className="space-y-2">
                                    <p className="text-[10px] font-semibold text-ink-muted uppercase tracking-widest">Åtgärder</p>
                                    <div className="space-y-2">
                                        <div className="flex items-start gap-2">
                                            <div className="w-3 h-3 rounded border border-line mt-0.5 flex-shrink-0" />
                                            <div className="h-2 bg-paper-dim rounded-full w-full" />
                                        </div>
                                        <div className="flex items-start gap-2">
                                            <div className="w-3 h-3 rounded border border-line mt-0.5 flex-shrink-0" />
                                            <div className="h-2 bg-paper-dim rounded-full w-5/6" />
                                        </div>
                                        <div className="flex items-start gap-2">
                                            <div className="w-3 h-3 rounded border border-line mt-0.5 flex-shrink-0" />
                                            <div className="h-2 bg-paper-dim rounded-full w-3/4" />
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                </div>

                {/* Lock overlay — täcker hela höger kolonn inklusive "Protokoll"-rubrik, exakt som hero-mockupen */}
                {(!isSignedIn || !isPro) && (
                    <div className="absolute inset-0 z-[51] bg-white/55 backdrop-blur-[2px] grid place-items-center pointer-events-none">
                        <div className="pointer-events-auto">
                            {/* Här fanns tidigare en "Väntar på betalning..."-gren styrd av en egen
                                usePaymentRefresh-instans. Den kunde aldrig renderas: hookens isWaiting är
                                per-instans useState och den här instansen anropade aldrig startPolling —
                                modalen har sin egen. Och även med delat tillstånd hade grenen varit
                                oåtkomlig, eftersom overlayen (z-51) bara syns när modalen (z-100) är
                                stängd, och varje väg som stänger modalen anropar stopPolling(). */}
                            <button
                                onClick={() => openUpsell('locked_panel')}
                                className="inline-flex items-center gap-2 rounded-full bg-ink text-paper text-xs font-semibold px-4 py-2 hover:bg-ink/90 transition-colors shadow-md"
                            >
                                <Lock className="w-3.5 h-3.5" />
                                Lås upp med Pro
                            </button>
                        </div>
                    </div>
                )}
            </div >

            <UpsellModal
                isOpen={showUpsellModal}
                onClose={() => setShowUpsellModal(false)}
                source={upsellSource}
            />
        </div >
    );
}
