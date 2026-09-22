import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "@/store/settings-store";
import { ChunkHttpError } from "./cloud-chunks";

// Re-export så alla `import { errorSlug } from "@/lib/api"` fungerar; själva funktionen
// bor i en ren fil utan Tauri-beroenden (error-slug.ts) → enhetstestbar i node.
export { errorSlug } from "./error-slug";

export interface Job {
    id: string;
    filename: string;
    status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
    created_at: string;
    retention_policy: string;
    // Analysis fields - returned as a nested object from backend
    analysis?: {
        summary?: string;
        key_decisions?: string[];
        action_items?: string[];
        template_used?: string;
    };
    result?: any;
    error_message?: string;
}

export interface ChunkResult {
    text: string;
    speaker: string;
    start: number | null;
}

/**
 * Live-strömning: POSTar EN kort tal-chunk (WAV-bytes från Rust `cloud-chunk-ready`)
 * till /transcribe-chunk och returnerar molntexten. Synkront, låg-latens. Kastar vid
 * 401/402/429 så anroparen kan hantera auth/kvot.
 */
export async function transcribeChunk(
    audioBytes: ArrayLike<number>,
    speaker: string,
    start: number | null,
    token: string,
): Promise<ChunkResult> {
    const { backendUrl, transcriptionLanguage } = useSettingsStore.getState();
    let baseUrl = backendUrl.replace(/\/$/, "");
    if (!baseUrl.endsWith("/api/v1")) baseUrl = `${baseUrl}/api/v1`;
    const url = `${baseUrl}/transcribe-chunk`;

    const uint8 = audioBytes instanceof Uint8Array ? audioBytes : new Uint8Array(audioBytes as number[]);
    const file = new File([new Blob([uint8], { type: "audio/wav" })], "chunk.wav", { type: "audio/wav" });

    const formData = new FormData();
    formData.append("file", file);
    formData.append("language", transcriptionLanguage ?? "sv");
    formData.append("speaker", speaker);
    if (start != null) formData.append("start", String(start));
    // Ingen monthly_minutes_limit här. Kvoten är ett auktorisationsbeslut och läses
    // server-side ur Clerks public_metadata — en gräns klienten får föreslå är ingen gräns.

    const response = await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` },
        body: formData,
    });

    if (!response.ok) {
        const errText = await response.text();
        let detail = errText;
        try { const p = JSON.parse(errText); if (p.detail) detail = p.detail; } catch { }
        // Status följer med felet, så att kön kan avgöra vad som är värt ett omförsök
        // (cloud-chunks.ts). Meddelandena är oförändrade: felnotisen läser dem.
        if (response.status === 401) throw new ChunkHttpError(`Unauthorized: ${detail}`, 401);
        if (response.status === 402) throw new ChunkHttpError(`Payment Required: ${detail}`, 402);
        if (response.status === 429) throw new ChunkHttpError(`Quota: ${detail}`, 429);
        throw new ChunkHttpError(`Chunk-transkribering misslyckades: ${detail}`, response.status);
    }

    return await response.json();
}

export async function uploadJob(filePath: string, templateId: string = "general", token: string, performAnalysis: boolean = true, persistOverride?: boolean, diarize: boolean = false, numSpeakers?: number, micSpeakers?: number): Promise<Job> {
    const { backendUrl, retentionPolicy, transcriptionLanguage, cloudSync } = useSettingsStore.getState();

    // TODO: Replace localhost with https://api.sagt.ai for production builds. (We will inject this variable during the actual build command).

    // 1. Read file content from Tauri backend
    let fileBytes: number[];
    try {
        fileBytes = await invoke<number[]>("read_audio_file", { path: filePath });
    } catch (error) {
        console.error("Failed to read audio file:", error);
        throw new Error(`Could not read file at ${filePath}: ${error}`);
    }

    // 2. Create Blob/File
    const uint8Array = new Uint8Array(fileBytes);
    const blob = new Blob([uint8Array], { type: "audio/wav" });
    const filename = filePath.split(/[/\\]/).pop() || "session.wav";
    const file = new File([blob], filename, { type: "audio/wav" });

    // 3. Prepare FormData
    const formData = new FormData();
    formData.append("file", file);
    formData.append("retention_policy", retentionPolicy);
    formData.append("template_id", templateId);
    formData.append("perform_analysis", String(performAnalysis));
    formData.append("language", transcriptionLanguage ?? "sv");
    // Opt-in molnsynk: persist=true → resultatet sparas i molnet (dashboard). Default av →
    // backend returnerar resultatet inline och raderar jobbet (inget moln-spår).
    formData.append("persist", String(persistOverride ?? cloudSync));
    // Fas 2: talarseparering (opt-in, Pro). Skickas bara när påslaget → gamla beteendet
    // oförändrat annars. Backend ignorerar tyst om DIARIZE_ENABLED=false i miljön.
    if (diarize) formData.append("diarize", "true");
    if (numSpeakers && numSpeakers > 0) formData.append("num_speakers", String(numSpeakers));
    // §13.4: DU/mik-kanalens talarantal (stereo) — desktop skickar 1 (ensam vid mikrofonen)
    // som default → ingen Du 1/Du 2-översegmentering. Skickas bara vid diarisering.
    if (diarize && micSpeakers && micSpeakers > 0) formData.append("mic_speakers", String(micSpeakers));

    // 4. Upload
    // Ensure backendUrl doesn't have trailing slash if we add one, or handle it
    let baseUrl = backendUrl.replace(/\/$/, "");

    // STRICTLY ensure /api/v1 suffix
    if (!baseUrl.endsWith("/api/v1")) {
        // If the user already pasted /api/v1 just ensure we don't double it (handled by check above)
        // Check if it ends with /api (without v1) logic? No, just straightforward append if missing.
        // User might have entered "backend.com/api" -> "backend.com/api/api/v1" - hopefully not often.
        // Let's assume user enters base domain or full api path.
        // But the requirement is explicit: "strictly verify that the resulting string is [BASE_URL]/api/v1"
        baseUrl = `${baseUrl}/api/v1`;
    }

    const url = `${baseUrl}/jobs`;

    console.log(`[Upload] Uploading to: ${url}`);
    console.debug(`[Upload] Backend URL determined as: ${baseUrl}`);

    const headers: HeadersInit = {
        "Authorization": `Bearer ${token}`
    };

    try {
        const response = await fetch(url, {
            method: "POST",
            headers,
            body: formData,
        });

        if (!response.ok) {
            const errorText = await response.text();
            let parsedError = errorText;
            try {
                const parsed = JSON.parse(errorText);
                if (parsed.detail) parsedError = parsed.detail;
            } catch (e) { }

            if (response.status === 401) {
                throw new Error(`Unauthorized: ${parsedError}`);
            }
            if (response.status === 402) {
                throw new Error(`Payment Required: Denna funktion kräver Pro. Vänligen uppgradera via webbportalen.`);
            }
            throw new Error(`Kunde inte ladda upp: ${parsedError}`);
        }

        return await response.json();
    } catch (error: any) {
        console.error("🔥 API Upload Error:", error);
        if (error.response) {
            console.error("Response data:", error.response.data);
        }

        if (error instanceof Error && error.message.startsWith("Unauthorized")) {
            throw error;
        }
        if (error instanceof Error && error.message.includes("Payment Required")) {
            throw error;
        }

        if (error instanceof TypeError && error.message.includes("Failed to fetch")) {
            throw new Error(`Kunde inte nå servern på "${baseUrl}". Kontrollera att servern är igång och att URL:en i inställningar är korrekt.`);
        }

        throw new Error(`Upload failed: ${error?.name} - ${error?.message}`);
    }
}

export async function getJob(jobId: string, token: string): Promise<Job> {
    const { backendUrl } = useSettingsStore.getState();

    // Ensure URL construction matches uploadJob logic
    let baseUrl = backendUrl.replace(/\/$/, "");
    if (!baseUrl.endsWith("/api/v1")) {
        baseUrl = `${baseUrl}/api/v1`;
    }

    const url = `${baseUrl}/jobs/${jobId}`;

    const headers: HeadersInit = {
        "Authorization": `Bearer ${token}`
    };

    try {
        const response = await fetch(url, {
            method: "GET",
            headers,
        });

        if (!response.ok) {
            const errorText = await response.text();
            let parsedError = errorText;
            try {
                const parsed = JSON.parse(errorText);
                if (parsed.detail) parsedError = parsed.detail;
            } catch (e) { }

            if (response.status === 402) {
                throw new Error(`Payment Required: Denna funktion kräver Pro. Vänligen uppgradera via webbportalen.`);
            }
            throw new Error(`Misslyckades att hämta jobb: ${parsedError}`);
        }

        return await response.json();
    } catch (error) {
        console.error("Failed to fetch job:", error);
        throw error;
    }
}

/**
 * Kör om analysen på ett SYNKAT moln-jobb. Backend uppdaterar job.analysis i Firestore
 * → dashboard speglar senaste versionen. Använd endast för persisterade jobb (cloud_job_id).
 * Osynkade/lokala jobb använder reanalyzeTranscript (stateless).
 */
export async function reanalyzeJob(jobId: string, templateId: string = "general", token: string): Promise<Job> {
    const { backendUrl } = useSettingsStore.getState();
    let baseUrl = backendUrl.replace(/\/$/, "");
    if (!baseUrl.endsWith("/api/v1")) {
        baseUrl = `${baseUrl}/api/v1`;
    }
    const url = `${baseUrl}/jobs/${jobId}/reanalyze`;

    const formData = new FormData();
    formData.append("template_id", templateId);

    const response = await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` },
        body: formData,
    });

    if (!response.ok) {
        const errorText = await response.text();
        let parsedError = errorText;
        try { const p = JSON.parse(errorText); if (p.detail) parsedError = p.detail; } catch (e) { }
        if (response.status === 401) throw new Error(`Unauthorized: ${parsedError}`);
        if (response.status === 402) throw new Error(`Payment Required: Denna funktion kräver Pro.`);
        throw new Error(`Re-analys (moln) misslyckades: ${parsedError}`);
    }

    return await response.json();
}

