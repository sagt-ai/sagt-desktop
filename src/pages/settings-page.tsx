import { useEffect, useState } from "react";
import { CURRENT_VERSION } from "@/lib/version";
import { Slider } from "@/components/ui/slider";
import { useSettingsStore, TranscriptionLanguage, LocalAudioRetention } from "@/store/settings-store";
import { getStorageUsage, runStorageCleanup, openRecordingsFolder, formatBytes, type StorageUsage } from "@/lib/storage";
import { useAudioAmplitude } from "@/hooks/use-audio-amplitude";
import { Cpu, Cloud, Sparkles, HardDrive, Lock, Mic, Languages, ChevronDown, ChevronUp, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InfoHint } from "@/components/ui/info-hint";
import { invoke } from "@tauri-apps/api/core";
import { useAuthStore } from "@/store/auth-store";
import { useCheckout } from "@/hooks/use-checkout";
import { toast } from "sonner";


const VAD_PRESETS = [
    { label: "Tyst rum",   threshold: 0.005, silence: 1000 },
    { label: "Normal",     threshold: 0.008, silence: 1200 },
    { label: "Bullrig",    threshold: 0.020, silence: 1500 },
] as const;

/**
 * Etikett + valfri förklaringsbubbla. Finns för att göra textmönstret svårt att avvika
 * från: varje inställning har en etikett, EN kort synlig rad (renderas av anroparen) och
 * konsekvenserna bakom ⓘ. Innan detta hade vissa inställningar tre rader löptext och
 * andra ingen alls.
 */
function SettingLabel({ children, hint }: { children: React.ReactNode; hint?: React.ReactNode }) {
    return (
        <div className="flex items-center gap-1.5">
            <label className="text-sm font-medium text-ink-soft">{children}</label>
            {hint ? <InfoHint>{hint}</InfoHint> : null}
        </div>
    );
}

