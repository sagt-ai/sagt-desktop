// En markör för den pågående inspelningen, så att en inspelning som aldrig sparades
// syns i telemetrin nästa gång appen startar.
//
// Markören skrivs vid start, får en hjärtslagstid ungefär en gång i minuten och en
// stopptid när användaren trycker Stopp. Den tas bort när inspelningen sparats. Ligger
// den kvar när appen startar nästa gång stängdes eller kraschade appen innan
// inspelningen sparades, och då skickas `recording_unsaved` med längden.
//
// Avbryt skickar `recording_cancelled` direkt och märker markören som avbruten. En
// avbruten markör tas bort i tysthet vid nästa start. Sparas inspelningen ändå efter
// Avbryt, vilket kan hända om allt redan var transkriberat, skickas
// `recording_saved_after_cancel` så att den inte räknas som förlorad.
//
// Bara tider och versionsnummer, aldrig något ur inspelningen eller transkriptet.
// Varje läsning och skrivning av lagringen sker i try/catch: går lagringen inte att
// använda blir det ingen markör och inget event, men inspelningen påverkas inte.

import { captureEvent } from "@/hooks/use-posthog-events"
import { CURRENT_VERSION } from "@/lib/version"

export const MARKER_KEY = "sagt_recording_marker"
export const HEARTBEAT_MS = 60_000

/**
 * Hur nära markörens starttid inspelningsfilens tidsstämpel måste ligga för att
 * räknas som samma inspelning. Appen namnger filen `session_<mikrosekunder>.wav` när
 * inspelningen börjar, och markören skrivs direkt efter. Uppmätt på åtta sparade
 * inspelningar: filens tid låg 0,04–0,10 s efter inspelningens start. Gränsen är snäv
 * med avsikt: en ny inspelning som startas några sekunder efter att en kort
 * inspelning stoppats får inte tas för den.
 */
export const SAME_RECORDING_MS = 2_000

/** Starttiden i millisekunder ur inspelningsfilens namn, eller null om namnet inte känns igen. */
export function startTimeFromPath(filePath: string): number | null {
    const m = /(?:^|[\\/])session_(\d{10,17})\.wav$/.exec(filePath)
    return m ? Number(m[1]) / 1000 : null
}

export interface RecordingMarker {
    started_at: number
    heartbeat_at: number
    /** När användaren tryckte Stopp. Saknas medan inspelningen pågår. */
    stopped_at?: number
    app_version: string
    /** Vilken körning av appen som skrev markören. */
    run_id: string
    /** Satt när användaren tryckt Avbryt. `recording_cancelled` är redan skickat. */
    cancelled?: true
}

type KeyValueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export interface MarkerDeps {
    storage: () => KeyValueStorage
    now: () => number
    capture: (event: string, props: Record<string, unknown>) => void
    version: string
    runId: string
}

function parseMarker(raw: string | null): RecordingMarker | null {
    if (!raw) return null
    try {
        const v = JSON.parse(raw)
        if (v && typeof v.started_at === "number" && typeof v.heartbeat_at === "number") {
            return v as RecordingMarker
        }
    } catch {
        // Trasig markör: behandlas som ingen.
    }
    return null
}

/** Längden i sekunder fram till Stopp, eller till senaste hjärtslaget om Stopp aldrig trycktes. */
export function markerDurationSeconds(m: RecordingMarker): number {
    const end = m.stopped_at ?? m.heartbeat_at
    return Math.max(0, Math.round((end - m.started_at) / 1000))
}

