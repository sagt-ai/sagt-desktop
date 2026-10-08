import { useSettingsStore } from "@/store/settings-store";
import { useSyncStore } from "@/store/sync-store";
import { useAuthStore } from "@/store/auth-store";
import { ChevronDown, Cloud, HardDrive, Lock, ShieldAlert, Loader2 } from "lucide-react";
import { useTranscriptionStore } from "@/store/transcription-store";
import { usePostHogEvents } from "@/hooks/use-posthog-events";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface ModePillProps {
    onUpsellClick: () => void;
}

export function ModePill({ onUpsellClick }: ModePillProps) {
    const isSignedIn = useAuthStore((s) => s.isSignedIn);
    const isPro = useAuthStore((s) => s.isPro());
    const { recordingMode, setRecordingMode } = useSettingsStore();
    const { effectiveMode, isOnline, isRecording, uploadStatus, processingStatus } = useSyncStore();
    const isProcessingLocal = useTranscriptionStore(state => state.isProcessing);
    const events = usePostHogEvents();
    
    const isProcessing = isProcessingLocal || uploadStatus === 'uploading' || processingStatus === 'PROCESSING' || processingStatus === 'PENDING';
    const derivedMode = (!isSignedIn || !isPro) ? 'local' : effectiveMode;

    // "Large"/"Small" är modellstorlekar, inte något användaren valt eller behöver känna
    // till. Kvalitetsskillnaden förklaras där valet faktiskt görs (dropdownen nedan).
    const getModeName = (mode: string) => {
        // cloud_analysis treated as cloud — mode no longer selectable but may exist in localStorage
        if (mode === 'cloud_analysis' || mode === 'cloud') return "Moln";
        return "Lokalt";
    };

    // Determine visual state based on effective mode and online status
    const getPillState = () => {
        if (isRecording) {
            return {
                label: `Spelar in • ${getModeName(derivedMode)}`,
                colorClass: "bg-red-500/10 text-red-500 border-red-200/50 animate-[pulse_2s_cubic-bezier(0.4,0,0.6,1)_infinite]",
                icon: <span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span><span className="relative inline-flex rounded-full h-2 w-2 bg-red-500"></span></span>
            };
        }

        if (isProcessing) {
            return {
                label: "Bearbetar...",
                colorClass: "bg-brand/10 text-brand border-brand/20",
                icon: <Loader2 className="w-3.5 h-3.5 animate-spin" />
            };
        }

        if (!isOnline && (recordingMode === 'cloud_analysis' || recordingMode === 'cloud' )) {
            return {
                label: "Lokalt — offline",
                colorClass: "bg-amber-50 text-amber-700 border-amber-200/50 hover:bg-amber-100",
                icon: <ShieldAlert className="w-3.5 h-3.5" />
            };
        }

        return {
            label: getModeName(derivedMode),
            colorClass: "bg-green-500/10 text-green-500 border-green-200/50 hover:bg-green-500/20",
            icon: derivedMode === 'local' ? <HardDrive className="w-3.5 h-3.5" /> : <Cloud className="w-3.5 h-3.5" />
        };
    };

    const state = getPillState();

    const handleSelectMode = (mode: 'cloud' | 'local') => {
        if (!isPro && mode !== 'local') {
            onUpsellClick();
            return;
        }
        if (mode === 'cloud' && recordingMode === 'local') events.cloudModelEnabled('mode_pill');
        setRecordingMode(mode);
        useSyncStore.getState().setEffectiveMode(isOnline ? mode : 'local');
    };

    // If recording or processing, render as a static pill (not a dropdown)
    if (isRecording || isProcessing) {
        return (
            <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-[11px] font-medium tracking-wide transition-all cursor-not-allowed opacity-90 ${state.colorClass}`}>
                {state.icon}
                {state.label}
            </div>
        );
    }

    return (
        <DropdownMenu>
            <DropdownMenuTrigger className="outline-none focus:ring-0">
                <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full border text-[11px] font-medium tracking-wide transition-all cursor-pointer ${state.colorClass}`}>
                    {state.icon}
                    {state.label}
                    <ChevronDown className="w-3 h-3 ml-1 opacity-70" />
                </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64 rounded-xl border border-line shadow-xl p-2 bg-white/95 backdrop-blur-sm">
                <div className="px-2 py-1.5 mb-1">
                    <p className="text-xs font-semibold text-ink">Inspelningsläge</p>
                    <p className="text-[10px] text-ink-muted leading-tight mt-0.5">Var ljudet bearbetas.</p>
                </div>

                <DropdownMenuItem
                    onClick={() => handleSelectMode('cloud')}
                    className={`flex flex-col items-start p-2.5 rounded-lg cursor-pointer transition-colors ${(recordingMode === 'cloud' || recordingMode === 'cloud_analysis') ? 'bg-brand/5' : 'hover:bg-paper-dim'}`}
                >
                    <div className="flex items-center w-full justify-between">
                        <div className="flex items-center gap-2">
                            <Cloud className={`w-4 h-4 ${(recordingMode === 'cloud' || recordingMode === 'cloud_analysis') ? 'text-brand' : 'text-ink-soft'}`} />
                            <span className={`text-sm font-medium ${(recordingMode === 'cloud' || recordingMode === 'cloud_analysis') ? 'text-brand' : 'text-ink-soft'}`}>
                                Moln
                            </span>
                        </div>
                        {!isPro && <Lock className="w-3 h-3 text-ink-muted" />}
                    </div>
                    <p className="text-[10px] text-ink-muted mt-1 ml-6">Högsta precisionen. Ljudet bearbetas på EU-servrar.</p>
                </DropdownMenuItem>

                <DropdownMenuItem
                    onClick={() => handleSelectMode('local')}
                    className={`flex flex-col items-start p-2.5 rounded-lg cursor-pointer transition-colors ${recordingMode === 'local' ? 'bg-paper-dim' : 'hover:bg-paper-dim'}`}
                >
                    <div className="flex items-center w-full justify-between">
                        <div className="flex items-center gap-2">
                            <HardDrive className={`w-4 h-4 ${recordingMode === 'local' ? 'text-ink-soft' : 'text-ink-muted'}`} />
                            <span className={`text-sm font-medium ${recordingMode === 'local' ? 'text-ink' : 'text-ink-soft'}`}>
                                Lokalt
                            </span>
                        </div>
                    </div>
                    <p className="text-[10px] text-ink-muted mt-1 ml-6">Ljudet lämnar aldrig datorn. Fungerar offline.</p>
                </DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
