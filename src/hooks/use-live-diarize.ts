import { useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncStore } from "@/store/sync-store";
import { useSettingsStore } from "@/store/settings-store";
import { useAuthStore } from "@/store/auth-store";
import { useConfigStore } from "@/store/config-store";
import { useTranscriptionStore } from "@/store/transcription-store";
import { mintLiveSession, reconcileLiveSession } from "@/lib/api";
import { applyDiarizationTurns } from "@/lib/diarize-relabel";
import { LiveDiarizeAccumulator } from "@/lib/live-diarize-labels";
import { captureEvent } from "@/hooks/use-posthog-events";

// STEG 3 — live-diarisering under pågående möte (pyannoteAI Live-1, Option B: ws:en bor här).
//
// Rust (PR-7) emitterar MÖTET-kanalen som `live-diarize-pcm` (100 ms 16 kHz f32-frames). Denna
// hook mintar en session via brokern (PR-6), öppnar en browser-WebSocket DIREKT till den
// pre-signerade URL:en (ingen auth-header, SPIKE Q1), strömmar frames dit och konsumerar
// speaker-events → `applyDiarizationTurns` inkrementellt (samma motor som steg 4). Steg 2-loopen
// namnger de nya MÖTET N löpande; steg 4-batchen vid stopp skriver över live-etiketterna (Q6).
//
// Monteras EN gång i App.tsx (som useCloudStream/useLiveSpeakerNaming) — modulnivå-tillstånd är
// därför säkert. Allt är GATEAT: molnläge + structured + Pro + online (+ brokern gatar
// LIVE_DIARIZE_ENABLED via 503). Fel/slotbrist → tyst degradering (batchen vid stopp täcker).
//
// ── ARKITEKTURBESLUT: Option B (ws i WebView) vs Option A (ws i Rust) ─────────
// Vi valde Option B (2026-07-13): ws:en + sessionskedjan bor i TS/WebView, Rust emitterar bara
// pcm. Skäl: slutresultatet är korrekt oavsett (steg 4-batchen skriver över live vid stopp),
// det matchar kodens etablerade "Rust fångar+emitterar, TS nätverkar"-söm, och tillför NOLL nya
// deps i den signerade ljudbinären.
// KÄND BEGRÄNSNING + UPPGRADERINGSTRIGGER: när WebView:en throttlas (appen minimerad — vanligt
// för en mötesinspelare) kan frame-forwarding/ws:en pausas → live-uppdateringen hackar medan
// minimerad (slutresultatet påverkas ej). OM PostHog visar att detta drabbar riktiga användare
// (t.ex. många långa möten minimerade) → uppgradera ljudvägen till Option A: flytta ws:en +
// sessionskedjan till Rust (tokio-tungstenite; OS-trådnivå, ej WebView-throttlad). Kontraktet
// (Rust emitterar pcm; sessionskedja + relabel i TS) behöver INTE ändras för brokern/steg 4.

const FRAME_SEC = 0.1;              // 100 ms per frame från Rust
const RECONNECT_DELAY_MS = 600;     // liten paus före omkoppling (undvik tight loop vid drop)
const MAX_FAILED_RECONNECTS = 20;   // tak för PÅ VARANDRA FÖLJANDE misslyckade re-mints per möte

// ── Modulnivå-tillstånd (singleton — hooken monteras en gång) ────────────────
let ws: WebSocket | null = null;
let running = false;                // live-diarise aktiv för pågående inspelning
let sessionIndex = 0;               // ökar per session i kedjan (sessionslokala etiketter, Q3)
let framesReceived = 0;             // totalt antal 100 ms-frames från Rust denna inspelning
let sessionBaseSec = 0;             // ljudposition (sek) när nuvarande sessions ström startade
let currentSessionId: string | null = null;
let acc: LiveDiarizeAccumulator | null = null;
let failedReconnects = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function gatesPass(): boolean {
    const sync = useSyncStore.getState();
    const settings = useSettingsStore.getState();
    return (
        sync.isRecording &&
        sync.cloudStreamingActive &&
        useAuthStore.getState().isPro() &&
        navigator.onLine &&
        // Backendens kill switch, hämtad av AppGuard. Utan den här raden mintade varje
        // inspelningsstart mot en endpoint som svarar 503 när flaggan är av. Kill
        // switch-grenen (live_diarize.py:51-52) loggar ingenting — 503:an blir ett
        // Sentry-ärende genom HTTPException-fångsten, och en post i 5xx-larmet.
        // Defaulten är false, så en app som startat offline frågar inte på chans.
        useConfigStore.getState().liveDiarizeEnabled &&
        settings.cloudDiarizationMode === "structured"
    );
}

