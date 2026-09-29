import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { useSyncStore, AnalysisData } from "@/store/sync-store";
import { useTranscriptionStore, UISegment } from "@/store/transcription-store";
import { captureEvent } from "@/hooks/use-posthog-events";
import type { Job } from "./api";

/** Visas när molnjobbet blev klart men analysen inte. Transkriptet är sparat. */
export const ANALYSIS_FAILED_MESSAGE =
    "AI-analysen misslyckades. Transkriptet är sparat, försök igen med Starta analys.";

/**
 * Analysen ur ett klart molnjobb, eller null om jobbet inte har någon att visa.
 *
 * null betyder: skriv INTE över den analys som redan visas eller ligger i den lokala
 * databasen, och räkna det inte som en lyckad analys. Tidigare blev `job.analysis || {}` en
 * tom analys som sparades över den befintliga, till exempel vid en omtranskribering.
 * Servern sätter `analysis = null` och `result.analysis_failed = true` när Berget inte
 * levererade. Samma gäller ett jobb som bara
 * transkriberades, där `analysis` är en skip-markör utan sammanfattning.
 */
export function analysisFromJob(job: Job): AnalysisData | null {
    if (!job.analysis || job.result?.analysis_failed) return null;
    // Transkribering utan analys ger {"status": "skipped", "message": …} utan sammanfattning.
    // Det är ingen analys och får inte skriva över den som finns.
    if (typeof job.analysis.summary !== "string" || !job.analysis.summary.trim()) return null;
    const analysis = job.analysis;
    return {
        summary: analysis.summary || "",
        decisions: analysis.key_decisions || [],
        actions: analysis.action_items || [],
        template_used: analysis.template_used,
    };
}

/**
 * Fas 1c: extrahera strukturerade DU/MÖTET-turer ur ett molnresultat (stereo-omtranskribering)
 * som JSON för persistens i `cloud_segments`. Returnerar null när segmenten saknar riktiga
 * talare (mono-resultat) — då behålls den flata `cloud_transcript`-blobben i molnvyn.
 * Backend-segmenten bär `{start, end, text, speaker}`; vi normaliserar till lagringsformen
 * `{start_time, end_time, text, speaker}` som split-view:s render läser direkt.
 */
export function cloudSegmentsJsonFromJob(job: Job): string | null {
    const raw: any[] = Array.isArray(job.result?.segments) ? job.result.segments : [];
    // Fas 2: acceptera ALLA riktiga talaretiketter (DU/MÖTET men även diariserade TALARE 1/2,
    // DU 1, MÖTET 2 …) — inte bara de två kanaletiketterna. Utan detta kollapsar en mono-
    // diarisering (TALARE N) till den flata blobben i stället för att rendera turer.
    const hasSpeakers = raw.some(s => s?.speaker && s.speaker !== "MOLN");
    if (!hasSpeakers) return null;
    const mapped = raw
        .filter(s => (s?.text ?? "").toString().trim())
        .map(s => ({
            start_time: typeof s.start === "number" ? s.start : 0,
            end_time: typeof s.end === "number" ? s.end : 0,
            text: String(s.text).trim(),
            speaker: s.speaker || "MÖTET",
        }));
    return mapped.length > 0 ? JSON.stringify(mapped) : null;
}

// Fas 2 (R4): en NY diarisering kan numrera om talarna (TALARE 1 ↔ TALARE 2), så en sparad
// speaker_map som namnger de gamla numren pekar då fel. Instabila = numrerade etiketter
// (TALARE N, DU N, MÖTET N); stabila = bara "DU"/"MÖTET" (1-talarkanal, samma varje gång).
const UNSTABLE_SPEAKER_KEY = /^(TALARE|DU|MÖTET)\s+\d+$/;

/** True om cloud_segments-JSON:en innehåller numrerade diariserings-etiketter (ny diarisering). */
export function segmentsHaveDiarizationLabels(cloudSegmentsJson: string | null): boolean {
    if (!cloudSegmentsJson) return false;
    try {
        const arr = JSON.parse(cloudSegmentsJson);
        return Array.isArray(arr) && arr.some((s: any) => UNSTABLE_SPEAKER_KEY.test(s?.speaker ?? ""));
    } catch { return false; }
}

/** Returnerar en kopia av speaker_map utan instabila (omnumrerbara) nycklar. Delas av
 *  DB-invalideringen och SplitViews in-memory-state så de aldrig divergerar (R4). */
export function stripUnstableSpeakerMapKeys(map: Record<string, string>): Record<string, string> {
    const kept: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
        if (!UNSTABLE_SPEAKER_KEY.test(k)) kept[k] = v;
    }
    return kept;
}

/**
 * R4: strippa instabila (omnumrerbara) speaker_map-nycklar när en ny diarisering skrivs, så
 * gamla namn inte hänger kvar på fel röst. Behåller participants + stabila DU/MÖTET-nycklar.
 * Skriver till sqlite och returnerar den nya payloaden — eller null om inget behövde ändras.
 */
