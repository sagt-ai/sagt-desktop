import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

// Texten bygger på två skilda samband, ett per rad: datorn avgör tiden, modellen
// avgör kvaliteten. "Ungefär en fjärdedel färre fel" är KBLabs egna mätningar av
// KB-Whisper Large mot Small (färre ordfel på deras tre testmängder), inte vår
// mätning. Molnläget är ett val i Pro, därav "Pros molnläge".

/** "63 minuter", "1 minut", "45 sekunder". Under en minut i sekunder. */
export function meetingLengthText(seconds: number): string {
    if (seconds < 60) return `${seconds} ${seconds === 1 ? "sekund" : "sekunder"}`;
    const minutes = Math.round(seconds / 60);
    return `${minutes} ${minutes === 1 ? "minut" : "minuter"}`;
}

/** "2 min 10 s", "45 s". */
export function elapsedText(seconds: number): string {
    if (seconds < 60) return `${seconds} s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s === 0 ? `${m} min` : `${m} min ${s} s`;
}

// Egen komponent med egen klocka, så att bara den här raden ritas om varje sekund
// och inte hela transkriptvyn.
function SinceStop({ stoppedAt }: { stoppedAt: number }) {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
    }, []);
    return <strong className="font-semibold text-ink">{elapsedText(Math.max(0, Math.round((now - stoppedAt) / 1000)))}</strong>;
}

export function SlowLocalCard({
    meetingSeconds,
    stoppedAt,
    onDismiss,
    onCta,
}: {
    meetingSeconds: number | null;
    stoppedAt: number | null;
    onDismiss: () => void;
    onCta: () => void;
}) {
    return (
        <div className="max-w-sm rounded-xl border border-line bg-paper-dim p-4 mt-3 ml-1">
            <div className="flex items-start justify-between gap-3">
                <h4 className="text-xs font-semibold text-ink">Datorn avgör tiden, modellen avgör kvaliteten</h4>
                <button
                    onClick={onDismiss}
                    className="text-ink-muted hover:text-ink transition-colors flex-none"
                    aria-label="Visa inte igen"
                    title="Visa inte igen"
                >
                    <X className="w-3.5 h-3.5" />
                </button>
            </div>
            {meetingSeconds !== null && stoppedAt !== null && (
                <p className="text-xs text-ink-muted mt-1.5 leading-relaxed">
                    Mötet var <strong className="font-semibold text-ink">{meetingLengthText(meetingSeconds)}</strong>.
                    Det har gått <SinceStop stoppedAt={stoppedAt} /> sedan du tryckte Stopp.
                </p>
            )}
            <p className="text-xs text-ink-muted mt-2 leading-relaxed">
                <strong className="font-semibold text-ink">Tiden.</strong> Din dator transkriberar hela mötet själv
                och hinner inte med i mötets takt. Därför väntar du nu.
            </p>
            <p className="text-xs text-ink-muted mt-1 leading-relaxed">
                <strong className="font-semibold text-ink">Kvaliteten.</strong> För att en vanlig dator ska orka
                används en mindre modell, som gör fler fel. Den större modellen kräver kraftfullare maskiner.
            </p>
            <p className="text-xs text-ink-muted mt-2 leading-relaxed">
                Med Pros molnläge gör kraftfulla servrar i Sverige jobbet medan du spelar in, med den större
                modellen. Den gör ungefär en fjärdedel färre fel, enligt Kungliga bibliotekets mätningar.
            </p>
            <Button
                size="sm"
                className="mt-3 h-8 text-xs bg-brand text-paper hover:bg-brand-deep"
                onClick={onCta}
            >
                Se vad Pro ger
            </Button>
        </div>
    );
}

export function SlowLocalDoneLine({
    meetingSeconds,
    waitSeconds,
    onDismiss,
    onCta,
}: {
    meetingSeconds: number;
    waitSeconds: number;
    onDismiss: () => void;
    onCta: () => void;
}) {
    return (
        <div className="flex items-start gap-3 rounded-lg border border-line bg-paper-dim px-3 py-2 mb-4 text-xs text-ink-muted leading-relaxed">
            <p className="flex-1">
                Mötet på <strong className="font-semibold text-ink">{meetingLengthText(meetingSeconds)}</strong> tog{" "}
                <strong className="font-semibold text-ink">{meetingLengthText(waitSeconds)}</strong> att transkribera på
                den här datorn, med den mindre modellen. Med Pros molnläge är texten klar några sekunder efter
                Stopp, med en modell som gör ungefär en fjärdedel färre fel.{" "}
                <button onClick={onCta} className="font-semibold text-brand hover:underline">
                    Se vad Pro ger
                </button>
            </p>
            <button
                onClick={onDismiss}
                className="text-ink-muted hover:text-ink transition-colors flex-none mt-0.5"
                aria-label="Visa inte igen"
                title="Visa inte igen"
            >
                <X className="w-3.5 h-3.5" />
            </button>
        </div>
    );
}