/** Applicera de ackumulerade turerna på segmenten — atomiskt (funktionell setState) så en
 *  samtidig `addSegment` från useCloudStream inte klottras över. Frysta "MÖTET N" rörs inte
 *  om (speakerKey normaliserar inte numret) → stabila etiketter under mötet. */
function applyTurns() {
    if (!acc) return;
    const turns = acc.getTurns();
    if (turns.length === 0) return;
    useTranscriptionStore.setState((s) => ({ segments: applyDiarizationTurns(s.segments, turns) }));
}

function clearReconnectTimer() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
}

/** Stäm av en stängd session mot brokern (frigör slotet server-side). Best-effort. */
function reconcile(sessionId: string | null) {
    if (!sessionId) return;
    const token = useAuthStore.getState().getToken();
    if (!token) return;
    reconcileLiveSession(sessionId, token).catch(() => { /* stale-prune städar annars */ });
}

function connect(url: string) {
    let socket: WebSocket;
    try {
        socket = new WebSocket(url);
    } catch (e) {
        console.warn("Live-diarize: kunde inte öppna WebSocket:", e);
        onSessionClosed();
        return;
    }
    socket.binaryType = "arraybuffer";
    ws = socket;

    socket.onopen = () => {
        // Sessionens ström startar NU → dess event-timestamps (stream-relativa, Q4) mappas med
        // aktuell ljudposition som bas. Lyckad anslutning nollställer misslyckade-räknaren.
        sessionBaseSec = framesReceived * FRAME_SEC;
        failedReconnects = 0;
    };

    socket.onmessage = (ev) => {
        if (typeof ev.data !== "string") return; // speaker-events är JSON-text; binärt ignoreras
        try {
            const msg = JSON.parse(ev.data);
            if (acc && acc.onEvent(msg, sessionIndex, sessionBaseSec)) applyTurns();
        } catch {
            /* ej JSON → ignorera */
        }
    };

    socket.onerror = () => { /* onclose följer alltid → hantera städning där */ };

    socket.onclose = (ev) => {
        if (ws === socket) ws = null;
        onSessionClosed(ev?.code);
    };
}

/** ws stängdes (1000/1006/1008/timmesgräns). Stäm av slotet; om vi fortfarande spelar in och
 *  gaten håller → minta en NY session och fortsätt (single-use → aldrig återanslutning till
 *  samma id). Annars stanna. */
function onSessionClosed(closeCode?: number) {
    const closedId = currentSessionId;
    currentSessionId = null;
    reconcile(closedId);

    if (!running) return;                 // avsiktligt stopp (stopLive stängde) → ingen omkoppling

    // ── Option A-triggermätning (visibility) ────────────────────────────────
    // Ett OVÄNTAT ws-avbrott medan appen är dold/minimerad = en synlig lucka i live-
    // diariseringen för en minimerad användare (WebView throttlar → frame-forwarding pausar).
    // close_code 1008 = pyannotes 5 s-inaktivitetsdöd (starkaste throttling-indikationen).
    // Aggregeras i PostHog: filtrera hidden=true (+ code 1008) → beslutsunderlag för att
    // flytta ws:en till Rust (Option A). Se arkitekturnoten överst.
    captureEvent("live_diarize_reconnect", {
        hidden: typeof document !== "undefined" && document.hidden,
        close_code: closeCode ?? null,
        session_index: sessionIndex,
        elapsed_sec: Math.round(framesReceived * FRAME_SEC),
    });

    if (!gatesPass()) { stopLive(); return; }
    if (failedReconnects >= MAX_FAILED_RECONNECTS) {
        console.warn("Live-diarize: för många misslyckade omkopplingar → degraderar till batch.");
        stopLive();
        return;
    }
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => { void remint(); }, RECONNECT_DELAY_MS);
}

