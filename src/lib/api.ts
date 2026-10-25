import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "@/store/settings-store";
import { ChunkHttpError } from "./cloud-chunks";
import { analyzeErrorFrom, parseEntitlements, parseQuotaExhausted, type EntitlementsResponse, type OfflineAllowance, type QuotaExhaustedInfo } from "./entitlements";
import { MAX_UPLOAD_FILE_BYTES, uploadTooLargeMessage, uploadTooLongMessage } from "./upload-limits";
import { onceReporter, outcomeForStatus, wavInfo, type CloudUploadPath } from "./cloud-upload-outcome";
import { captureEvent } from "@/hooks/use-posthog-events";
import { useAuthStore } from "@/store/auth-store";
import { useConfigStore } from "@/store/config-store";

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
    // Fält som läses explicit: `analysis_failed` sätts av servern när transkriptet blev klart
    // men AI-analysen inte (Berget nere eller modellen borta). `analysis` är då null.
    result?: { analysis_failed?: boolean; [key: string]: any };
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

/** Planen som egenskap i uppladdningseventet. Ingen grind: servern avgör vem som får ladda upp. */
function currentPlan(): "pro" | "free" {
    return useAuthStore.getState().isPro() ? "pro" : "free";
}

/** Rapportör för `cloud_upload_outcome`, ett event per försök. Se cloud-upload-outcome.ts. */
function uploadReporter(path: CloudUploadPath, fileBytes: ArrayLike<number>) {
    return onceReporter(captureEvent, {
        path,
        sizeBytes: fileBytes.length,
        info: wavInfo(fileBytes),
        plan: currentPlan(),
    });
}

/** Formulärfälten till POST /jobs utöver filen. Samma för Opus-vägen och WAV-vägen. */
function jobFields(templateId: string, performAnalysis: boolean, persistOverride: boolean | undefined, diarize: boolean, numSpeakers?: number, micSpeakers?: number): [string, string][] {
    const { retentionPolicy, transcriptionLanguage, cloudSync } = useSettingsStore.getState();
    const fields: [string, string][] = [
        ["retention_policy", retentionPolicy],
        ["template_id", templateId],
        ["perform_analysis", String(performAnalysis)],
        ["language", transcriptionLanguage ?? "sv"],
        // Opt-in molnsynk: persist=true → resultatet sparas i molnet (dashboard). Default av →
        // backend returnerar resultatet inline och raderar jobbet (inget moln-spår).
        ["persist", String(persistOverride ?? cloudSync)],
    ];
    // Fas 2: talarseparering (opt-in, Pro). Skickas bara när påslaget → gamla beteendet
    // oförändrat annars. Servern ignorerar tyst `diarize` när omtranskribering med talare är avstängd.
    if (diarize) fields.push(["diarize", "true"]);
    if (numSpeakers && numSpeakers > 0) fields.push(["num_speakers", String(numSpeakers)]);
    // §13.4: DU/mik-kanalens talarantal (stereo) — desktop skickar 1 (ensam vid mikrofonen)
    // som default → ingen Du 1/Du 2-översegmentering. Skickas bara vid diarisering.
    if (diarize && micSpeakers && micSpeakers > 0) fields.push(["mic_speakers", String(micSpeakers)]);
    return fields;
}

function apiBaseUrl(): string {
    const baseUrl = useSettingsStore.getState().backendUrl.replace(/\/$/, "");
    return baseUrl.endsWith("/api/v1") ? baseUrl : `${baseUrl}/api/v1`;
}

function unreachable(baseUrl: string): Error {
    return new Error(`Kunde inte nå servern på "${baseUrl}". Kontrollera att servern är igång och att URL:en i inställningar är korrekt.`);
}

/** Felet för ett svar som inte är 2xx. Texterna läses av errorSlug och av anroparna. */
function jobHttpError(status: number, body: string): Error {
    let detail = body;
    try {
        const parsed = JSON.parse(body);
        if (parsed.detail) detail = parsed.detail;
    } catch { }
    if (status === 401) return new Error(`Unauthorized: ${detail}`);
    if (status === 402) return new Error(`Payment Required: Denna funktion kräver Pro. Vänligen uppgradera via webbportalen.`);
    // Serverns längdtak svarar 413 med en text som redan börjar med "För långt:".
    if (status === 413) return new Error(/^För långt:/.test(detail) ? detail : `För stort: ${detail}`);
    return new Error(`Kunde inte ladda upp: ${detail}`);
}