export async function reanalyzeTranscript(text: string, templateId: string = "general", token: string): Promise<any> {
    const { backendUrl } = useSettingsStore.getState();

    let baseUrl = backendUrl.replace(/\/$/, "");
    if (!baseUrl.endsWith("/api/v1")) {
        baseUrl = `${baseUrl}/api/v1`;
    }
    const url = `${baseUrl}/analyze`;

    const headers: HeadersInit = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
    };

    try {
        const response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({ text, template_id: templateId }),
        });

        if (!response.ok) {
            const errorText = await response.text();
            let parsedError = errorText;
            try {
                const parsed = JSON.parse(errorText);
                if (parsed.detail) parsedError = parsed.detail;
            } catch (e) { }

            if (response.status === 401) {
                throw new Error(`Unauthorized: ${parsedError}`);
            }
            if (response.status === 402) {
                throw new Error(`Payment Required: Denna funktion kräver Pro. Vänligen uppgradera via webbportalen.`);
            }
            throw new Error(`Re-analys misslyckades: ${parsedError}`);
        }

        return await response.json();
    } catch (error: any) {
        console.error("🔥 API Reanalyze Error:", error);
        if (error.response) {
            console.error("Response data:", error.response.data);
        }

        if (error instanceof Error && error.message.startsWith("Unauthorized")) {
            throw error;
        }
        if (error instanceof Error && error.message.includes("Payment Required")) {
            throw error;
        }

        throw error;
    }
}

