import { format } from "date-fns";
import { sv } from "date-fns/locale";
import { Cloud, CloudUpload, Trash2, FileAudio, FileText, FolderOpen, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openRecordingsFolder } from "@/lib/storage";
import { useSyncStore } from "@/store/sync-store";
import { useAuthStore } from "@/store/auth-store";
import { uploadJob, errorSlug } from "@/lib/api";
import { showError, usePostHogEvents } from "@/hooks/use-posthog-events";
import { useState, useEffect, useMemo, useRef } from "react";
import { useSettingsStore } from "@/store/settings-store";
import { UpsellModal } from "@/components/dashboard/upsell-modal";
import { ExportDialog } from "@/components/dashboard/export-dialog";
import { canExport, hasAnalysisSource, hasTranscriptSource, isExportable } from "@/lib/export/select";
import { collectMeetings } from "@/lib/export/tauri-io";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";

interface Recording {
    id: number;
    filename: string;
    file_path: string;
    duration_sec: number;
    created_at: string;
    sync_status: 'local' | 'synced' | 'uploaded';
    cloud_job_id?: string;
    analysis_json?: string;
    cloud_transcript?: string | null;
    cloud_segments?: string | null;
    speaker_map?: string | null;
    audio_deleted: boolean;
    has_segments: boolean;
}

/** "Välj alla" med tredje läget (delvis valt), som bara går att sätta via DOM:en. */
function SelectAllCheckbox({ checked, indeterminate, disabled, onChange }: {
    checked: boolean; indeterminate: boolean; disabled: boolean; onChange: (v: boolean) => void;
}) {
    const ref = useRef<HTMLInputElement>(null);
    useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
    return (
        <input
            ref={ref}
            type="checkbox"
            aria-label="Välj alla"
            title="Välj alla"
            className="h-4 w-4 accent-brand cursor-pointer disabled:cursor-not-allowed"
            checked={checked}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked)}
        />
    );
}

