import { Cloud, HardDrive } from "lucide-react";
import { useAuthStore } from "@/store/auth-store";
import { useSettingsStore } from "@/store/settings-store";
import { useSyncStore } from "@/store/sync-store";
import { usePostHogEvents } from "@/hooks/use-posthog-events";
import { cloudChoiceAction } from "@/lib/cloud-choice";

/**
 * Engångsfrågan efter uppdateringen där lokal modell blev standard för alla. Den som hade
 * molnmodellen som standard får välja själv, i stället för att flyttas utan att märka det.
 * Utan Pro visas ingenting och ingenting ändras: frågan väntar tills kontot är Pro.
 */
export function CloudChoiceDialog() {
    const pending = useSettingsStore((s) => s.cloudChoicePending);
    const resolveCloudChoice = useSettingsStore((s) => s.resolveCloudChoice);
    const isSignedIn = useAuthStore((s) => s.isSignedIn);
    const isPro = useAuthStore((s) => s.isPro());
    const monthlyLimit = useAuthStore((s) => s.monthlyMinutesLimit);
    const isRecording = useSyncStore((s) => s.isRecording);
    const events = usePostHogEvents();

    const action = cloudChoiceAction({ pending, isSignedIn, isPro });

    // Mitt i en inspelning väntar frågan till efteråt.
    if (action !== "show" || isRecording) return null;

    const choose = (mode: "cloud" | "local") => {
        resolveCloudChoice(mode);
        useSyncStore.getState().setEffectiveMode(mode === "cloud" && navigator.onLine ? "cloud" : "local");
        if (mode === "cloud") events.cloudModelEnabled("first_start");
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/30 backdrop-blur-sm animate-in fade-in duration-200">
            <div className="bg-white rounded-2xl w-[480px] max-w-[90vw] shadow-2xl border border-line overflow-hidden p-8 space-y-5" role="dialog" aria-labelledby="cloud-choice-title">
                <div className="space-y-2 text-center">
                    <h2 id="cloud-choice-title" className="text-lg font-display font-semibold text-ink">Välj transkribering</h2>
                    <p className="text-sm text-ink-soft">
                        Den lokala modellen är nu standard. Du har använt molnmodellen tidigare. Välj vad som ska gälla framöver. Du kan ändra det när som helst i lägesväljaren och under Inställningar.
                    </p>
                </div>
                <div className="grid grid-cols-1 gap-3">
                    <button
                        onClick={() => choose("local")}
                        className="flex items-start gap-3 p-4 rounded-xl border border-line text-left hover:bg-paper-dim transition-colors"
                    >
                        <HardDrive className="w-5 h-5 text-ink-soft mt-0.5 flex-shrink-0" />
                        <span>
                            <span className="block text-sm font-semibold text-ink">Lokal modell</span>
                            <span className="block text-xs text-ink-muted mt-0.5">Ljudet lämnar aldrig datorn. Fungerar offline.</span>
                        </span>
                    </button>
                    <button
                        onClick={() => choose("cloud")}
                        className="flex items-start gap-3 p-4 rounded-xl border border-brand/30 bg-brand/5 text-left hover:bg-brand/10 transition-colors"
                    >
                        <Cloud className="w-5 h-5 text-brand mt-0.5 flex-shrink-0" />
                        <span>
                            <span className="block text-sm font-semibold text-brand">Molnmodellen (KB-Whisper Large)</span>
                            <span className="block text-xs text-ink-muted mt-0.5">
                                Högre precision. Ljudet bearbetas på svenska servrar och räknas mot dina {monthlyLimit} minuter i månaden.
                            </span>
                        </span>
                    </button>
                </div>
            </div>
        </div>
    );
}