export async function invalidateStaleSpeakerMap(
    recordingDbId: number | null,
    speakerMapRaw: string | null | undefined,
): Promise<string | null> {
    if (recordingDbId == null || !speakerMapRaw) return null;
    let parsed: any;
    try { parsed = JSON.parse(speakerMapRaw); } catch { return null; }
    const map = parsed?.map && typeof parsed.map === "object" ? parsed.map : {};
    const kept = stripUnstableSpeakerMapKeys(map);
    if (Object.keys(kept).length === Object.keys(map).length) return null; // inget instabilt att strippa
    // STEG 2: bevara auto-provenance men filtrera bort nycklar som strippades (deras auto-status
    // är meningslös när namnet är borta) — annars skulle en auto-satt stabil nyckel felaktigt bli
    // "användarsatt" (auto tomt ⇒ skyddad mot framtida auto-förfining).
    const auto = Array.isArray(parsed?.auto) ? parsed.auto.filter((k: string) => k in kept) : [];
    const payload = JSON.stringify({
        map: kept,
        participants: Array.isArray(parsed?.participants) ? parsed.participants : [],
        auto,
    });
    try {
        await invoke("save_speaker_map_to_db", { id: recordingDbId, speakerMap: payload });
    } catch (e) {
        console.error("R4 speaker_map-invalidering misslyckades:", e);
        return null;
    }
    return payload;
}

/**
 * Applicerar ett INLINE molnresultat (persist=false / cloudSync av) direkt i UI-storarna
 * UTAN polling. Speglar polling-COMPLETED-handlern i split-view, men eftersom backend
 * raderar moln-jobbet direkt finns inget att polla — resultatet kom inline i POST-svaret.
 *
 * Sparar resultatet i LOKAL sqlite (inget i molnet, inget cloud_job_id). Returnerar
 * ordantal för `events.cloudSyncCompleted`-analytics.
 */
export async function applyInlineCloudResult(job: Job, recordingDbId: number | null): Promise<number> {
    const sync = useSyncStore.getState();

    const completedAnalysis = analysisFromJob(job);
    if (completedAnalysis) {
        sync.setAnalysisData(completedAnalysis);
    } else if (job.result?.analysis_failed) {
        captureEvent("analysis_failed", { error: "analysis_failed_server", source: "cloud_job" });
        toast.error(ANALYSIS_FAILED_MESSAGE);
    }
    sync.setProcessingStatus("COMPLETED");

    const cloudText: string | undefined = job.result?.text;
    // Fas 1c: strukturerade DU/MÖTET-turer (stereo) → rendera turer i molnvyn i stället för
    // den flata blobben. Null för mono (inga talare) → flat blob behålls.
    const cloudSegmentsJson = cloudSegmentsJsonFromJob(job);
    let wordCount = 0;
    if (cloudText && cloudText.trim()) {
        wordCount = cloudText.trim().split(/\s+/).filter(Boolean).length;
        // Skriv ALDRIG över lokala/diariserade segment — molnresultatet lagras separat
        // (cloud_transcript/cloud_segments) och visas via modellväxlaren i SplitView. Endast
        // när inget annat resultat finns (batch-only) OCH molnet saknar strukturerade turer
        // sätts den flata blobben direkt som segment; med strukturerade turer renderar molnvyn
        // dem via activeJob.cloud_segments (ingen falsk "lokal"-flik med samma text).
        if (useTranscriptionStore.getState().segments.length === 0 && !cloudSegmentsJson) {
            const cloudSegment: UISegment = {
                id: -1,
                start_time: 0,
                end_time: 0,
                text: cloudText.trim(),
                speaker: "MOLN",
                timestamp: Date.now(),
            };
            useTranscriptionStore.getState().setSegments([cloudSegment]);
        }
        // Persistera molnresultatet i lokal sqlite — modellväxlaren fungerar då även
        // efter omstart/återöppning från historiken.
        if (recordingDbId != null) {
            try {
                await invoke("save_cloud_transcript_to_db", {
                    id: recordingDbId,
                    transcript: cloudText.trim(),
                });
            } catch (e) {
                console.error("Local save (cloud transcript) failed:", e);
            }
        }
    }

    // Persist i LOKAL sqlite så resultatet överlever flikbyten — inget skickas/sparas i molnet.
    if (recordingDbId != null) {
        try {
            if (completedAnalysis) {
                await invoke("save_analysis_to_db", {
                    id: recordingDbId,
                    analysis: JSON.stringify(completedAnalysis),
                    template: completedAnalysis.template_used || "general",
                });
            }
            // Skriv ALLTID cloud_segments (tom sträng = rensa) så DB och in-memory aldrig
            // divergerar — annars skulle en stereo→mono-omtranskribering lämna kvar gamla
            // turer i DB medan activeJob nollställs → stale turer vid återöppning.
            await invoke("save_cloud_segments_to_db", {
                id: recordingDbId,
                cloudSegments: cloudSegmentsJson || "",
            });
        } catch (e) {
            console.error("Local save (inline cloud result) failed:", e);
        }
    }

    // R4: en ny diarisering (numrerade etiketter i de nya turerna) → invalidera instabila
    // speaker_map-nycklar så gamla namn inte hänger kvar på fel omnumrerad röst.
    const activeJob = sync.activeJob;
    let speakerMapRaw: string | null = activeJob?.speaker_map ?? null;
    if (recordingDbId != null && segmentsHaveDiarizationLabels(cloudSegmentsJson)) {
        const invalidated = await invalidateStaleSpeakerMap(recordingDbId, speakerMapRaw);
        if (invalidated) speakerMapRaw = invalidated;
    }

    // Uppdatera activeJob med cloud_transcript + cloud_segments — men INGET cloud_job_id (ej synkat till moln).
    if (activeJob) {
        sync.setActiveJob({
            ...activeJob,
            analysis_json: completedAnalysis ? JSON.stringify(completedAnalysis) : activeJob.analysis_json,
            cloud_transcript: cloudText || null,
            cloud_segments: cloudSegmentsJson,
            speaker_map: speakerMapRaw,
        });
    }

    return wordCount;
}