export function createRecordingMarker(deps: MarkerDeps) {
    const read = (): RecordingMarker | null => {
        try {
            return parseMarker(deps.storage().getItem(MARKER_KEY))
        } catch {
            return null
        }
    }
    /** Skriver markören. Returnerar false om lagringen inte gick att skriva till. */
    const write = (m: RecordingMarker): boolean => {
        try {
            deps.storage().setItem(MARKER_KEY, JSON.stringify(m))
            return true
        } catch {
            // Utan lagring finns ingen markör. Inspelningen fortsätter som vanligt.
            return false
        }
    }
    /** Tar bort markören. Returnerar false om den inte gick att ta bort. */
    const remove = (): boolean => {
        try {
            deps.storage().removeItem(MARKER_KEY)
            return true
        } catch {
            return false
        }
    }

    /**
     * Skickar `recording_unsaved` för en kvarlämnad markör och tar bort den.
     * `previous_run` skiljer en inspelning från en tidigare körning (appen stängdes
     * eller kraschade) från en i samma körning som ännu inte hunnit sparas när nästa
     * inspelning startade.
     */
    const reportLeftover = (): void => {
        const m = read()
        if (!m) return
        // Gick markören inte att ta bort skickas inget: annars skulle samma inspelning
        // rapporteras vid varje start.
        if (!remove()) return
        // Avbruten: eventet för den skickades redan när användaren tryckte Avbryt.
        if (m.cancelled) return
        const end = m.stopped_at ?? m.heartbeat_at
        deps.capture("recording_unsaved", {
            duration_seconds: markerDurationSeconds(m),
            minutes_since: Math.max(0, Math.round((deps.now() - end) / 60_000)),
            app_version_at_start: m.app_version,
            previous_run: m.run_id !== deps.runId,
        })
    }

    return {
        /** Vid appstart. */
        reportLeftover,

        /** Vid start. En kvarlämnad markör rapporteras först, sedan skrivs den nya. */
        started(): void {
            reportLeftover()
            const t = deps.now()
            write({ started_at: t, heartbeat_at: t, app_version: deps.version, run_id: deps.runId })
        },

        /** Ungefär en gång i minuten under inspelningen. */
        heartbeat(): void {
            const m = read()
            if (!m || m.stopped_at !== undefined || m.cancelled) return
            write({ ...m, heartbeat_at: deps.now() })
        },

        /** När användaren trycker Stopp. Markören ligger kvar tills inspelningen sparats. */
        stopped(): void {
            const m = read()
            if (!m || m.stopped_at !== undefined) return
            const t = deps.now()
            write({ ...m, heartbeat_at: t, stopped_at: t })
        },

        /**
         * När en inspelning sparats. Markören tas bara bort om den hör till just den
         * inspelningen: en sparad inspelning kan komma fram först efter att nästa
         * startat och stoppats, och får då inte ta bort den nyas markör. Känns
         * filnamnet inte igen görs ingenting.
         */
        saved(filePath: string): void {
            const m = read()
            if (!m) return
            const fileStart = startTimeFromPath(filePath)
            if (fileStart === null || Math.abs(fileStart - m.started_at) > SAME_RECORDING_MS) return
            if (!remove()) return
            if (m.cancelled) {
                deps.capture("recording_saved_after_cancel", { duration_seconds: markerDurationSeconds(m) })
            }
        },

        /**
         * När användaren trycker Avbryt. Skickar `recording_cancelled` bara om en osparad
         * inspelning finns: Avbryt visas också medan en redan sparad inspelning bearbetas
         * färdigt, och den räknas inte som avbruten.
         */
        cancelled(): void {
            const m = read()
            if (!m || m.cancelled) return
            const t = deps.now()
            const ended: RecordingMarker = m.stopped_at === undefined
                ? { ...m, heartbeat_at: t, stopped_at: t, cancelled: true }
                : { ...m, cancelled: true }
            // Gick markören inte att skriva skickas inget, så att samma inspelning inte
            // räknas både som avbruten och som osparad.
            if (!write(ended)) return
            deps.capture("recording_cancelled", { duration_seconds: markerDurationSeconds(ended) })
        },
    }
}

const RUN_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

export const recordingMarker = createRecordingMarker({
    storage: () => window.localStorage,
    now: () => Date.now(),
    capture: captureEvent,
    version: CURRENT_VERSION,
    runId: RUN_ID,
})
