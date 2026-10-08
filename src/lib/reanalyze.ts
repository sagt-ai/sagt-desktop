import { invoke } from "@tauri-apps/api/core";
import { CloudJobNotFoundError, reanalyzeJob, reanalyzeTranscript } from "@/lib/api";
import { IdempotencyKeys, requestProtocol } from "@/lib/entitlements";

/**
 * Idempotensnycklarna för protokoll på den lokala texten. En instans för appen, så att ett
 * omförsök av samma text återanvänder nyckeln även om vyn byggts om under tiden.
 */
export const protocolKeys = new IdempotencyKeys();

/**
 * Den bästa texten som finns sparad på datorn för en omanalys: molntranskriptet om det finns,
 * annars de lokala segmenten. Molntexten kommer från den större modellen och är den som visas i
 * molnvyn. Texten går inte att redigera i appen, så inga ändringar av användaren går förlorade.
 */
export function bestSavedText(
    recording: { cloud_transcript?: string | null } | null | undefined,
    segments: { text: string }[],
): string {
    const cloud = recording?.cloud_transcript?.trim();
    return cloud || segments.map(s => s.text).join(" ");
}

export interface ReanalyzeOutcome {
    /** Analysen i backendens form: summary, key_decisions, action_items, template_used. */
    raw: any;
    /** Molnjobbet fanns inte längre, så analysen gjordes på den lokala texten i stället. */
    cloudJobGone: boolean;
}

/**
 * "Analysera igen" för en inspelning. Ett synkat molnjobb körs om i molnet, så att dashboarden
 * matchar desktop. Annars analyseras den visade texten statelesst.
 *
 * Svarar molnet 404 är jobbet borta: TTL raderar det efter 90 dagar, och användaren kan ha
 * raderat det i webben. Tidigare visade appen då "Kunde inte uppdatera analys." och gjorde
 * ingenting. Nu analyseras den lokala texten, och anroparen glömmer
 * `cloud_job_id` så att nästa omanalys går den stateless vägen direkt.
 */
export async function reanalyzeRecording(opts: {
    cloudJobId: string | null | undefined;
    cloudSync: boolean;
    fullText: string;
    templateId: string;
    token: string;
    /** Nycklarna för den stateless vägen. Utan dem skickas ingen nyckel (bara Pro klarar sig utan). */
    keys?: IdempotencyKeys;
}): Promise<ReanalyzeOutcome> {
    const { cloudJobId, cloudSync, fullText, templateId, token, keys } = opts;
    const stateless = () => keys
        ? requestProtocol({ text: fullText, templateId, token, keys, call: reanalyzeTranscript })
        : reanalyzeTranscript(fullText, templateId, token);
    let outcome: ReanalyzeOutcome;
    if (cloudJobId && cloudSync) {
        try {
            const job = await reanalyzeJob(cloudJobId, templateId, token);
            outcome = { raw: job.analysis, cloudJobGone: false };
        } catch (e) {
            if (!(e instanceof CloudJobNotFoundError)) throw e;
            outcome = { raw: await stateless(), cloudJobGone: true };
        }
    } else {
        outcome = { raw: await stateless(), cloudJobGone: false };
    }
    // Ett svar utan sammanfattning är ingen analys, även om servern svarade 200: det ska
    // behandlas som ett misslyckande så att den sparade analysen står kvar orörd.
    if (typeof outcome.raw?.summary !== "string" || !outcome.raw.summary.trim()) {
        throw new Error("Omanalysen gav ingen sammanfattning.");
    }
    return outcome;
}

/**
 * Glöm ett molnjobb som inte finns längre: inspelningen blir "local" igen, så att nästa omanalys
 * går den stateless vägen direkt och knappen Synka visas. Returnerar fälten att lägga på
 * activeJob, eller null om det inte gick att spara (analysen står kvar, och nästa omanalys faller
 * tillbaka igen).
 */
export async function forgetCloudJob(recordingId: number): Promise<{ sync_status: "local"; cloud_job_id: null } | null> {
    try {
        await invoke("update_recording_status", { id: recordingId, status: "local", cloudJobId: null });
        return { sync_status: "local", cloud_job_id: null };
    } catch (e) {
        console.error("Kunde inte glömma det raderade molnjobbet:", e);
        return null;
    }
}