/** Minta en ny session i kedjan och anslut. Slotbrist/fel → tyst degradering. */
async function remint() {
    reconnectTimer = null;
    if (!running || !gatesPass()) { stopLive(); return; }
    const token = useAuthStore.getState().getToken();
    if (!token) { stopLive(); return; }
    try {
        const res = await mintLiveSession(token);
        if (!res.granted || !res.url || !res.id) {
            captureEvent("live_diarize_degraded", { reason: res.reason || "not_granted" });
            stopLive();
            return;
        }
        currentSessionId = res.id;
        sessionIndex++;             // ny session = nytt etikett-namespace (Q3)
        connect(res.url);
    } catch (e: any) {
        failedReconnects++;
        console.warn("Live-diarize: re-mint misslyckades:", e?.message || e);
        // Schemalägg ett nytt försök om vi fortfarande spelar in (transient nätfel).
        if (running && gatesPass() && failedReconnects < MAX_FAILED_RECONNECTS) {
            clearReconnectTimer();
            reconnectTimer = setTimeout(() => { void remint(); }, RECONNECT_DELAY_MS);
        } else {
            captureEvent("live_diarize_degraded", { reason: "error" });
            stopLive();
        }
    }
}

/** Starta live-diarisering för pågående inspelning. Idempotent. Tyst degradering vid fel. */
async function startLive() {
    if (running) return;
    if (!gatesPass()) return;
    const token = useAuthStore.getState().getToken();
    if (!token) return;

    let res;
    try {
        res = await mintLiveSession(token);
    } catch (e: any) {
        console.warn("Live-diarize: mintning misslyckades:", e?.message || e);
        captureEvent("live_diarize_degraded", { reason: "error" });
        return; // degradera tyst → batchen vid stopp täcker
    }
    if (!res.granted || !res.url || !res.id) {
        // 503 (kill switch) / no_slots → förväntat degraderingsläge.
        captureEvent("live_diarize_degraded", { reason: res.reason || "not_granted" });
        return;
    }
    // Gaten kan ha ändrats under mint-await:en (t.ex. stoppad) → verifiera innan vi rör Rust.
    // Frigör den nyss mintade sessionen (annars hålls ett slot tills lease-prune om vi bailar).
    if (!gatesPass()) {
        reconcile(res.id);
        return;
    }

    running = true;
    framesReceived = 0;
    sessionIndex = 0;
    failedReconnects = 0;
    acc = new LiveDiarizeAccumulator();
    currentSessionId = res.id;
    captureEvent("live_diarize_started", {});
    try {
        await invoke("set_live_diarize_mode", { enabled: true });
    } catch (e: any) {
        console.warn("Live-diarize: set_live_diarize_mode(true) misslyckades:", e?.message || e);
    }
    connect(res.url);
}

/** Stoppa live-diarisering (inspelning stoppad / gate bruten / degradering). Idempotent. */
function stopLive() {
    if (!running && !ws && !currentSessionId) return;
    running = false;
    clearReconnectTimer();

    // Stäng av Rust-emissionen (fire-and-forget — payload är liten och ofarlig om den fallerar).
    invoke("set_live_diarize_mode", { enabled: false }).catch(() => { /* kommando saknas i äldre binär */ });

    const socket = ws;
    ws = null;
    if (socket) {
        try {
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: "end_of_stream" }));
                socket.close(1000);
            } else {
                socket.close();
            }
        } catch { /* redan stängd */ }
    }
    // Stäm av det sista slotet (onclose hann inte om vi stängde själva).
    const id = currentSessionId;
    currentSessionId = null;
    reconcile(id);
    acc = null;
}

export function useLiveDiarize() {
    useEffect(() => {
        // Forwarda Rust-frames till ws:en. Kontinuerligt (inkl. tystnad) — pyannote behöver hela
        // tidslinjen. Frames utan öppen ws (mint-latens / omkoppling) släpps; framesReceived
        // räknar ändå upp så ljud-offset (sessionBaseSec) förblir korrekt.
        const unlistenPromise = listen<{ samples: number[] }>("live-diarize-pcm", (event) => {
            framesReceived++;
            const socket = ws;
            if (socket && socket.readyState === WebSocket.OPEN) {
                const samples = event.payload?.samples;
                if (Array.isArray(samples) && samples.length > 0) {
                    try {
                        socket.send(new Float32Array(samples).buffer);
                    } catch { /* stängd mitt i → nästa frame/omkoppling tar vid */ }
                }
            }
        });

        // Starta/stoppa på inspelningens kant. cloudStreamingActive sätts FÖRE isRecording i
        // control-bar → gaten är läsbar när isRecording blir true.
        const unsub = useSyncStore.subscribe((state, prev) => {
            if (state.isRecording === prev.isRecording) return;
            if (state.isRecording) void startLive();
            else stopLive();
        });

        // Skulle appen mount:a mitt i en pågående inspelning (ovanligt) → starta.
        if (useSyncStore.getState().isRecording) void startLive();

        return () => {
            unsub();
            stopLive();
            unlistenPromise.then((f) => f());
        };
    }, []);
}
