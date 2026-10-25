// Ett event per uppladdningsförsök till molnet: `cloud_upload_outcome`.
//
// `error_shown` räknar visade fel. Det här räknar också försöken som lyckas, så att andelen
// som stoppas av storlekstaket går att följa före och efter att Opus-kodningen kommer.
// Egenskaperna beskriver filen, aldrig innehållet: storlek, längd, format, kanaler och plan.
// Inga filnamn och inga sökvägar, eftersom de kan bära mötets namn.
//
// Ren modul utan Tauri- eller store-beroenden, så att den går att testa i node.

/** Var uppladdningen startade. Webben har egna värden (`web_upload`, `web_recording`). */
export type CloudUploadPath =
    | "desktop_retranscribe"   // "Transkribera i molnet" i mötesvyn
    | "desktop_autosync"       // automatisk uppladdning efter inspelning
    | "desktop_sync_list"      // "Synka" under Inspelningar
    | "desktop_diarize_stop";  // MÖTET-kanalen till talaridentifieringen vid Stopp

export type CloudUploadOutcome =
    | "ok"
    | "blocked_size"       // stoppad av storlekstaket, före anropet eller som 413 från servern
    | "blocked_duration"   // stoppad av längdtaket (finns först när taket ligger i /system/config)
    | "failed_network"     // inget svar alls, till exempel offline eller ett avvisat anrop utan läsbart svar
    | "failed_server"      // annat svar än 2xx och 413; http_status säger vilket
    | "failed_gcs";        // direktuppladdning till lagringen misslyckades (signerad väg)

export type CloudUploadMechanism = "multipart" | "signed_url";

export interface AudioInfo {
    format: string;
    channels: number | null;
    durationSec: number | null;
}

const UNKNOWN: AudioInfo = { format: "unknown", channels: null, durationSec: null };

function u32le(b: ArrayLike<number>, i: number): number {
    return (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 0x1000000;
}

function u16le(b: ArrayLike<number>, i: number): number {
    return b[i] | (b[i + 1] << 8);
}

function tag(b: ArrayLike<number>, i: number): string {
    return String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]);
}

/**
 * Format, kanaler och längd ur en WAV-fils huvud. Längden räknas ur filens storlek efter
 * `data`-blockets början, inte ur blockets angivna storlek: en sessionsfil som inte stängts
 * ordentligt kan ha kvar platshållaren i huvudet. Allt som inte är en läsbar RIFF/WAVE ger
 * `format: "unknown"` utan längd, hellre än en gissning.
 */
export function wavInfo(bytes: ArrayLike<number>): AudioInfo {
    if (bytes.length < 12 || tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE") return UNKNOWN;
    let channels: number | null = null;
    let byteRate = 0;
    let i = 12;
    while (i + 8 <= bytes.length) {
        const id = tag(bytes, i);
        const size = u32le(bytes, i + 4);
        const body = i + 8;
        if (id === "fmt " && body + 16 <= bytes.length) {
            channels = u16le(bytes, body + 2);
            byteRate = u32le(bytes, body + 8);
        } else if (id === "data") {
            if (!channels || !byteRate) return { format: "wav", channels, durationSec: null };
            return { format: "wav", channels, durationSec: Math.max(bytes.length - body, 0) / byteRate };
        }
        // RIFF-block är jämnt justerade: en udda storlek följs av en utfyllnadsbyte.
        i = body + size + (size & 1);
    }
    return { format: "wav", channels, durationSec: null };
}

export interface CloudUploadOutcomeProps {
    path: CloudUploadPath;
    outcome: CloudUploadOutcome;
    mechanism: CloudUploadMechanism;
    size_mb: number;
    duration_min: number | null;
    format: string;
    channels: number | null;
    plan: "pro" | "free";
    http_status: number | null;
    // Bitrate per kanal när filen skickades som Opus, annars null.
    opus_bitrate: number | null;
    // Om serverns val gällde eller klientens reservläge (ett saknat eller ogiltigt fält).
    policy_source: "server" | "fallback" | null;
}

/** Utfallet för ett svar från servern. 413 är storlekstaket även när servern säger det. */
export function outcomeForStatus(status: number): CloudUploadOutcome {
    if (status >= 200 && status < 300) return "ok";
    if (status === 413) return "blocked_size";
    return "failed_server";
}

export function cloudUploadOutcomeProps(args: {
    path: CloudUploadPath;
    outcome: CloudUploadOutcome;
    sizeBytes: number;
    info: AudioInfo;
    plan: "pro" | "free";
    httpStatus?: number | null;
    mechanism?: CloudUploadMechanism;
    opusBitrate?: number | null;
    policySource?: "server" | "fallback" | null;
}): CloudUploadOutcomeProps {
    const { info } = args;
    return {
        path: args.path,
        outcome: args.outcome,
        mechanism: args.mechanism ?? "multipart",
        size_mb: Math.round((args.sizeBytes / (1024 * 1024)) * 100) / 100,
        duration_min: info.durationSec == null ? null : Math.round((info.durationSec / 60) * 10) / 10,
        format: info.format,
        channels: info.channels,
        plan: args.plan,
        http_status: args.httpStatus ?? null,
        opus_bitrate: args.opusBitrate ?? null,
        policy_source: args.policySource ?? null,
    };
}

/**
 * Rapportör som fyrar högst ett event, hur många utgångar anropet än har. Uppladdningen har
 * flera (för stor, nätverksfel, felsvar, lyckad), och ett dubbelt event hade räknat ett
 * försök två gånger.
 */
export function onceReporter(
    capture: (event: string, props: Record<string, unknown>) => void,
    base: Omit<Parameters<typeof cloudUploadOutcomeProps>[0], "outcome" | "httpStatus">,
): (outcome: CloudUploadOutcome, httpStatus?: number | null) => void {
    let done = false;
    return (outcome, httpStatus) => {
        if (done) return;
        done = true;
        try {
            capture("cloud_upload_outcome", { ...cloudUploadOutcomeProps({ ...base, outcome, httpStatus }) });
        } catch {
            // Mätningen får aldrig fälla uppladdningen.
        }
    };
}