export function RecordingsPage({ onViewChange }: { onViewChange: (view: 'dashboard' | 'settings' | 'recordings') => void }) {
    // Replace store with local state fetched from DB
    const [recordings, setRecordings] = useState<Recording[]>([]);
    const { setSession, setUploadedJobId, setActiveJob, setAnalysisData, setProcessingStatus } = useSyncStore();
    const getToken = useAuthStore((s) => s.getToken);
    const isPro = useAuthStore((s) => s.isPro());
    const [syncingId, setSyncingId] = useState<number | null>(null);

    // Export (Pro): urval per rad, "välj alla", "Exportera valda".
    const events = usePostHogEvents();
    const exportAllowed = useAuthStore((s) => canExport(s.stripeStatus));
    const pauseBreakMs = useSettingsStore((s) => s.pauseBreakMs);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [showExport, setShowExport] = useState(false);
    const [showUpsell, setShowUpsell] = useState(false);
    const exportableIds = useMemo(() => recordings.filter(isExportable).map(r => r.id), [recordings]);
    const selectedRecs = useMemo(() => recordings.filter(r => selected.has(r.id)), [recordings, selected]);
    const allSelected = exportableIds.length > 0 && exportableIds.every(id => selected.has(id));
    const toggleOne = (id: number, on: boolean) => setSelected(prev => {
        const next = new Set(prev);
        if (on) next.add(id); else next.delete(id);
        return next;
    });
    const handleExportSelected = () => {
        if (selected.size === 0) return;
        if (!exportAllowed) {
            events.upsellShown('export');
            setShowUpsell(true);
            return;
        }
        setShowExport(true);
    };

    const loadRecordings = async () => {
        try {
            const data = await invoke<Recording[]>("get_recordings");
            setRecordings(data);
            // Raderade eller inte längre exporterbara rader lämnar urvalet.
            const keep = new Set(data.filter(isExportable).map(r => r.id));
            setSelected(prev => new Set([...prev].filter(id => keep.has(id))));
        } catch (error) {
            console.error("Failed to load recordings:", error);
        }
    };

    useEffect(() => {
        loadRecordings();

        const unlistenHistory = listen("history-updated", () => {
            console.log("RecordingsPage: History updated, reloading list...");
            loadRecordings();
        });
        const unlistenSynced = listen("recording-synced", () => {
            loadRecordings();
        });
        // Auto-gallring kan radera ljudfiler medan listan visas — uppdatera badges.
        const unlistenCleaned = listen("storage-cleaned", () => {
            loadRecordings();
        });

        return () => {
            unlistenHistory.then(f => f());
            unlistenSynced.then(f => f());
            unlistenCleaned.then(f => f());
        };
    }, []);

    const handleLoad = (recording: Recording) => {
        setSession(recording.file_path, recording.id.toString());
        setActiveJob(recording, true);
        setProcessingStatus('COMPLETED'); // Assume completed if we have analysis, or at least not uploading

        if (recording.analysis_json) {
            try {
                const analysisData = JSON.parse(recording.analysis_json);
                setAnalysisData(analysisData);
            } catch (e) {
                console.error("Failed to parse analysis_json:", e);
                setAnalysisData(null);
            }
        } else {
            setAnalysisData(null);
            // If no analysis but we have cloud ID, maybe we should fetch? 
            // Logic for now: if no local analysis, show empty context.
            setProcessingStatus(null);
        }

        if (recording.cloud_job_id) {
            setUploadedJobId(recording.cloud_job_id);
        } else {
            setUploadedJobId(null);
        }
        onViewChange('dashboard');
    };

    const handleDelete = async (id: number) => {
        if (confirm("Är du säker på att du vill radera denna inspelning? Detta tar bort filen permanent.")) {
            try {
                await invoke("delete_recording_db", { id });
                loadRecordings(); // Refresh list
            } catch (error) {
                console.error("Failed to delete recording:", error);
            }
        }
    };

    // Manuell historik-synk: tvinga moln-persistens (persistOverride=true) oavsett
    // cloudSync-inställningen. För att lyfta gamla lokala inspelningar till dashboarden.
    const handleSync = async (rec: Recording) => {
        // Knappen döljs för gallrade rader, men raden kan vara stale om auto-gallring
        // hann köra efter senaste listladdning — ge tydligt fel i stället för filfel.
        if (rec.audio_deleted) {
            showError('audio_deleted', "Ljudfilen är raderad — molnsynk kräver ljudet. Transkript och analys finns kvar.", { action: 'cloud_sync' });
            return;
        }
        const token = getToken();
        if (!token) { showError('unauthorized', "Logga in för att synka till molnet.", { action: 'cloud_sync' }); return; }
        setSyncingId(rec.id);
        try {
            toast.info("Synkar till molnet...");
            const job = await uploadJob(rec.file_path, "general", token, true, true);
            await invoke("update_recording_status", { id: rec.id, status: 'uploaded', cloudJobId: job.id });
            toast.success("Synkad till molnet — visas nu i dashboarden på sagt.ai.");
            // Optimistisk uppdatering så raden blir "Synkad" direkt — utan att kräva flikbyte/remount.
            setRecordings(prev => prev.map(r => r.id === rec.id ? { ...r, sync_status: 'uploaded', cloud_job_id: job.id } : r));
            loadRecordings();
        } catch (err: any) {
            if (err?.message?.includes("Payment Required")) showError('not_pro', "Molnsynk kräver Pro.", { action: 'cloud_sync' });
            else if (err?.message?.startsWith("Unauthorized")) showError('unauthorized', "Din session är inte längre giltig. Logga in igen.", { action: 'cloud_sync' });
            else showError(errorSlug(err), "Synk misslyckades: " + (err?.message || "okänt fel"), { action: 'cloud_sync' });
        } finally {
            setSyncingId(null);
        }
    };

    const formatDuration = (seconds: number) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    };

    return (
        <div className="flex flex-col h-full bg-paper-dim overflow-y-auto">
            <header className="px-8 py-6 border-b bg-white flex items-start justify-between gap-4">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight text-ink">Inspelningar</h1>
                    <p className="text-muted-foreground mt-1">
                        Inspelningar som ligger på den här datorn, med status för transkribering och molnsynk.
                    </p>
                </div>
                <button
                    onClick={() => openRecordingsFolder().catch((e) => {
                        console.error("Kunde inte öppna inspelningsmappen:", e);
                        toast.error("Kunde inte öppna mappen.");
                    })}
                    className="shrink-0 inline-flex items-center gap-1.5 text-sm text-brand hover:underline font-medium mt-1"
                >
                    <FolderOpen className="w-4 h-4" />
                    Öppna mapp
                </button>
            </header>

            <div className="p-8 max-w-6xl">
                {recordings.length > 0 && (
                    <div className="flex items-center justify-end gap-3 mb-3">
                        <span className="text-sm text-ink-muted">
                            {selected.size > 0 ? `${selected.size} valda` : "Välj möten att exportera"}
                        </span>
                        <Button
                            size="sm"
                            variant="outline"
                            disabled={selected.size === 0}
                            onClick={handleExportSelected}
                            className="gap-1.5"
                        >
                            <Download className="w-4 h-4" />
                            Exportera valda
                        </Button>
                    </div>
                )}
                <div className="bg-white rounded-lg border shadow-sm overflow-hidden">
                    {recordings.length === 0 ? (
                        <div className="p-12 text-center text-muted-foreground">
                            <FileAudio className="w-12 h-12 mx-auto mb-4 opacity-20" />
                            <p>Inga inspelningar än.</p>
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full text-sm text-left">
                                <thead className="bg-paper-dim border-b text-ink-muted font-medium">
                                    <tr>
                                        <th className="pl-6 pr-2 py-3 w-8">
                                            <SelectAllCheckbox
                                                checked={allSelected}
                                                indeterminate={selected.size > 0 && !allSelected}
                                                disabled={exportableIds.length === 0}
                                                onChange={(on) => setSelected(on ? new Set(exportableIds) : new Set())}
                                            />
                                        </th>
                                        <th className="px-6 py-3">Datum</th>
                                        <th className="px-6 py-3">Filnamn</th>
                                        <th className="px-6 py-3">Längd</th>
                                        <th className="px-6 py-3">Ljud</th>
                                        <th className="px-6 py-3">Transkribering & analys</th>
                                        <th className="px-6 py-3">Moln</th>
                                        <th className="px-6 py-3 text-right">Åtgärd</th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-line">
                                    {recordings.map((rec) => (
                                        <tr
                                            key={rec.id}
                                            className="hover:bg-brand/5 transition-colors group cursor-pointer"
                                            onClick={() => handleLoad(rec)}
                                        >
                                            <td className="pl-6 pr-2 py-4" onClick={(e) => e.stopPropagation()}>
                                                <input
                                                    type="checkbox"
                                                    aria-label="Välj för export"
                                                    className="h-4 w-4 accent-brand cursor-pointer disabled:cursor-not-allowed"
                                                    checked={selected.has(rec.id)}
                                                    disabled={!isExportable(rec)}
                                                    title={isExportable(rec) ? "Välj för export" : "Ingen transkription eller analys att exportera"}
                                                    onChange={(e) => toggleOne(rec.id, e.target.checked)}
                                                />
                                            </td>
                                            <td className="px-6 py-4 whitespace-nowrap">
                                                {format(new Date(rec.created_at), "d MMMM yyyy, HH:mm", { locale: sv })}
                                            </td>
                                            <td className="px-6 py-4 font-mono text-xs text-ink-soft truncate max-w-[200px]">
                                                {rec.filename}
                                            </td>
                                            <td className="px-6 py-4 font-mono text-ink-soft">
                                                {formatDuration(rec.duration_sec)}
                                            </td>
                                            {/* En statusdimension per kolumn, en bubbla per cell —
                                                Ljud (lokal fil), Transkribering & analys (lokal text), Moln (synk). */}
                                            <td className="px-6 py-4">
                                                {rec.audio_deleted ? (
                                                    <span
                                                        className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-paper-dim text-ink-muted border border-line"
                                                        title="Ljudfilen finns inte längre på datorn — gallrad enligt din lagringspolicy, eller borttagen utanför appen. Transkript och analys påverkas inte."
                                                    >
                                                        <FileAudio className="w-3 h-3" />
                                                        Saknas
                                                    </span>
                                                ) : (
                                                    <span
                                                        className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-verified/10 text-verified border border-verified/20"
                                                        title="Ljudfilen finns på den här datorn"
                                                    >
                                                        <FileAudio className="w-3 h-3" />
                                                        Finns
                                                    </span>
                                                )}
                                            </td>
                                            <td className="px-6 py-4">
                                                {rec.has_segments || rec.analysis_json ? (
                                                    <span
                                                        className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-verified/10 text-verified border border-verified/20"
                                                        title="Transkript och analys finns på den här datorn"
                                                    >
                                                        <FileText className="w-3 h-3" />
                                                        Finns
                                                    </span>
                                                ) : (
                                                    <span
                                                        className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-paper-dim text-ink-muted border border-line"
                                                        title="Ingen transkribering sparad för den här inspelningen"
                                                    >
                                                        <FileText className="w-3 h-3" />
                                                        Saknas
                                                    </span>
                                                )}
                                            </td>
                                            <td className="px-6 py-4">
                                                {syncingId === rec.id ? (
                                                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-brand/10 text-brand border border-brand/20">
                                                        <CloudUpload className="w-3 h-3 animate-pulse" />
                                                        Synkar…
                                                    </span>
                                                ) : rec.sync_status === 'uploaded' || rec.cloud_job_id ? (
                                                    <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-verified/10 text-verified border border-verified/20">
                                                        <Cloud className="w-3 h-3" />
                                                        Synkad
                                                    </span>
                                                ) : !rec.audio_deleted ? (
                                                    <span
                                                        className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-ochre-soft text-ochre border border-ochre/20"
                                                        title="Finns bara på den här datorn. Synka för att se den i dashboarden på sagt.ai."
                                                    >
                                                        <CloudUpload className="w-3 h-3" />
                                                        Ej synkad
                                                    </span>
                                                ) : (
                                                    /* Ljudfilen saknas och inspelningen synkades aldrig → synk är
                                                       omöjlig. Ett blankt "–" tvingade användaren att gissa varför
                                                       åtgärden inte fanns; säg orsaken i stället. */
                                                    <span
                                                        className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-paper-dim text-ink-muted border border-line"
                                                        title="Synk laddar upp ljudfilen, och den finns inte längre på datorn"
                                                    >
                                                        <Cloud className="w-3 h-3" />
                                                        Kan inte synkas
                                                    </span>
                                                )}
                                            </td>
                                            <td className="px-6 py-4 text-right">
                                                <div className="flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    {/* Synk laddar upp WAV:en — omöjligt när ljudfilen är gallrad */}
                                                    {isPro && !rec.audio_deleted && !(rec.sync_status === 'uploaded' || rec.cloud_job_id) && (
                                                        <Button
                                                            size="sm"
                                                            variant="ghost"
                                                            disabled={syncingId === rec.id}
                                                            onClick={(e) => { e.stopPropagation(); handleSync(rec); }}
                                                            className="h-8 px-2 text-xs text-brand hover:bg-brand/5 disabled:opacity-50"
                                                            title="Synka till molnet (visas i dashboarden)"
                                                        >
                                                            <CloudUpload className="w-4 h-4 mr-1" />
                                                            {syncingId === rec.id ? "Synkar..." : "Synka"}
                                                        </Button>
                                                    )}
                                                    <Button
                                                        size="sm"
                                                        variant="ghost"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            handleDelete(rec.id);
                                                        }}
                                                        className="h-8 w-8 p-0 text-red-500 hover:text-red-700 hover:bg-red-50"
                                                        title="Radera permanent"
                                                    >
                                                        <Trash2 className="w-4 h-4" />
                                                    </Button>
                                                </div>
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </div>

            <UpsellModal isOpen={showUpsell} onClose={() => setShowUpsell(false)} source="export" />
            <ExportDialog
                isOpen={showExport}
                onClose={() => setShowExport(false)}
                scope="selected"
                count={selectedRecs.length}
                transcriptCount={selectedRecs.filter(hasTranscriptSource).length}
                analysisCount={selectedRecs.filter(hasAnalysisSource).length}
                loadMeetings={() => collectMeetings(selectedRecs, pauseBreakMs)}
            />
        </div>
    );
}
