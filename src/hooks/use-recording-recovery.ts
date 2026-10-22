import { useEffect } from "react"
import { invoke } from "@tauri-apps/api/core"
import { emit } from "@tauri-apps/api/event"
import { toast } from "sonner"
import { captureEvent } from "@/hooks/use-posthog-events"
import { markerAtLaunch } from "@/lib/recording-marker"
import { recoveryToast, type RecoveryReport } from "@/lib/recovery-report"

/**
 * Vid start: inspelningar som aldrig blev färdigsparade får en rad i Inspelningar.
 * Ljudmotorn gör jobbet och kör det en gång per körning; markören bidrar med tiderna
 * för den senaste inspelningen.
 */
export function useRecordingRecovery() {
    useEffect(() => {
        const m = markerAtLaunch
        const marker = m ? { started_at: m.started_at, stopped_at: m.stopped_at ?? null } : null
        invoke<RecoveryReport>("recover_recordings", { marker })
            .then((report) => {
                const text = recoveryToast(report)
                if (!text) return
                toast.info(text, { duration: 15000 })
                void emit("recordings-recovered")
                // Bara antal och tider, aldrig något ur inspelningen.
                captureEvent("recording_recovered", {
                    recovered: report.recovered,
                    recovered_minutes: Math.round(report.recovered_seconds / 60),
                    interrupted: report.interrupted,
                    discarded_short: report.discarded_short,
                    marker_matched: report.marker_matched,
                    marker_stopped: report.marker_stopped,
                })
            })
            .catch((e) => console.error("Återställningen misslyckades:", e))
    }, [])
}