export function SettingsPage() {
    const {
        vadThreshold,
        silenceDuration,
        retentionPolicy,
        setVadThreshold,
        setSilenceDuration,
        setRetentionPolicy,
        resetDefaults,
        inputDevice,
        setInputDevice,
        recordingMode,
        setRecordingMode,
        cloudSync,
        setCloudSync,
        transcriptionLanguage,
        setTranscriptionLanguage,
        cloudDiarizationMode,
        setCloudDiarizationMode,
        pauseBreakMs,
        setPauseBreakMs,
        micIsSingleSpeaker,
        setMicIsSingleSpeaker,
        autoDiarize,
        setAutoDiarize,
        autoAnalyze,
        setAutoAnalyze,
        localAudioRetention,
        setLocalAudioRetention,
    } = useSettingsStore();

    const isPro = useAuthStore((s) => s.isPro());
    const monthlyLimit = useAuthStore((s) => s.monthlyMinutesLimit);
    const { openCheckout, isOpening: isOpeningCheckout } = useCheckout();

    const [availableDevices, setAvailableDevices] = useState<{ name: string, is_default: boolean }[]>([]);
    const [showAdvancedVad, setShowAdvancedVad] = useState(false);
    const [storageUsage, setStorageUsage] = useState<StorageUsage | null>(null);

    useEffect(() => {
        invoke<{ name: string, is_default: boolean }[]>("get_audio_devices")
            .then(setAvailableDevices)
            .catch(console.error);
        getStorageUsage().then(setStorageUsage).catch(console.error);
    }, []);

    // Lat mic-livscykel: öppna mikrofonen medan Inställningar visas så mikrofontestet
    // nedan visar en live nivå, och släpp den vid lämning. Utanför inspelning/preview
    // hålls micen inte alls → andra appar (webbläsarens inspelning, Teams/Zoom) kan
    // använda mikrofonen fritt. Rust-sidans reconcile bygger/dropper strömmen.
    useEffect(() => {
        invoke("start_mic_preview").catch(console.error);
        return () => {
            invoke("stop_mic_preview").catch(console.error);
        };
    }, []);

    // Vid val av raderande policy: bekräfta, gallra direkt och visa frigjort utrymme.
    const handleLocalRetentionChange = async (policy: LocalAudioRetention) => {
        if (policy !== 'keep_all' && policy !== localAudioRetention) {
            const description: Record<Exclude<LocalAudioRetention, 'keep_all'>, string> = {
                days_30: "ljudfiler äldre än 30 dagar raderas",
                days_90: "ljudfiler äldre än 90 dagar raderas",
                gb_10: "de äldsta ljudfilerna raderas när totalen överstiger 10 GB",
            };
            const ok = confirm(
                `Med denna gallringspolicy ${description[policy]} — nu och automatiskt framöver. ` +
                `Transkript och analyser behålls alltid. Vill du fortsätta?`
            );
            if (!ok) return;
        }
        setLocalAudioRetention(policy);
        if (policy === 'keep_all') return;
        try {
            const result = await runStorageCleanup();
            if (result && result.deleted_count > 0) {
                toast.success(`Frigjorde ${formatBytes(result.freed_bytes)} (${result.deleted_count} ljudfiler).`);
            } else {
                toast.info("Inga ljudfiler behövde gallras.");
            }
            setStorageUsage(await getStorageUsage());
        } catch (error) {
            console.error("Gallring misslyckades:", error);
            toast.error("Gallringen misslyckades: " + String(error));
        }
    };

    const amplitude = useAudioAmplitude();

    // Debounce mot Rust medan sliders dras. App.tsx pushar samma värden vid appstart —
    // den här effekten håller motorn i synk under sessionen, inte vid uppstart.
    // transcriptionLanguage ingår inte: språket följer med moln-POSTen (lib/api.ts) och
    // den lokala sidecarn kör alltid svenska.
    useEffect(() => {
        const timer = setTimeout(() => {
            invoke("update_audio_settings", {
                threshold: vadThreshold,
                silenceMs: silenceDuration,
            }).catch(console.error);
        }, 200);
        return () => clearTimeout(timer);
    }, [vadThreshold, silenceDuration]);

    const activePreset = VAD_PRESETS.find(
        p => p.threshold === vadThreshold && p.silence === silenceDuration
    );

    return (
        <div className="flex flex-col h-full bg-paper-dim overflow-y-auto">
            <header className="px-8 py-6 border-b bg-white">
                <h1 className="text-2xl font-display font-bold tracking-tight text-ink">Inställningar</h1>
                <p className="text-muted-foreground mt-1">Konfigurera ljud, modeller och beteende.</p>
            </header>

            <div className="p-8 max-w-2xl space-y-10">

                {/* Audio Engine Settings */}
                <section className="space-y-6">
                    <div className="flex items-center gap-2 mb-4">
                        <Mic className="text-primary w-5 h-5" />
                        <h2 className="text-lg font-display font-semibold text-ink">Ljud</h2>
                    </div>

                    {/* Device Selection */}
                    <div className="bg-white p-6 rounded-lg border shadow-sm space-y-4">
                        <div className="space-y-3">
                            <SettingLabel hint="Väljer du fel enhet blir din egen kanal tyst medan mötets ljud fortfarande spelas in. Bytet tar effekt inom ett par sekunder — du behöver inte starta om appen.">
                                Mikrofon
                            </SettingLabel>
                            <select
                                value={inputDevice || ""}
                                onChange={(e) => {
                                    setInputDevice(e.target.value || null);
                                    invoke("init_audio_engine", { device: e.target.value || null }).catch(console.error);
                                }}
                                className="flex h-10 w-full items-center justify-between rounded-md border border-line bg-white px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                <option value="">Standardenhet (system)</option>
                                {availableDevices.map((d) => (
                                    <option key={d.name} value={d.name}>
                                        {d.name} {d.is_default ? "(Standard)" : ""}
                                    </option>
                                ))}
                            </select>
                            <p className="text-xs text-muted-foreground">
                                Ljudkällan för din egen röst i inspelningen.
                            </p>
                        </div>

                        {/* Visualizer */}
                        <div className="space-y-3 pt-2 border-t">
                            <div className="flex justify-between items-center">
                                <SettingLabel hint="Den röda linjen är din känslighetströskel. Ligger stapeln under linjen när du talar uppfattas du som tyst. Ligger den över när rummet är tyst plockar appen upp bakgrundsljud.">
                                    Mikrofontest
                                </SettingLabel>
                                <span className="text-xs font-mono text-muted-foreground">
                                    Nivå: {(amplitude.mic * 100).toFixed(1)}%
                                </span>
                            </div>
                            <div className="relative h-6 bg-paper-dim rounded-full overflow-hidden w-full">
                                <div
                                    className="absolute top-0 bottom-0 left-0 bg-green-500 transition-all duration-75 ease-out"
                                    style={{ width: `${Math.min(amplitude.mic * 500, 100)}%` }}
                                />
                                <div
                                    className="absolute top-0 bottom-0 w-0.5 bg-red-500 z-10"
                                    style={{ left: `${Math.min(vadThreshold * 500, 100)}%` }}
                                    title="Nuvarande tröskel"
                                />
                            </div>
                            <p className="text-xs text-muted-foreground">
                                Prata normalt — stapeln ska gå över den röda linjen.
                            </p>
                        </div>

                        {/* VAD Presets */}
                        <div className="space-y-3 pt-2 border-t">
                            <SettingLabel hint="Tyst rum sänker tröskeln så att även låg röst fångas. Bullrig höjer den så att fläktar och tangentbord inte startar transkribering. Normal passar de flesta.">
                                Mikrofonkänslighet
                            </SettingLabel>
                            <p className="text-xs text-muted-foreground">
                                Hur mycket ljud som krävs för att appen ska uppfatta tal.
                            </p>
                            <div className="grid grid-cols-3 gap-3">
                                {VAD_PRESETS.map((preset) => (
                                    <button
                                        key={preset.label}
                                        onClick={() => { setVadThreshold(preset.threshold); setSilenceDuration(preset.silence); }}
                                        className={`px-3 py-2 rounded-md border text-sm font-medium transition-all ${
                                            activePreset?.label === preset.label
                                                ? 'border-primary bg-primary/5 text-primary ring-1 ring-primary'
                                                : 'border-line bg-white text-ink-soft hover:bg-paper-dim'
                                        }`}
                                    >
                                        {preset.label}
                                    </button>
                                ))}
                            </div>

                            {/* Advanced toggle */}
                            <button
                                onClick={() => setShowAdvancedVad(v => !v)}
                                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-ink-soft transition-colors mt-1"
                            >
                                {showAdvancedVad ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                                Avancerade inställningar
                            </button>

                            {showAdvancedVad && (
                                <div className="grid gap-6 pt-2">
                                    <div className="space-y-3">
                                        <div className="flex justify-between">
                                            <label className="text-sm font-medium">Känslighet (tröskel)</label>
                                            <span className="text-sm font-mono bg-paper-dim px-2 py-0.5 rounded">
                                                {vadThreshold.toFixed(4)}
                                            </span>
                                        </div>
                                        <Slider
                                            value={[vadThreshold]}
                                            min={0.001}
                                            max={0.1}
                                            step={0.001}
                                            onValueChange={(val) => setVadThreshold(val[0])}
                                        />
                                    </div>
                                    <div className="space-y-3">
                                        <div className="flex justify-between">
                                            <label className="text-sm font-medium">Paustolerans</label>
                                            <span className="text-sm font-mono bg-paper-dim px-2 py-0.5 rounded">
                                                {silenceDuration} ms
                                            </span>
                                        </div>
                                        <Slider
                                            value={[silenceDuration]}
                                            min={500}
                                            max={3000}
                                            step={100}
                                            onValueChange={(val) => setSilenceDuration(val[0])}
                                        />
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </section>

                {/* Model Settings */}
                <section className="space-y-6">
                    <div className="flex items-center gap-2 mb-4">
                        <Cpu className="text-primary w-5 h-5" />
                        <h2 className="text-lg font-display font-semibold text-ink">AI-modell</h2>
                    </div>

                    <div className="bg-white p-6 rounded-lg border shadow-sm space-y-4">
                        {/* Lokal Modell */}
                        <div className="p-4 bg-paper-dim border border-line rounded-lg flex gap-4 items-center">
                            <div className="p-2 bg-white rounded-full h-fit border border-line shadow-sm flex-shrink-0">
                                <Cpu className="w-5 h-5 text-ink-soft" />
                            </div>
                            <div className="space-y-0.5">
                                <h3 className="font-semibold text-ink">Lokal (Gratis)</h3>
                                <p className="text-sm text-ink-soft leading-relaxed">
                                    Snabb transkribering direkt på din dator. Fungerar offline.
                                </p>
                            </div>
                        </div>

                        {/* Moln Modell */}
                        <div className={`p-4 border rounded-lg flex gap-4 items-center ${isPro ? 'bg-brand/5 border-brand/10' : 'bg-paper-dim border-line opacity-70'}`}>
                            <div className={`p-2 rounded-full h-fit border shadow-sm flex-shrink-0 ${isPro ? 'bg-white border-brand/10' : 'bg-white border-line'}`}>
                                {isPro ? <Cloud className="w-5 h-5 text-brand" /> : <Lock className="w-5 h-5 text-ink-muted" />}
                            </div>
                            <div className="space-y-0.5 flex-1">
                                <h3 className={`font-semibold ${isPro ? 'text-brand' : 'text-ink-soft'}`}>Moln (Pro)</h3>
                                <p className={`text-sm leading-relaxed ${isPro ? 'text-brand/80' : 'text-ink-muted'}`}>
                                    Högre noggrannhet via molnet. Bäst för möten och intervjuer.
                                </p>
                            </div>
                            {isPro && (
                                <div className="text-right flex-shrink-0">
                                    <div className="text-xs text-brand font-medium">{monthlyLimit} min/mån</div>
                                    <div className="text-xs text-ink-muted">ingår i Pro</div>
                                </div>
                            )}
                        </div>

                        {/* Molntranskribering — struktur (endast Pro, styr live-strömning) */}
                        {isPro && (
                            <div className="border-t pt-4 space-y-4">
                                <div className="space-y-1">
                                    <SettingLabel hint={<>Du/Mötet transkriberar mikrofon och mötesljud var för sig. Det ger bäst &quot;vem sa vad&quot; och tål överhörning, men <strong className="text-ink">räknas dubbelt mot din månadsgräns</strong>. Sammanhängande mixar till ett spår och räknas enkelt.</>}>
                                        Talare i livetranskriptionen
                                    </SettingLabel>
                                    <p className="text-xs text-muted-foreground">
                                        Hur talarna visas medan mötet transkriberas i molnet.
                                    </p>
                                </div>
                                <div className="grid grid-cols-2 gap-3">
                                    <button
                                        onClick={() => setCloudDiarizationMode('structured')}
                                        className={`px-3 py-3 rounded-lg border text-left transition-all ${
                                            cloudDiarizationMode === 'structured'
                                                ? 'border-primary bg-primary/5 ring-1 ring-primary'
                                                : 'border-line bg-white hover:bg-paper-dim'
                                        }`}
                                    >
                                        <div className="text-sm font-medium text-ink">Du / Mötet</div>
                                        <div className="text-xs text-ink-muted mt-0.5">Separata talare</div>
                                    </button>
                                    <button
                                        onClick={() => setCloudDiarizationMode('merged')}
                                        className={`px-3 py-3 rounded-lg border text-left transition-all ${
                                            cloudDiarizationMode === 'merged'
                                                ? 'border-primary bg-primary/5 ring-1 ring-primary'
                                                : 'border-line bg-white hover:bg-paper-dim'
                                        }`}
                                    >
                                        <div className="text-sm font-medium text-ink">Sammanhängande</div>
                                        <div className="text-xs text-ink-muted mt-0.5">Ett löpande stycke</div>
                                    </button>
                                </div>

                                {/* Pausbryt-tröskel — gäller båda lägena, härleds ur talpaus */}
                                <div className="space-y-3 pt-1">
                                    <div className="flex justify-between">
                                        <SettingLabel hint="Rent visuellt — påverkar bara hur texten radbryts, aldrig transkriberingen eller vad du debiteras.">
                                            Styckesbryt vid paus
                                        </SettingLabel>
                                        <span className="text-sm font-mono bg-paper-dim px-2 py-0.5 rounded">
                                            {(pauseBreakMs / 1000).toFixed(1)} s
                                        </span>
                                    </div>
                                    <Slider
                                        value={[pauseBreakMs]}
                                        min={silenceDuration}
                                        max={5000}
                                        step={100}
                                        onValueChange={(val) => setPauseBreakMs(val[0])}
                                    />
                                    <p className="text-xs text-muted-foreground">
                                        En talpaus längre än detta ger ett nytt stycke.
                                    </p>
                                </div>

                                {/* §13.4 mic-kanal-hint — en talare vid mikrofonen (default på) */}
                                <div className="space-y-3 pt-1">
                                    <div>
                                        <SettingLabel hint={<>Håller din mikrofonkanal som en enda röst så att du inte delas upp i &quot;Du 1&quot; och &quot;Du 2&quot;. Stäng av om ni sitter flera vid samma mikrofon.<br /><br />Påverkar inte den automatiska talarsepareringen efter mötet — den delar bara upp mötesljudet, aldrig din mikrofon.</>}>
                                            Talare i din mikrofon
                                        </SettingLabel>
                                        <p className="text-xs text-muted-foreground mt-1">
                                            Gäller när hela inspelningen omtranskriberas med talarseparering.
                                        </p>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        {([
                                            { value: true, label: 'En talare' },
                                            { value: false, label: 'Flera talare' },
                                        ] as { value: boolean; label: string }[]).map(({ value, label }) => (
                                            <button
                                                key={String(value)}
                                                onClick={() => setMicIsSingleSpeaker(value)}
                                                className={`px-3 py-2 rounded-md border text-sm font-medium transition-all ${micIsSingleSpeaker === value
                                                    ? 'border-primary bg-primary/5 text-primary ring-1 ring-primary'
                                                    : 'border-line bg-white text-ink-soft hover:bg-paper-dim'
                                                }`}
                                            >
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                {/* §steg 5 — automatik efter möte (opt-out, default på) */}
                                <div className="space-y-3 pt-1">
                                    <div>
                                        <SettingLabel hint="I manuellt läge kör du samma separering via knappen i transkriptet, när du vill. Kräver att ljudfilen finns kvar på datorn.">
                                            Talarseparering efter möte
                                        </SettingLabel>
                                        <p className="text-xs text-muted-foreground mt-1">
                                            Delar mötesljudet i Talare 1, 2, 3 när du stoppar inspelningen.
                                        </p>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        {([
                                            { value: true, label: 'Automatiskt' },
                                            { value: false, label: 'Manuellt' },
                                        ] as { value: boolean; label: string }[]).map(({ value, label }) => (
                                            <button
                                                key={String(value)}
                                                onClick={() => setAutoDiarize(value)}
                                                className={`px-3 py-2 rounded-md border text-sm font-medium transition-all ${autoDiarize === value
                                                    ? 'border-primary bg-primary/5 text-primary ring-1 ring-primary'
                                                    : 'border-line bg-white text-ink-soft hover:bg-paper-dim'
                                                }`}
                                            >
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                </div>

                                <div className="space-y-3 pt-1">
                                    <div>
                                        <SettingLabel hint="Gäller molnläge. I manuellt läge startar du analysen från transkriptet när mötet är klart.">
                                            Analys efter möte
                                        </SettingLabel>
                                        <p className="text-xs text-muted-foreground mt-1">
                                            Startar sammanfattning, beslut och åtgärder när du stoppar inspelningen.
                                        </p>
                                    </div>
                                    <div className="grid grid-cols-2 gap-3">
                                        {([
                                            { value: true, label: 'Automatiskt' },
                                            { value: false, label: 'Manuellt' },
                                        ] as { value: boolean; label: string }[]).map(({ value, label }) => (
                                            <button
                                                key={String(value)}
                                                onClick={() => setAutoAnalyze(value)}
                                                className={`px-3 py-2 rounded-md border text-sm font-medium transition-all ${autoAnalyze === value
                                                    ? 'border-primary bg-primary/5 text-primary ring-1 ring-primary'
                                                    : 'border-line bg-white text-ink-soft hover:bg-paper-dim'
                                                }`}
                                            >
                                                {label}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </div>
                        )}

                        {/* Language Selection */}
                        <div className="border-t pt-4 space-y-3">
                            <div className="flex items-center gap-2">
                                <Languages className="w-4 h-4 text-ink-muted" />
                                <SettingLabel hint={<>Molnet byter talmodell efter språk: svenska via KB-Whisper (Kungliga biblioteket), norska via NB-Whisper (Nasjonalbiblioteket) och engelska via Whisper Large v3.<br /><br />Transkribering på din dator använder alltid KB:s svenska modell — det är den enda som följer med i installationen.</>}>
                                    Inspelningsspråk
                                </SettingLabel>
                            </div>
                            <div className="grid grid-cols-3 gap-3">
                                {([
                                    { value: 'sv', flag: '🇸🇪', label: 'Svenska',  desc: 'KB-Whisper' },
                                    { value: 'no', flag: '🇳🇴', label: 'Norska',   desc: 'NB-Whisper' },
                                    { value: 'en', flag: '🇬🇧', label: 'Engelska', desc: 'Whisper Large v3' },
                                ] as { value: TranscriptionLanguage; flag: string; label: string; desc: string }[]).map(({ value, flag, label, desc }) => (
                                    <button
                                        key={value}
                                        onClick={() => setTranscriptionLanguage(value)}
                                        className={`px-3 py-3 rounded-lg border text-left transition-all ${
                                            transcriptionLanguage === value
                                                ? 'border-primary bg-primary/5 ring-1 ring-primary'
                                                : 'border-line bg-white hover:bg-paper-dim'
                                        }`}
                                    >
                                        <div className="text-sm font-medium text-ink">{flag} {label}</div>
                                        <div className="text-xs text-ink-muted mt-0.5">{desc}</div>
                                        {/* Endast svenska finns i installationen. Utan denna markering tänds
                                            norska/engelska som "vald" i lokalt läge medan sidecarn ändå kör
                                            svenska — valet skulle se ut att gälla utan att göra något.
                                            Informerar, blockerar inte: en Pro-användare kan vilja välja språk
                                            innan hen byter till molnläge. */}
                                        {value !== 'sv' && recordingMode === 'local' && (
                                            <div className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200/60 rounded px-1.5 py-0.5 mt-1.5 w-fit">
                                                Endast moln
                                            </div>
                                        )}
                                    </button>
                                ))}
                            </div>
                            <p className="text-xs text-muted-foreground">
                                {recordingMode === 'local'
                                    ? "Gäller molnläge. På datorn transkriberas alltid svenska."
                                    : "Språket du talar. Gäller transkribering i molnet."}
                            </p>
                        </div>
                    </div>
                </section>

                {/* Cloud & Sync Settings */}
                <section className="space-y-6">
                    <div className="flex items-center gap-2 mb-4">
                        <Cloud className="text-primary w-5 h-5" />
                        <h2 className="text-lg font-display font-semibold text-ink">Moln & synk</h2>
                    </div>

                    <div className="bg-white p-6 rounded-lg border shadow-sm space-y-6">

                        {/* Standard Inspelningsläge */}
                        <div className="space-y-4">
                            <div className="flex items-center justify-between">
                                <div>
                                    <h3 className="text-sm font-semibold text-ink flex items-center gap-2">
                                        Standardläge för inspelning
                                        {!isPro && <Lock className="w-3.5 h-3.5 text-amber-500" />}
                                    </h3>
                                    <p className="text-xs text-muted-foreground mt-1">
                                        Välj hur dina inspelningar hanteras som standard.{" "}
                                        {/* Länken sitter här och inte i en egen sektion: det är i det här valet
                                            användaren avgör om ljudet lämnar datorn, och det är då frågan om
                                            ansvar för mötesdeltagarnas uppgifter faktiskt uppstår. */}
                                        <button
                                            type="button"
                                            className="underline underline-offset-2 hover:text-ink transition-colors"
                                            onClick={async () => {
                                                const { invoke } = await import('@tauri-apps/api/core');
                                                invoke('plugin:shell|open', { path: 'https://sagt.ai/dina-uppgifter' });
                                            }}
                                        >
                                            Vad gäller när du spelar in andra?
                                        </button>
                                    </p>
                                </div>
                                {!isPro && (
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="h-7 text-xs text-primary border-primary/20 bg-primary/5 hover:bg-primary/10"
                                        disabled={isOpeningCheckout}
                                        onClick={() => { void openCheckout(); }}
                                    >
                                        <Sparkles className="w-3 h-3 mr-1" />
                                        {isOpeningCheckout ? "Öppnar betalningen..." : "Uppgradera till Pro"}
                                    </Button>
                                )}
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
                                <button
                                    onClick={() => setRecordingMode('cloud')}
                                    disabled={!isPro}
                                    className={`relative p-4 rounded-xl border text-left flex flex-col items-center justify-center transition-all ${(recordingMode === 'cloud' || recordingMode === 'cloud_analysis')
                                        ? 'border-blue-600 bg-blue-50/50 shadow-sm ring-1 ring-blue-600'
                                        : 'border-line bg-white hover:border-blue-300 hover:bg-paper-dim'
                                    } ${!isPro ? 'opacity-70 grayscale cursor-not-allowed' : ''}`}
                                >
                                    <div className={`p-2 rounded-full mb-3 ${(recordingMode === 'cloud' || recordingMode === 'cloud_analysis') ? 'bg-blue-100 text-blue-600' : 'bg-paper-dim text-ink-muted'}`}>
                                        <Cloud className="w-5 h-5" />
                                    </div>
                                    <h4 className={`text-sm font-bold mb-1 text-center ${(recordingMode === 'cloud' || recordingMode === 'cloud_analysis') ? 'text-blue-900' : 'text-ink'}`}>
                                        Moln
                                    </h4>
                                    <p className="text-xs text-center text-ink-muted line-clamp-2">Perfekt transkription. Ingen automatisk sammanfattning.</p>
                                    {!isPro && <Lock className="absolute top-3 right-3 w-4 h-4 text-ink-muted" />}
                                </button>

                                <button
                                    onClick={() => setRecordingMode('local')}
                                    className={`relative p-4 rounded-xl border text-left flex flex-col items-center justify-center transition-all ${recordingMode === 'local'
                                        ? 'border-ink-soft bg-paper-dim shadow-sm ring-1 ring-ink-soft'
                                        : 'border-line bg-white hover:border-line hover:bg-paper-dim'
                                    }`}
                                >
                                    <div className={`p-2 rounded-full mb-3 ${recordingMode === 'local' ? 'bg-line text-ink-soft' : 'bg-paper-dim text-ink-muted'}`}>
                                        <HardDrive className="w-5 h-5" />
                                    </div>
                                    <h4 className={`text-sm font-bold mb-1 text-center ${recordingMode === 'local' ? 'text-ink' : 'text-ink'}`}>
                                        Lokal
                                    </h4>
                                    <p className="text-xs text-center text-ink-muted line-clamp-2">Ljudet lämnar aldrig din dator. Extremt säkert.</p>
                                </button>
                            </div>
                        </div>

                        {/* Molnsynk (opt-in, default av — privacy-first) */}
                        <div className="border-t pt-6 space-y-3">
                            <div>
                                <SettingLabel hint={<>Av (standard): molntranskriptionen visas bara på den här datorn. På: resultatet syns i dashboarden på sagt.ai och på dina andra enheter.<br /><br />Styr inte om ljud laddas upp för transkribering — det avgörs av inspelningsläget ovan.</>}>
                                    Synk till ditt konto
                                </SettingLabel>
                                <p className="text-xs text-muted-foreground mt-1">
                                    Sparar transkript och analys i ditt konto på sagt.ai.
                                </p>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                                {([
                                    { value: false, label: 'Av — bara här' },
                                    { value: true, label: 'På — synka' },
                                ] as { value: boolean; label: string }[]).map(({ value, label }) => (
                                    <button
                                        key={String(value)}
                                        onClick={() => setCloudSync(value)}
                                        className={`px-3 py-2 rounded-md border text-sm font-medium transition-all ${cloudSync === value
                                            ? 'border-primary bg-primary/5 text-primary ring-1 ring-primary'
                                            : 'border-line bg-white text-ink-soft hover:bg-paper-dim'
                                        }`}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Lagring (moln) */}
                        <div className="border-t pt-6 space-y-3">
                            <div>
                                <SettingLabel hint={<>Gäller filer du laddar upp för omtranskribering eller analys.<br /><br /><strong className="text-ink">Livetranskribering sparar aldrig ljud</strong> — varje ljudbit transkriberas i minnet och kastas direkt. Det finns alltså inget att gallra där.</>}>
                                    Ljudfiler i molnet
                                </SettingLabel>
                                <p className="text-xs text-muted-foreground">Hur länge en uppladdad ljudfil ligger kvar efter analys.</p>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                {([
                                    { value: '24h',              label: '24 timmar' },
                                    { value: 'immediate_delete', label: 'Radera efter analys' },
                                ] as { value: typeof retentionPolicy; label: string }[]).map(({ value, label }) => (
                                    <button
                                        key={value}
                                        onClick={() => setRetentionPolicy(value)}
                                        className={`px-3 py-2 rounded-md border text-sm font-medium transition-all ${retentionPolicy === value
                                            ? 'border-primary bg-primary/5 text-primary ring-1 ring-primary'
                                            : 'border-line bg-white text-ink-soft hover:bg-paper-dim'
                                        }`}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {/* Lokal lagring — diskanvändning + gallringspolicy */}
                        <div className="border-t pt-6 space-y-3">
                            <div>
                                <SettingLabel hint="Transkript och analyser behålls alltid — bara ljudet gallras. Ljudfilen behövs för att kunna köra om transkriberingen eller talarsepareringen i efterhand.">
                                    Ljudfiler på den här datorn
                                </SettingLabel>
                                <p className="text-xs text-muted-foreground">
                                    Hur länge inspelat ljud sparas lokalt.
                                </p>
                            </div>

                            <div className="flex items-center gap-2 text-xs text-ink-soft bg-paper-dim rounded-md px-3 py-2">
                                <HardDrive className="w-4 h-4 text-ink-muted shrink-0" />
                                {storageUsage ? (
                                    <span>
                                        Inspelningar: <strong>{formatBytes(storageUsage.recordings_bytes)}</strong> ({storageUsage.file_count} ljudfiler)
                                        {' · '}Databas: {formatBytes(storageUsage.db_bytes)}
                                    </span>
                                ) : (
                                    <span>Beräknar diskanvändning…</span>
                                )}
                                <button
                                    onClick={() => openRecordingsFolder().catch((e) => {
                                        console.error("Kunde inte öppna inspelningsmappen:", e);
                                        toast.error("Kunde inte öppna mappen.");
                                    })}
                                    className="ml-auto shrink-0 inline-flex items-center gap-1 text-brand hover:underline font-medium"
                                >
                                    <FolderOpen className="w-3.5 h-3.5" />
                                    Öppna mapp
                                </button>
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                {([
                                    { value: 'keep_all', label: 'Behåll allt' },
                                    { value: 'days_30',  label: 'Radera ljud äldre än 30 dagar' },
                                    { value: 'days_90',  label: 'Radera ljud äldre än 90 dagar' },
                                    { value: 'gb_10',    label: 'Max 10 GB ljudfiler' },
                                ] as { value: LocalAudioRetention; label: string }[]).map(({ value, label }) => (
                                    <button
                                        key={value}
                                        onClick={() => handleLocalRetentionChange(value)}
                                        className={`px-3 py-2 rounded-md border text-sm font-medium transition-all ${localAudioRetention === value
                                            ? 'border-primary bg-primary/5 text-primary ring-1 ring-primary'
                                            : 'border-line bg-white text-ink-soft hover:bg-paper-dim'
                                        }`}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        </div>
                    </div>
                </section>

                <div className="flex items-center justify-between pt-4">
                    <span className="text-xs text-ink-muted">Sagt.ai v{CURRENT_VERSION}</span>
                    <Button variant="outline" onClick={resetDefaults} className="text-red-600 hover:text-red-700 hover:bg-red-50">
                        Återställ till standardvärden
                    </Button>
                </div>
            </div>
        </div>
    );
}
