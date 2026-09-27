import { useEffect, useState } from "react";
import { Download, Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Label } from "@/components/ui/label";
import { showError, usePostHogEvents } from "@/hooks/use-posthog-events";
import { buildExport, effectiveBundle } from "@/lib/export/bundle";
import { coverageHint, filterForContent } from "@/lib/export/blocks";
import { saveExportFile } from "@/lib/export/tauri-io";
import type { ExportBundle, ExportContent, ExportFormat, ExportMeeting, ExportScope } from "@/lib/export/types";

interface ExportDialogProps {
    isOpen: boolean;
    onClose: () => void;
    scope: ExportScope;
    /** Antal möten som exporteras. Vid fler än ett visas valet zip / samlad fil. */
    count: number;
    /** Hur många av mötena som har transkript respektive protokoll. */
    transcriptCount: number;
    analysisCount: number;
    /** Hämtar mötena först när användaren trycker Exportera. */
    loadMeetings: () => Promise<ExportMeeting[]>;
}

type Option<T extends string> = { value: T; label: string; disabled?: boolean };

function Choice<T extends string>({ title, value, onChange, options }: {
    title: string;
    value: T;
    onChange: (v: T) => void;
    options: Option<T>[];
}) {
    return (
        <fieldset className="space-y-2">
            <legend className="text-xs font-semibold uppercase tracking-wide text-ink-muted mb-2">{title}</legend>
            <RadioGroup value={value} onValueChange={v => onChange(v as T)}>
                {options.map(o => (
                    <div key={o.value} className="flex items-center gap-2.5">
                        <RadioGroupItem value={o.value} id={`export-${title}-${o.value}`} disabled={o.disabled} />
                        <Label
                            htmlFor={`export-${title}-${o.value}`}
                            className={`text-sm font-normal ${o.disabled ? "text-ink-muted" : "text-ink-soft"}`}
                        >
                            {o.label}
                        </Label>
                    </div>
                ))}
            </RadioGroup>
        </fieldset>
    );
}

function defaultContent(transcriptCount: number, analysisCount: number): ExportContent {
    if (transcriptCount > 0 && analysisCount > 0) return "both";
    return analysisCount > 0 ? "analysis" : "transcript";
}

export function ExportDialog({ isOpen, onClose, scope, count, transcriptCount, analysisCount, loadMeetings }: ExportDialogProps) {
    const events = usePostHogEvents();
    const [format, setFormat] = useState<ExportFormat>("docx");
    const [content, setContent] = useState<ExportContent>(() => defaultContent(transcriptCount, analysisCount));
    const [bundle, setBundle] = useState<ExportBundle>("zip");
    const [busy, setBusy] = useState(false);

    // Nytt urval → rimligt innehållsval igen (t.ex. inget protokoll i det nya urvalet).
    useEffect(() => {
        if (isOpen) setContent(defaultContent(transcriptCount, analysisCount));
    }, [isOpen, transcriptCount, analysisCount]);

    if (!isOpen) return null;

    const hint = coverageHint(content, count, transcriptCount, analysisCount);

    const run = async () => {
        setBusy(true);
        try {
            const meetings = filterForContent(await loadMeetings(), content);
            if (meetings.length === 0) {
                toast.error("Det finns inget att exportera.");
                return;
            }
            const used = effectiveBundle(meetings.length, bundle);
            const file = await buildExport(meetings, { format, content, bundle: used });
            if (!(await saveExportFile(file, format, used))) return; // avbröt i dialogen
            events.transcriptExported({ format, scope, count: meetings.length, bundle: used, content });
            toast.success(meetings.length > 1 ? `${meetings.length} möten exporterade.` : "Exporterat.");
            onClose();
        } catch (e) {
            console.error("[export]", e);
            showError("export_failed", "Exporten misslyckades. Försök igen eller välj en annan plats.", { format, scope });
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/30 backdrop-blur-sm animate-in fade-in duration-200">
            <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="export-title"
                className="bg-white rounded-2xl w-[420px] max-w-[90vw] shadow-2xl border border-line relative animate-in zoom-in-95 duration-200"
            >
                <div className="flex items-center justify-between px-6 pt-5 pb-3 border-b border-line">
                    <h2 id="export-title" className="text-base font-semibold text-ink flex items-center gap-2">
                        <Download className="w-4 h-4 text-brand" />
                        {count > 1 ? `Exportera ${count} möten` : "Exportera mötet"}
                    </h2>
                    <button onClick={onClose} disabled={busy} aria-label="Stäng" className="p-1 rounded text-ink-muted hover:text-ink hover:bg-paper-dim">
                        <X className="w-4 h-4" />
                    </button>
                </div>

                <div className="px-6 py-5 space-y-5">
                    <Choice
                        title="Format"
                        value={format}
                        onChange={setFormat}
                        options={[
                            { value: "docx", label: "Word (.docx)" },
                            { value: "md", label: "Markdown (.md)" },
                            { value: "txt", label: "Text (.txt)" },
                        ]}
                    />
                    <Choice
                        title="Innehåll"
                        value={content}
                        onChange={setContent}
                        options={[
                            { value: "both", label: "Transkription och protokoll", disabled: transcriptCount === 0 || analysisCount === 0 },
                            { value: "transcript", label: "Bara transkription", disabled: transcriptCount === 0 },
                            { value: "analysis", label: "Bara protokoll", disabled: analysisCount === 0 },
                        ]}
                    />
                    {hint && <p className="text-xs text-ink-muted -mt-2">{hint}</p>}
                    {count > 1 && (
                        <Choice
                            title="Flera möten"
                            value={bundle}
                            onChange={setBundle}
                            options={[
                                { value: "zip", label: "En fil per möte, i en zip-fil" },
                                { value: "combined", label: "En samlad fil, i datumordning" },
                            ]}
                        />
                    )}
                </div>

                <div className="flex gap-3 px-6 pb-6">
                    <button
                        onClick={onClose}
                        disabled={busy}
                        className="flex-1 py-2.5 px-4 rounded-lg bg-white border border-line text-sm font-medium text-ink-soft hover:bg-paper-dim transition-colors"
                    >
                        Avbryt
                    </button>
                    <button
                        onClick={run}
                        disabled={busy}
                        className="flex-[2] py-2.5 px-4 rounded-lg bg-brand border border-brand text-sm font-semibold text-paper hover:bg-brand-deep shadow-sm transition-colors disabled:opacity-70 flex items-center justify-center gap-2"
                    >
                        {busy ? <><Loader2 className="w-4 h-4 animate-spin" /> Exporterar...</> : "Exportera"}
                    </button>
                </div>
            </div>
        </div>
    );
}