// ─── Talaridentifiering (Fas 1 — tilltalsnamn ovanpå Du/Mötet) ───────────────
export interface SpeakerTurn {
    speaker: string;
    text: string;
    start: number | null;
}

/**
 * Icke-förstörande FÖRSLAG: backend rör aldrig turerna. speaker_map: etikett → namn;
 * en utelämnad etikett behåller sitt originalnamn i UI:t. confidence: etikett → 0..1.
 */
export interface IdentifySpeakersResult {
    speaker_map: Record<string, string>;
    confidence: Record<string, number>;
}

/**
 * POSTar turbaserat transkript + valfria deltagar-hints till /identify-speakers (Pro-gatad
 * under pro_router) → LLM-infererad namnmappning. Kastar vid 401/402/413 så anroparen kan
 * hantera auth/Pro/storlek. Speglar reanalyzeTranscript (JSON-body, Bearer-token).
 */
export async function identifySpeakers(
    turns: SpeakerTurn[],
    participantHints: string[],
    token: string,
): Promise<IdentifySpeakersResult> {
    const { backendUrl } = useSettingsStore.getState();
    let baseUrl = backendUrl.replace(/\/$/, "");
    if (!baseUrl.endsWith("/api/v1")) baseUrl = `${baseUrl}/api/v1`;
    const url = `${baseUrl}/identify-speakers`;

    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({ turns, participant_hints: participantHints }),
    });

    if (!response.ok) {
        const errText = await response.text();
        let detail = errText;
        try { const p = JSON.parse(errText); if (p.detail) detail = p.detail; } catch { }
        if (response.status === 401) throw new Error(`Unauthorized: ${detail}`);
        if (response.status === 402) throw new Error(`Payment Required: ${detail}`);
        if (response.status === 413) throw new Error(`För stort: ${detail}`);
        throw new Error(`Talaridentifiering misslyckades: ${detail}`);
    }

    return await response.json();
}