/** Svaret från Rust-kommandot `upload_cloud_audio`. */
interface CloudUploadResult {
    outcome: "sent" | "blocked_size" | "blocked_duration";
    status: number;
    body: string;
    format: string;
    size_bytes: number;
    duration_secs: number;
    channels: number;
    /** Bitraten per kanal när filen skickades som Opus, 0 när den skickades som WAV. */
    opus_bitrate: number;
}

/**
 * Laddar upp en inspelning till POST /jobs från Rust. Servern bestämmer formatet
 * (`cloudUploadPolicy`): alltid WAV, Opus bara när WAV-filen inte ryms, eller alltid Opus,
 * och bitraten. Kan filen inte läsas av kodaren (ett format äldre versioner skrev) skickas
 * WAV-filen från webbvyn som förut.
 *
 * `path` först och utan standardvärde: en ny anropare kan inte glömma att säga var den laddar upp ifrån.
 */
export async function uploadJob(path: CloudUploadPath, filePath: string, templateId: string = "general", token: string, performAnalysis: boolean = true, persistOverride?: boolean, diarize: boolean = false, numSpeakers?: number, micSpeakers?: number): Promise<Job> {
    const fields = jobFields(templateId, performAnalysis, persistOverride, diarize, numSpeakers, micSpeakers);
    const baseUrl = apiBaseUrl();
    const plan = currentPlan();
    const { maxCloudJobMinutes: maxMinutes, uploadPolicy } = useConfigStore.getState();

    let r: CloudUploadResult;
    try {
        r = await invoke<CloudUploadResult>("upload_cloud_audio", {
            path: filePath, url: `${baseUrl}/jobs`, token, fields,
            maxBytes: MAX_UPLOAD_FILE_BYTES, maxMinutes,
            opusBitratePerChannel: uploadPolicy.opusBitratePerChannel,
            wavWhenFits: uploadPolicy.onlyWhenNeeded,
        });
    } catch (error) {
        const msg = String(error);
        if (msg.startsWith("UNSUPPORTED:")) {
            console.warn("[Upload] Filen kan inte kodas till Opus, skickar WAV:", msg);
            return uploadJobWav(path, filePath, token, fields, baseUrl);
        }
        if (msg.startsWith("NETWORK:")) {
            onceReporter(captureEvent, { path, sizeBytes: 0, info: { format: "unknown", channels: null, durationSec: null }, plan, policySource: uploadPolicy.source })("failed_network");
            throw unreachable(baseUrl);
        }
        throw new Error(`Uppladdningen misslyckades: ${msg}`);
    }

    const report = onceReporter(captureEvent, {
        path,
        sizeBytes: r.size_bytes,
        info: { format: r.format, channels: r.channels || null, durationSec: r.duration_secs },
        plan,
        opusBitrate: r.opus_bitrate || null,
        policySource: uploadPolicy.source,
    });
    if (r.outcome === "blocked_duration") {
        report("blocked_duration");
        throw new Error(uploadTooLongMessage(r.duration_secs, maxMinutes));
    }
    if (r.outcome === "blocked_size") {
        report("blocked_size");
        throw new Error(uploadTooLargeMessage(r.size_bytes) ?? `För stort: ${r.size_bytes} byte`);
    }
    report(outcomeForStatus(r.status), r.status);
    if (r.status < 200 || r.status >= 300) throw jobHttpError(r.status, r.body);
    try {
        return JSON.parse(r.body) as Job;
    } catch {
        throw new Error("Kunde inte ladda upp: oväntat svar från servern.");
    }
}

