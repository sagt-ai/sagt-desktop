// Ren, enhetstestbar kärna för talarnamngivning — delas av den manuella "Namnge talare
// igen", §13.1 post-diariserings-auto-kedjan och STEG 2:s live-namngivningsloop.
//
// VIKTIGT: håll den STATISKA importgrafen ren (endast `import type`). `identifySpeakers`
// laddas via dynamisk import inuti `autoIdentify` så att modulen kan importeras i en ren
// Node-testmiljö utan att dra in api.ts → settings-store → Zustand-persist (som läser
// localStorage vid hydrering och kraschar utanför webbläsaren).
import type { UISegment } from "@/store/transcription-store";
import type { SpeakerTurn } from "@/lib/api";

export type SpeakerMap = Record<string, string>;

/** Varifrån ett automatiskt namn kom: protokollet (namnförslag när protokollet skapas) eller
 *  "Namnge talare igen". Namn från molninspelningens live- och stoppnamngivning saknar källa. */
export type AutoSource = "protocol" | "identify";

/** Persisterad talardata i `recordings.speaker_map`. `auto` är provenance (STEG 2) —
 *  vilka nycklar som satts av auto-namngivningen, så en användarredigering kan skydda
 *  sin nyckel mot framtida auto-överskrivning. Bakåtkompatibel: äldre rader saknar `auto`.
 *  `auto_source` säger varifrån ett automatiskt namn kom och används bara för att mäta hur
 *  ofta förslagen rättas; den sparas bara på datorn. */
export interface SpeakerData {
    map: SpeakerMap;
    participants: string[];
    auto: string[];
    auto_source?: Record<string, AutoSource>;
}

/** Svaret från servern när den föreslår namn: en person per etikett i `speaker_map`, och flera
 *  namngivna personer på samma kanal i `speaker_groups` (etikett → två till fyra namn). */
export interface NamingResult {
    speaker_map?: SpeakerMap;
    speaker_groups?: Record<string, string[]>;
}

/** Visningen av flera personer på samma kanal: upp till tre namn med snedstreck, fler som
 *  "Anna, Lasse +2". Blir en vanlig sträng i talarkartan, så att export, kopiering och webben
 *  visar den utan ändringar och användaren rättar den som vilket namn som helst. */
export function formatSpeakerGroup(names: string[]): string {
    const clean = names.map(n => n.trim()).filter(Boolean);
    if (clean.length <= 3) return clean.join("/");
    return `${clean[0]}, ${clean[1]} +${clean.length - 2}`;
}

/** Förslagen som en platt karta etikett → namn, grupper inräknade. Servern lägger aldrig samma
 *  etikett i båda; skulle den göra det vinner den enskilda personen. */
export function suggestionsFromResult(result: NamingResult | null | undefined): SpeakerMap {
    const out: SpeakerMap = {};
    for (const [label, names] of Object.entries(result?.speaker_groups ?? {})) {
        if (!Array.isArray(names)) continue;
        const shown = formatSpeakerGroup(names.filter((n): n is string => typeof n === "string"));
        if (shown) out[label] = shown;
    }
    for (const [label, name] of Object.entries(result?.speaker_map ?? {})) {
        if (typeof name === "string" && name.trim()) out[label] = name;
    }
    return out;
}

/**
 * Lägg serverns förslag ovanpå den gällande talardatan. Delas av protokollet och "Namnge
 * talare igen", så att båda räknar och mergar likadant. Användarsatta namn rörs aldrig
 * (mergeSuggestions). `current` ska vara FÄRSK: användaren kan ha bytt namn under anropet.
 *
 * Returnerar ny talardata, antalet namn som faktiskt ändrades, och hur många av dem som var
 * grupper. Ett tomt förslag ger `applied: 0` och oförändrad data.
 */
export function applyNamingResult(
    current: SpeakerData,
    result: NamingResult | null | undefined,
    source: AutoSource,
): { data: SpeakerData; applied: number; groupsApplied: number } {
    const suggested = suggestionsFromResult(result);
    const merged = mergeSuggestions(current.map, suggested, current.auto);
    const changed = Object.keys(merged.map).filter(k => merged.map[k] !== current.map[k]);
    const groups = new Set(Object.keys(result?.speaker_groups ?? {}));
    const kept = new Set(merged.autoKeys);
    const auto_source: Record<string, AutoSource> = {};
    for (const [k, v] of Object.entries(current.auto_source ?? {})) if (kept.has(k)) auto_source[k] = v;
    for (const k of changed) auto_source[k] = source;
    return {
        data: { ...current, map: merged.map, auto: merged.autoKeys, auto_source },
        applied: changed.length,
        groupsApplied: changed.filter(k => groups.has(k) && !(k in (result?.speaker_map ?? {}))).length,
    };
}

// Kanonisk etikett: mic/DU → "DU", sys/MÖTET → "MÖTET" (segment kan bära endera formen).
// Mappning och hints nycklas på den kanoniska formen så de två varianterna inte splittras.
// Delad källa — SplitView importerar denna i stället för en lokal dubblett.
export function speakerKey(sp: string): string {
    return (sp === "mic" || sp === "DU") ? "DU" : (sp === "sys" || sp === "MÖTET") ? "MÖTET" : sp;
}

