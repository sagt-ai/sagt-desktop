// `sessionBusy` med appens egna källor. Utbrutet från `session-busy.ts` så att den
// filen går att testa utan stores och Tauri.

import { invoke } from "@tauri-apps/api/core"
import { useSyncStore } from "@/store/sync-store"
import { useTranscriptionStore } from "@/store/transcription-store"
import { sessionBusy } from "@/lib/session-busy"

export function appSessionBusy(): Promise<boolean> {
    return sessionBusy(
        {
            isRecording: useSyncStore.getState().isRecording,
            isProcessing: useTranscriptionStore.getState().isProcessing,
        },
        () => invoke<boolean>("session_busy"),
    )
}