/** WAV-vägen: filen läses till webbvyn och skickas därifrån, med molnets storlekstak (~8 min stereo). */
async function uploadJobWav(path: CloudUploadPath, filePath: string, token: string, fields: [string, string][], baseUrl: string): Promise<Job> {
    let fileBytes: number[];
    try {
        fileBytes = await invoke<number[]>("read_audio_file", { path: filePath });
    } catch (error) {
        console.error("Failed to read audio file:", error);
        throw new Error(`Could not read file at ${filePath}: ${error}`);
    }
    // Före uppladdningen: över taket avvisas anropet med ett svar som webbvyn inte får läsa, och
    // fetch kastar då "Failed to fetch", som nedan blir "Kunde inte nå servern".
    const report = uploadReporter(path, fileBytes);
    const tooLarge = uploadTooLargeMessage(fileBytes.length);
    if (tooLarge) {
        report("blocked_size");
        throw new Error(tooLarge);
    }

    const filename = filePath.split(/[/\\]/).pop() || "session.wav";
    const file = new File([new Blob([new Uint8Array(fileBytes)], { type: "audio/wav" })], filename, { type: "audio/wav" });
    const formData = new FormData();
    formData.append("file", file);
    for (const [k, v] of fields) formData.append(k, v);

    let response: Response;
    try {
        response = await fetch(`${baseUrl}/jobs`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}` },
            body: formData,
        });
    } catch (error: any) {
        console.error("🔥 API Upload Error:", error);
        report("failed_network");
        if (error instanceof TypeError && error.message.includes("Failed to fetch")) throw unreachable(baseUrl);
        throw new Error(`Upload failed: ${error?.name} - ${error?.message}`);
    }
    report(outcomeForStatus(response.status), response.status);
    if (!response.ok) throw jobHttpError(response.status, await response.text());
    return await response.json();
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
 * Kör om analysen på ett SYNKAT moln-jobb. Backend uppdaterar det sparade jobbets analys
 * → dashboard speglar senaste versionen. Använd endast för persisterade jobb (cloud_job_id).
 * Osynkade/lokala jobb använder reanalyzeTranscript (stateless).
 */
/**
 * Molnjobbet finns inte (404): TTL har raderat det efter 90 dagar, eller användaren har raderat
 * det i webben. Backend svarar likadant för ett jobb som tillhör någon annan.
 */
export class CloudJobNotFoundError extends Error {
    constructor(detail: string) {
        super(`Re-analys (moln) misslyckades: ${detail}`);
        this.name = "CloudJobNotFoundError";
    }
}

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
        if (response.status === 404) throw new CloudJobNotFoundError(parsedError);
        throw new Error(`Re-analys (moln) misslyckades: ${parsedError}`);
    }

    return await response.json();
}

/**
 * Stateless protokoll på en text. Ett gratiskonto skickar `X-Idempotency-Key` (en per
 * avsiktlig begäran, samma vid omförsök): servern räknar då protokollet i kvoten en gång,
 * även om svaret går förlorat och begäran görs om. Pro räknas aldrig, så nyckeln skadar
 * inte där. Kastar `AnalyzeHttpError` vid icke-2xx (status, kvotfält och 409-kod).
 */
export async function reanalyzeTranscript(
    text: string,
    templateId: string = "general",
    token: string,
    opts: { idempotencyKey?: string; naming?: ProtocolNaming } = {},
): Promise<any> {
    const url = `${apiBase()}/analyze`;
    // Namnförslag i samma anrop: servern svarar då också med speaker_map, confidence och
    // speaker_groups. En äldre server ignorerar fälten och svarar som förut.
    const body: Record<string, unknown> = { text, template_id: templateId };
    if (opts.naming && opts.naming.turns.length > 0 && namingChars(opts.naming) <= PROTOCOL_NAMING_MAX_CHARS) {
        body.turns = opts.naming.turns;
        body.participant_hints = opts.naming.participantHints;
        body.name_speakers = true;
    }

    const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`
    };
    if (opts.idempotencyKey) headers["X-Idempotency-Key"] = opts.idempotencyKey;

    let response: Response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
        });
    } catch (error: any) {
        console.error("🔥 API Reanalyze Error:", error);
        throw error;
    }

    if (!response.ok) {
        const err = analyzeErrorFrom(response.status, response.headers.get("X-Error-Code"), await response.text());
        console.error("🔥 API Reanalyze Error:", err.message);
        throw err;
    }

    return await response.json();
}

/**
 * Planen och gratiskvoternas räknare för det inloggade kontot. Kräver inloggning men
 * inte Pro. Kastar vid icke-2xx; anroparen behåller då sin senaste bild.
 */
export async function getEntitlements(token: string): Promise<EntitlementsResponse> {
    const response = await fetch(`${apiBase()}/entitlements`, {
        method: "GET",
        headers: { "Authorization": `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Kunde inte hämta kvoterna (${response.status}).`);
    return parseEntitlements(await response.json());
}

const ENTITLEMENT_TIMEOUT_MS = 10_000;

/** Svaret från en förbrukning eller avstämning som inte är ett nätfel. */
export type EntitlementCallOutcome =
    | { kind: "ok"; body: EntitlementsResponse }
    | { kind: "exhausted"; quota: QuotaExhaustedInfo | null }
    | { kind: "error"; status: number; detail: string };

async function entitlementOutcome(response: Response): Promise<EntitlementCallOutcome> {
    const text = await response.text();
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { /* inte JSON */ }
    if (response.ok) return { kind: "ok", body: parseEntitlements(body) };
    if (response.status === 402) return { kind: "exhausted", quota: parseQuotaExhausted(body) };
    const d = (body as { detail?: unknown } | null)?.detail;
    return { kind: "error", status: response.status, detail: typeof d === "string" ? d : text };
}

/**
 * Dra en enhet för en handling som görs i appen (export). Samma nyckel igen drar inget
 * nytt. Kastar bara när servern inte gick att nå; alla svar blir ett utfall.
 */
export async function consumeEntitlement(kind: string, key: string, token: string): Promise<EntitlementCallOutcome> {
    const response = await fetch(`${apiBase()}/entitlements/consume`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ kind, key }),
        // Ett nät som hänger (portal, tappad uppkoppling) ska ge offline-vägen, inte en
        // export som väntar för evigt.
        signal: AbortSignal.timeout(ENTITLEMENT_TIMEOUT_MS),
    });
    return entitlementOutcome(response);
}

