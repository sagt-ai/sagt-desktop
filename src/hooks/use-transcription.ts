import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useTranscriptionStore, UISegment } from "@/store/transcription-store";
import { toast } from "sonner";
import { markErrorSeen } from "@/lib/feedback-runtime";

interface TranscriptionEvent {
    text: string;
    source: string;
    start?: number;
    end?: number;
}

export function useTranscription() {
    const { addSegment, setIsProcessing } = useTranscriptionStore();

    useEffect(() => {
        const unlistenChunkPromise = listen<TranscriptionEvent>("transcription-chunk", (event) => {
            const { text, source } = event.payload;

            // Map source "mic" -> "DU", "sys" -> "MÖTET" if backend sends raw tags
            // Backend sends "DU" or "MÖTET" in process_audio_stream.

            const newSegment: UISegment = {
                text,
                // ?? (inte ||) så ett legitimt 0 (talstart i första sekunden) inte byts mot
                // väggklockan. Rust skickar nu sessionsrelativa sekunder, delat för Du/Mötet.
                start_time: event.payload.start ?? (Date.now() / 1000),
                end_time: event.payload.end ?? (Date.now() / 1000),
                timestamp: Date.now(), // Milliseconds for UI key/display
                speaker: source
            };

            addSegment(newSegment);
            // Sätt INTE isProcessing(false) här: med beam-size 1 levereras chunks snabbt och
            // det fick "Avbryt"-knappen att försvinna mitt i pågående transkribering.
            // isProcessing styrs av control-bar (start/stop + history-updated) och use-cloud-stream.
        });

        // transcription-status togs bort från Rust i "Refactor persistence to be
        // backend-driven" (6e7f02b) → history-updated ersatte den. isProcessing styrs nu
        // av control-bar (start/stop + history-updated) och use-cloud-stream; det lokala
        // transcription_completed-eventet fyras i control-bars history-updated-lyssnare.

        const unlistenErrorPromise = listen<string>("transcription-error", (event) => {
            console.error("React: Transcription Error", event.payload);
            toast.error(event.payload, {
                duration: 6000,
            });
            markErrorSeen();
            setIsProcessing(false);
        });

        return () => {
            unlistenChunkPromise.then((unlisten) => unlisten());
            unlistenErrorPromise.then((unlisten) => unlisten());
        };
    }, []);

    // Return nothing, or return store values if needed for backward compat?
    // Consumers should use useTranscriptionStore() directly.
    // But SplitView uses: const { segments, isProcessing } = useTranscription();
    // So let's return from store here to minimize refactor in SplitView for now.

    // We can't use hooks conditionally, but we can call the store hook here.
    const segments = useTranscriptionStore(state => state.segments);
    const isProcessing = useTranscriptionStore(state => state.isProcessing);

    return { segments, isProcessing };
}
