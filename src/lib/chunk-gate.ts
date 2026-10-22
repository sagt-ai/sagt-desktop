/**
 * Spärren för lokal text efter Avbryt.
 *
 * Ljudmotorn slutar skicka text när generationen bytts. Varje rad bär dessutom sin
 * sessionsgeneration, och Avbryt svarar med den generation som gäller därefter. Rader
 * från en äldre generation kastas här, så att en rad som redan var på väg när Avbryt
 * klickades inte visas.
 * ⚠️ ANTAGANDE: att en sådan rad kan levereras efter klicket. Ordningen mellan event och
 * kommandosvar är inte uppmätt i appen; spärren kostar ingenting om den aldrig behövs.
 *
 * Spärren stänger redan vid klicket, innan svaret kommit tillbaka. En ny inspelning får
 * en högre generation och släpps igenom.
 */
export interface ChunkGate {
    /** Avbryt klickat: släpp ingen lokal text tills svaret kommit. */
    beginCancel(): void;
    /** Avbryt klart. `generation` är det Avbryt svarade, eller undefined om det misslyckades. */
    finishCancel(generation: number | undefined): void;
    /** Ska raden visas? Rader utan generation (äldre ljudmotor) släpps igenom. */
    accept(generation: number | undefined): boolean;
}

export function createChunkGate(): ChunkGate {
    let minGeneration = 0;
    let highestSeen = -1;
    let cancelling = false;
    return {
        beginCancel() {
            cancelling = true;
        },
        finishCancel(generation) {
            // Misslyckades Avbryt vet vi inte vilken generation som gäller. Allt vi sett
            // hittills hör då till det som skulle avbrytas; nästa inspelning får en högre.
            const floor = typeof generation === "number" ? generation : highestSeen + 1;
            minGeneration = Math.max(minGeneration, floor);
            cancelling = false;
        },
        accept(generation) {
            if (cancelling) return false;
            if (typeof generation !== "number") return true;
            if (generation < minGeneration) return false;
            highestSeen = Math.max(highestSeen, generation);
            return true;
        },
    };
}

/** Den delade spärren: Avbryt-knappen stänger den, lyssnaren på lokal text frågar den. */
export const chunkGate = createChunkGate();