/** Bokför exporter som gjorts utan nätverk mot förskottet de drogs från. Kastar vid nätfel. */
export async function reconcileEntitlements(allowance: OfflineAllowance, keys: string[], token: string): Promise<EntitlementCallOutcome> {
    const response = await fetch(`${apiBase()}/entitlements/reconcile`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
        body: JSON.stringify({ allowance, keys }),
        signal: AbortSignal.timeout(ENTITLEMENT_TIMEOUT_MS),
    });
    return entitlementOutcome(response);
}

function apiBase(): string {
    const { backendUrl } = useSettingsStore.getState();
    let baseUrl = backendUrl.replace(/\/$/, "");
    if (!baseUrl.endsWith("/api/v1")) baseUrl = `${baseUrl}/api/v1`;
    return baseUrl;
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
    /** Flera namngivna personer på samma kanal: etikett → två till fyra namn. Saknas hos
     *  äldre servrar. En etikett står aldrig i både speaker_map och speaker_groups. */
    speaker_groups?: Record<string, string[]>;
}

/** Underlaget för namnförslag när protokollet skapas: turerna med talaretiketter, och
 *  deltagarlistan ur "Vilka är med?". */
export interface ProtocolNaming {
    turns: SpeakerTurn[];
    participantHints: string[];
}

/** Servern tar emot högst så här många tecken (turernas text och etiketter plus
 *  deltagarlistan) för namnförslag. Över det skickas protokollet utan namnförslag, så att ett
 *  långt möte fortfarande får sitt protokoll. */
export const PROTOCOL_NAMING_MAX_CHARS = 250_000;

export function namingChars(naming: ProtocolNaming): number {
    return naming.turns.reduce((n, t) => n + t.text.length + t.speaker.length, 0)
        + naming.participantHints.reduce((n, h) => n + h.length, 0);
}

/**
 * POSTar turbaserat transkript + valfria deltagar-hints till /identify-speakers (kräver
 * Pro) → LLM-infererad namnmappning. Kastar vid 401/402/413 så anroparen kan
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
 * POSTar MÖTET-kanalen (mono-WAV, extraherad i Rust) till /diarize (diarize-only, kräver
 * Pro) → färdig-omdöpta akustiska turer. INGEN transkribering, INGEN kvot,
 * INGET lagrat ljud. Anroparen (auto-finalize) mappar turerna på de
 * redan strömmade segmenten via `applyDiarizationTurns`.
 *
 * Läser filen via samma Rust-väg som `uploadJob` (`read_audio_file`). Mono-MÖTET är
 * ≈110 MB/h, så molnets tak (upload-limits.ts) räcker till ungefär 17 minuter. Kastar vid 401/402/413 + 503 (kill switch) så anroparen kan
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
    // Samma tak som uploadJob. Kastar med prefixet "För stort" som ett 413 → anroparen degraderar.
    // Eventet gäller bara uppladdningen; talaridentifieringens eget utfall har ett eget event.
    const report = uploadReporter("desktop_diarize_stop", fileBytes);
    const tooLarge = uploadTooLargeMessage(fileBytes.length);
    if (tooLarge) {
        report("blocked_size");
        throw new Error(tooLarge);
    }

    const uint8 = new Uint8Array(fileBytes);
    const file = new File([new Blob([uint8], { type: "audio/wav" })], "meeting.wav", { type: "audio/wav" });
    const formData = new FormData();
    formData.append("file", file);

    const { backendUrl } = useSettingsStore.getState();
    let baseUrl = backendUrl.replace(/\/$/, "");
    if (!baseUrl.endsWith("/api/v1")) baseUrl = `${baseUrl}/api/v1`;
    const url = `${baseUrl}/diarize`;

    let response: Response;
    try {
        response = await fetch(url, {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}` },
            body: formData,
        });
    } catch (e) {
        report("failed_network");
        throw e;
    }
    report(outcomeForStatus(response.status), response.status);

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
