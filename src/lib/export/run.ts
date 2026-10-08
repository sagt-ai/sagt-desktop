// Ett tryck på Exportera, i ordning: bygg filen, fråga om exporten får göras, spara.
// Ren funktion med anropen inskickade, så att ordningen och nyckelns livslängd kan testas.
import type { ExportPermit } from "./quota";
import type { ExportBundle, ExportContent, ExportFile, ExportFormat, ExportMeeting, ExportOptions, ExportScope } from "./types";
import { filterForContent } from "./blocks";
import { effectiveBundle } from "./bundle";

/**
 * Nyckeln för en avsiktlig export. Samma nyckel tills en fil faktiskt sparats: avbryter
 * användaren "Spara som", eller misslyckas skrivningen, blir nästa försök ett omförsök
 * som servern inte räknar en gång till. Efter en sparad fil är nästa export en ny.
 */
export class ExportKey {
    private key: string | null = null;

    constructor(private readonly newKey: () => string = () => crypto.randomUUID()) {}

    current(): string {
        if (!this.key) this.key = this.newKey();
        return this.key;
    }

    done(): void {
        this.key = null;
    }
}

export type ExportRunResult =
    | { status: "saved"; via: "pro" | "online" | "offline"; count: number; bundle: ExportBundle }
    | { status: "cancelled" }
    | { status: "empty" }
    | { status: "denied"; permit: Extract<ExportPermit, { ok: false }> };

export async function runExport(o: {
    loadMeetings: () => Promise<ExportMeeting[]>;
    format: ExportFormat;
    content: ExportContent;
    bundle: ExportBundle;
    key: ExportKey;
    permit: (key: string) => Promise<ExportPermit>;
    build: (meetings: ExportMeeting[], opts: ExportOptions) => Promise<ExportFile>;
    save: (file: ExportFile, format: ExportFormat, bundle: ExportBundle) => Promise<boolean>;
}): Promise<ExportRunResult> {
    const meetings = filterForContent(await o.loadMeetings(), o.content);
    if (meetings.length === 0) return { status: "empty" };
    const used = effectiveBundle(meetings.length, o.bundle);
    // Filen byggs först, lokalt: ett fel i renderingen ska inte kosta en export.
    const file = await o.build(meetings, { format: o.format, content: o.content, bundle: used });
    // En export är ett tryck på Exportera, oavsett antal möten: en zip eller en samlad
    // fil med många möten drar en enhet.
    const permit = await o.permit(o.key.current());
    if (!permit.ok) return { status: "denied", permit };
    if (!(await o.save(file, o.format, used))) return { status: "cancelled" };
    o.key.done();
    return { status: "saved", via: permit.via, count: meetings.length, bundle: used };
}

/**
 * Fälten i `transcript_exported` för en sparad fil. `plan` följer tillståndet exporten
 * godkändes på: `via: "pro"` ges bara till Pro (permitExport), allt annat är gratiskontot.
 * `scope` säger varifrån exporten gjordes: current = transkriptvyn, selected = Inspelningar.
 */
export function exportedEventProps(
    result: Extract<ExportRunResult, { status: "saved" }>,
    choice: { format: ExportFormat; scope: ExportScope; content: ExportContent },
): { format: ExportFormat; scope: ExportScope; count: number; bundle: ExportBundle; content: ExportContent; plan: "free" | "pro" } {
    return {
        format: choice.format,
        scope: choice.scope,
        count: result.count,
        bundle: result.bundle,
        content: choice.content,
        plan: result.via === "pro" ? "pro" : "free",
    };
}
