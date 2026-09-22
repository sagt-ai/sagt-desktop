import type { UISegment } from "@/store/transcription-store";

// Rena hjälpare för moln-strömningskön (hooks/use-cloud-stream.ts). Här i lib/ så att de
// kan testas utan Tauri och React.

/** Fel med HTTP-status från /transcribe-chunk. Meddelandet är oförändrat ("Payment
 *  Required: …", "Quota: …") eftersom kön och felnotisen läser det. */
export class ChunkHttpError extends Error {
    constructor(message: string, readonly status: number) {
        super(message);
        this.name = "ChunkHttpError";
    }
}

/** Ingen token lokalt. Ett omförsök ger samma svar, så det görs inte. */
export class MissingTokenError extends Error {
    constructor() {
        super("Ingen autentiseringstoken");
        this.name = "MissingTokenError";
    }
}

// 502 är backendens svar när Berget fallerar (transcribe_chunk.py). 2026-09-19 gav Bergets
// engelska modell 503 i några sekunder och minst en bit föll bort, eftersom kön bara gjorde
// ett omförsök efter 400 ms (AI_KNOWLEDGE_BASE §4). 429 är kvoten, inte en rate limit:
// Cloudflares regel gäller bara POST /api/v1/jobs (terraform/cloudflare.tf).
const RETRY_STATUS = new Set([408, 500, 502, 503, 504]);

/** Ett fel som kan gå över: nätverksfel (fetch kastar utan status) och serverfel. Aldrig
 *  400/413 (biten själv är fel), 401 (samma token igen), 402 (Pro) eller 429 (kvoten). */
export function isRetryableChunkError(e: unknown): boolean {
    if (e instanceof MissingTokenError) return false;
    if (e instanceof ChunkHttpError) return RETRY_STATUS.has(e.status);
    return true;
}

// Väntetid före omförsök 1–4: totalt ~12,5 s. Längre än ett par sekunders avbrott, men
// kort nog för att texten ska hinna in medan mötet pågår. En bit håller en av kön
// MAX_CONCURRENT platser medan den väntar.
const RETRY_DELAYS_MS = [500, 1500, 3500, 7000];
export const MAX_CHUNK_ATTEMPTS = RETRY_DELAYS_MS.length + 1;

/** Väntetid före nästa försök efter att försök `attempt` (0-baserat) fallerat, eller null
 *  när försöken är slut. ±20 % jitter så att tre samtidiga bitar inte slår i takt. */
export function retryDelayMs(attempt: number, random: () => number = Math.random): number | null {
    const base = RETRY_DELAYS_MS[attempt];
    if (base === undefined) return null;
    return Math.round(base * (0.8 + 0.4 * random()));
}

/** #7: lead-in:en (#5B) kan transkriberas i både bit N och N+1, så sista orden i ett stycke
 *  blir samma som första i nästa. Trimmar `newText`:s ledande ord som dubblerar
 *  `prevText`:s avslutande. Skiftläges-/skiljeteckensokänslig, ≥2 ord. */
export function stripOverlap(prevText: string, newText: string): string {
    const norm = (w: string) => w.toLowerCase().replace(/[.,!?;:]/g, "");
    const prev = prevText.trim().split(/\s+/).filter(Boolean);
    const next = newText.trim().split(/\s+/).filter(Boolean);
    if (prev.length === 0 || next.length === 0) return newText;
    const maxOverlap = Math.min(6, prev.length, next.length);
    for (let k = maxOverlap; k >= 2; k--) {
        const tail = prev.slice(prev.length - k).map(norm).join(" ");
        const head = next.slice(0, k).map(norm).join(" ");
        if (tail === head) return next.slice(k).join(" ");
    }
    return newText;
}

/**
 * Lägger in en molnbit på sin plats i tid, inte sist. Bitar blir klara i annan ordning än
 * de talades (tre samtidiga anrop, och omförsök som kan ta ~12 s), och analysen, talarturerna
 * och det som sparas läser storen i ordning. Visningen sorterade redan; nu gör storen det.
 *
 * Dubbletter trimmas mot grannarna i TID: bitens egen början mot föregående bit med samma
 * talare, och nästa bits början mot den här bitens slut — det är den senare biten som bär
 * lead-in:en. Returnerar null om inget återstår efter trimningen.
 */
export function insertCloudSegment(segments: UISegment[], seg: UISegment): UISegment[] | null {
    let at = segments.length;
    while (at > 0 && segments[at - 1].start_time > seg.start_time) at--;

    let prev: UISegment | undefined;
    for (let i = at - 1; i >= 0; i--) {
        if (segments[i].speaker === seg.speaker) { prev = segments[i]; break; }
    }
    const text = (prev ? stripOverlap(prev.text, seg.text) : seg.text).trim();
    if (!text) return null;

    const out = [...segments.slice(0, at), { ...seg, text }, ...segments.slice(at)];
    for (let i = at + 1; i < out.length; i++) {
        if (out[i].speaker !== seg.speaker) continue;
        const trimmed = stripOverlap(text, out[i].text).trim();
        // Blir nästa bit tom behålls den: att radera redan visad text på en gissning är
        // värre än ett dubblerat ord.
        if (trimmed && trimmed !== out[i].text) out[i] = { ...out[i], text: trimmed };
        break;
    }
    return out;
}