// ─── Diarisering utan transkribering (STEG 4 — auto-diarisering vid stopp) ────
/** En akustisk tur (ingen text) från MÖTET-kanalen. speaker = "MÖTET" (1 talare) eller
 *  "MÖTET 1".."MÖTET N" (relabel_channel, §3.2); channel alltid "right". */
export interface DiarizeTurn {
    start: number;
    end: number;
    speaker: string;
    channel: string;
}

/**
 * POSTar MÖTET-kanalen (mono-WAV, extraherad i Rust) till /diarize (diarize-only, Pro-gatad
 * under pro_router) → färdig-omdöpta akustiska turer. INGEN transkribering, INGEN kvot,
 * INGET lagrat ljud. Anroparen (auto-finalize) mappar turerna på de
 * redan strömmade segmenten via `applyDiarizationTurns`.
 *
 * Läser filen via samma Rust-väg som `uploadJob` (`read_audio_file`), som är storlekstät på
 * mono-MÖTET (≈110 MB/h). Kastar vid 401/402/413 + 503 (kill switch) så anroparen kan
 * degradera tyst till DU/MÖTET. Speglar `identifySpeakers` felhantering.
 */
export async function diarizeMeeting(monoWavPath: string, token: string): Promise<DiarizeTurn[]> {
    // 1. Läs mono-WAV via Rust (samma väg som uploadJob — vägrar sökvägar utanför app data).
    let fileBytes: number[];
    try {
        fileBytes = await invoke<number[]>("read_audio_file", { path: monoWavPath });
    } catch (error) {
        throw new Error(`Kunde inte läsa mono-WAV: ${error}`);
    }

    const uint8 = new Uint8Array(fileBytes);
    const file = new File([new Blob([uint8], { type: "audio/wav" })], "meeting.wav", { type: "audio/wav" });
    const formData = new FormData();
    formData.append("file", file);

    const { backendUrl } = useSettingsStore.getState();
    let baseUrl = backendUrl.replace(/\/$/, "");
    if (!baseUrl.endsWith("/api/v1")) baseUrl = `${baseUrl}/api/v1`;
    const url = `${baseUrl}/diarize`;

    const response = await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` },
        body: formData,
    });

    if (!response.ok) {
        const errText = await response.text();
        let detail = errText;
        try { const p = JSON.parse(errText); if (p.detail) detail = p.detail; } catch { }
        if (response.status === 401) throw new Error(`Unauthorized: ${detail}`);
        if (response.status === 402) throw new Error(`Payment Required: ${detail}`);
        if (response.status === 413) throw new Error(`För stort: ${detail}`);
        if (response.status === 503) throw new Error(`Otillgänglig: ${detail}`);
        throw new Error(`Diarisering misslyckades: ${detail}`);
    }

    const data = await response.json();
    return Array.isArray(data?.turns) ? data.turns : [];
}

// ─── Live-diarisering session-broker (STEG 3 — pyannoteAI Live-1) ─────────────
/** Svar från broker-mintningen. `granted:true` bär `id`+`url` (desktop ansluter ws:en
 *  direkt); `granted:false` bär `reason` (kapacitet/kill switch → degradera tyst till
 *  steg 4-batchen). Diskriminerad — spegla backend `LiveSessionResponse`. */
export interface LiveSessionResponse {
    granted: boolean;
    id: string | null;
    url: string | null;
    reason: string | null;
}

/**
 * Mintar en pyannote Live-1-session via brokern (`POST /live-diarize`, Pro-gatad). Brokern
 * håller API-nyckeln server-side och returnerar bara den pre-signerade ws-URL:en. Kill switch
 * av (503) → returnerar `{granted:false, reason:"disabled"}` (ett förväntat degraderingsläge,
 * inte ett fel). Övriga icke-2xx → kastar så anroparen kan degradera tyst till batchen.
 */
export async function mintLiveSession(token: string): Promise<LiveSessionResponse> {
    const { backendUrl } = useSettingsStore.getState();
    let baseUrl = backendUrl.replace(/\/$/, "");
    if (!baseUrl.endsWith("/api/v1")) baseUrl = `${baseUrl}/api/v1`;
    const url = `${baseUrl}/live-diarize`;

    const response = await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` },
    });

    // 503 = kill switch av, 429 = anti-abuse-tak (delas med /jobs+/diarize) → båda är
    // förväntade degraderingslägen (inte undantag). Klienten degraderar tyst till batchen;
    // `reason` gör anledningen synlig i PostHog (live_diarize_degraded).
    if (response.status === 503) return { granted: false, id: null, url: null, reason: "disabled" };
    if (response.status === 429) return { granted: false, id: null, url: null, reason: "rate_limited" };

    if (!response.ok) {
        const errText = await response.text();
        let detail = errText;
        try { const p = JSON.parse(errText); if (p.detail) detail = p.detail; } catch { }
        if (response.status === 401) throw new Error(`Unauthorized: ${detail}`);
        if (response.status === 402) throw new Error(`Payment Required: ${detail}`);
        throw new Error(`Live-mintning misslyckades: ${detail}`);
    }

    return await response.json();
}

/**
 * Stämmer av en live-session efter ws-close (`GET /live-diarize/{id}`) → brokern frigör slotet
 * om sessionen är terminal. Klienten kan inte nå pyannotes status själv (kräver API-nyckeln).
 * Best-effort: fel sväljs av anroparen (slotet städas ändå av broker-liggarens stale-prune).
 */
export async function reconcileLiveSession(sessionId: string, token: string): Promise<{ status: string; active: boolean }> {
    const { backendUrl } = useSettingsStore.getState();
    let baseUrl = backendUrl.replace(/\/$/, "");
    if (!baseUrl.endsWith("/api/v1")) baseUrl = `${baseUrl}/api/v1`;
    const url = `${baseUrl}/live-diarize/${encodeURIComponent(sessionId)}`;

    const response = await fetch(url, {
        method: "GET",
        headers: { "Authorization": `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Live-reconcile misslyckades (${response.status}).`);
    return await response.json();
}