/**
 * Bygg kanoniska talarturer ur strömmade/visade segment. Generaliserar `turnsFromJob`
 * (split-view.tsx) från ett jobbresultat till godtyckliga `UISegment[]` (t.ex. live-
 * segmenten i transcription-store). Filtrerar bort MOLN (sammanhängande molntext utan
 * talare) och tomma texter; nycklarna kanoniseras.
 */
export function buildTurnsFromSegments(segments: UISegment[]): SpeakerTurn[] {
    return segments
        .map(s => ({
            speaker: speakerKey(String(s?.speaker ?? "")),
            text: String(s?.text ?? "").trim(),
            start: typeof s?.start_time === "number" ? s.start_time : null,
        }))
        .filter(t => t.text && t.speaker && t.speaker !== "MOLN");
}

/**
 * Provenance-styrd merge av LLM-förslag ovanpå den gällande namnmappningen.
 *
 * INVARIANT: ett auto-satt namn får förfinas av en senare auto-körning; ett ANVÄNDARSATT
 * namn (finns i `base` men INTE i `autoKeys`) rörs ALDRIG. En nyckel som saknas i `base`
 * får sitt förslag och registreras som auto. Fixar dagens bugg `{ ...base, ...suggested }`
 * som lät ett auto-förslag skriva över manuellt inskrivna namn.
 *
 * Muterar inte inparametrarna. Returnerar ny map + ny auto-lista.
 */
export function mergeSuggestions(
    base: SpeakerMap,
    suggested: SpeakerMap,
    autoKeys: string[],
): { map: SpeakerMap; autoKeys: string[] } {
    const map: SpeakerMap = { ...base };
    const auto = new Set(autoKeys);
    for (const [key, name] of Object.entries(suggested)) {
        if (!name || !name.trim()) continue;
        const isUserSet = key in base && !auto.has(key);
        if (isUserSet) continue; // användaren vinner alltid
        map[key] = name;
        auto.add(key);
    }
    return { map, autoKeys: [...auto] };
}

/** Serialisera talardata till DB-payloaden `{map, participants, auto}`, plus `auto_source`
 *  när den har något för en nyckel som fortfarande är automatisk. */
export function serializeSpeakerData(data: SpeakerData): string {
    const auto = new Set(data.auto);
    const source = Object.fromEntries(Object.entries(data.auto_source ?? {}).filter(([k]) => auto.has(k)));
    return JSON.stringify(Object.keys(source).length > 0
        ? { map: data.map, participants: data.participants, auto: data.auto, auto_source: source }
        : { map: data.map, participants: data.participants, auto: data.auto });
}

const AUTO_SOURCES: readonly string[] = ["protocol", "identify"];

/** Parsa DB-payloaden bakåtkompatibelt. Saknat/trasigt fält → tom default (`auto: []`
 *  för rader skrivna före STEG 2). */
export function parseSpeakerData(raw: string | null | undefined): SpeakerData {
    if (!raw) return { map: {}, participants: [], auto: [] };
    try {
        const p = JSON.parse(raw);
        const auto_source: Record<string, AutoSource> = {};
        if (p?.auto_source && typeof p.auto_source === "object") {
            for (const [k, v] of Object.entries(p.auto_source)) {
                if (typeof v === "string" && AUTO_SOURCES.includes(v)) auto_source[k] = v as AutoSource;
            }
        }
        return {
            map: p?.map && typeof p.map === "object" ? p.map : {},
            participants: Array.isArray(p?.participants) ? p.participants : [],
            auto: Array.isArray(p?.auto) ? p.auto : [],
            ...(Object.keys(auto_source).length > 0 ? { auto_source } : {}),
        };
    } catch {
        return { map: {}, participants: [], auto: [] };
    }
}

/**
 * Bygg turer ur segmenten → anropa `identifySpeakers` → returnera RÅA LLM-förslag (etikett → namn).
 * Ingen merge, ingen persistens: anroparen mergar själv (mergeSuggestions) mot FÄRSK state, vilket
 * är nödvändigt för race-säkerhet i live-loopen — användaren kan ha döpt om en talare medan anropet
 * var i luften, och den rename:n måste vinna. Returnerar `null` när det inte finns turer att
 * identifiera eller LLM:en inte gav några namn (då ska staten lämnas oförändrad).
 *
 * `identifySpeakers` laddas dynamiskt (se filhuvudet) så modulens statiska graf förblir ren.
 */
export async function autoIdentify(
    segments: UISegment[],
    participantHints: string[],
    token: string,
): Promise<SpeakerMap | null> {
    const turns = buildTurnsFromSegments(segments);
    if (turns.length === 0) return null;
    const { identifySpeakers } = await import("@/lib/api");
    const result = await identifySpeakers(turns, participantHints, token);
    // Grupper ("Anna/Lasse") följer med som vanliga namn, så att live- och stoppnamngivningen
    // visar dem precis som protokollet gör.
    const suggested = suggestionsFromResult(result);
    if (Object.keys(suggested).length === 0) return null;
    return suggested;
}
