// Varning när mikrofonen inte tar upp något ljud alls under en inspelning, och mätning av
// nivåerna per kanal.
//
// Underlaget (90 dagar till 2026-10-10): i de inspelningar där mikrofonen aldrig nådde
// talgränsen låg dess högsta nivå på 0,0002–0,0021, medan vanligt tal ligger runt 0,3.
// Det är inte en för hög gräns utan en mikrofon som inget hör: fel mikrofon vald, avstängd,
// eller utan behörighet. En lägre gräns hade bara låtit transkriberingen starta på brus.
// Därför varnas användaren i stället, och inget i transkriberingen ändras.
//
// Nivåerna är samma mått som ljudmotorn jämför med talgränsen (RMS per ljudblock), och
// kommer med motorns nivåhändelser ungefär 20 gånger i sekunden. Bara siffror, aldrig ljud.
//
// Håll modulen importfri, som upsell-state.ts, så att Vitest kan köra den i node-miljö.

/** Under den här högsta nivån har mikrofonen inte hört något alls. En fungerande mikrofon
 *  fångar oftast andning, stolar och tangenter över den inom en minut. */
export const MIC_SILENT_LEVEL = 0.001
/** Hur länge mikrofonen ska ha varit tyst från inspelningens start innan varningen visas.
 *  60 s sedan 2026-10-14: efter 30 s varnades tysta lyssnare med en mikrofon eller ett
 *  headset som spärrar brus, så att nivån står på noll tills de pratar. Sedan 0.12.0
 *  släcktes alla tre varningarna senare, alltså fungerade mikrofonen hela tiden. */
export const MIC_SILENT_AFTER_MS = 60_000
/** Över den här nivån har mikrofonen hört något, och en visad varning släcks. Högre än
 *  varningsgränsen, så att en nivå som vandrar runt gränsen inte tänder och släcker. */
export const MIC_RECOVERED_LEVEL = 0.002

// Formulerad som ett villkor, inte som ett fel: en tyst lyssnare kan inte skiljas från en
// mikrofon som inget hör. Visas bara som notis, inte som kvarliggande rad.
export const MIC_SILENT_TEXT =
    "Mikrofonen har inte hört något än. Pratar du utan att din text syns, kontrollera att rätt mikrofon är vald."

/**
 * Fördelningen av nivåer under en inspelning, i logaritmiska fack, så att percentiler går
 * att räkna utan att spara varje värde. Fack nedåt till 1e-6; lägre (och 0) hamnar i första.
 */
export class LevelStats {
    private static readonly BINS = 120 // 20 per dekad, 1e-6 … 1
    private readonly bins = new Array<number>(LevelStats.BINS).fill(0)
    count = 0
    max = 0

    add(level: number): void {
        if (!Number.isFinite(level) || level < 0) return
        this.count++
        if (level > this.max) this.max = level
        const i = level <= 1e-6 ? 0 : Math.min(LevelStats.BINS - 1, Math.floor((Math.log10(level) + 6) * 20))
        this.bins[i]++
    }

    /** Övre kanten av facket där kvantilen q (0–1) faller, eller 0 utan värden. */
    quantile(q: number): number {
        if (this.count === 0) return 0
        const target = Math.max(1, Math.ceil(q * this.count))
        let seen = 0
        for (let i = 0; i < LevelStats.BINS; i++) {
            seen += this.bins[i]
            if (seen >= target) return Math.min(this.max, Math.pow(10, (i + 1) / 20 - 6))
        }
        return this.max
    }
}

export type MicSilenceEvent = "warn" | "recovered" | null

export class MicSilenceDetector {
    readonly mic = new LevelStats()
    readonly sys = new LevelStats()
    private readonly startedAt: number
    private warnedAt: number | null = null
    private recovered = false

    constructor(startedAt: number) {
        this.startedAt = startedAt
    }

    /** Ett nivåvärde per kanal. Returnerar "warn" en gång per inspelning, och "recovered"
     *  en gång när mikrofonen hörs efter en varning. */
    sample(mic: number, sys: number, now: number): MicSilenceEvent {
        this.mic.add(mic)
        this.sys.add(sys)
        if (this.warnedAt === null) {
            if (now - this.startedAt >= MIC_SILENT_AFTER_MS && this.mic.max < MIC_SILENT_LEVEL) {
                this.warnedAt = now
                return "warn"
            }
            return null
        }
        if (!this.recovered && mic > MIC_RECOVERED_LEVEL) {
            this.recovered = true
            return "recovered"
        }
        return null
    }

    get warned(): boolean {
        return this.warnedAt !== null
    }

    /** Egenskaperna till `recording_levels` vid stopp. Bara nivåer och tider. */
    summary(now: number) {
        const r = (n: number) => Math.round(n * 100000) / 100000
        return {
            seconds: Math.max(0, Math.round((now - this.startedAt) / 1000)),
            samples: this.mic.count,
            mic_p10: r(this.mic.quantile(0.1)),
            mic_p50: r(this.mic.quantile(0.5)),
            mic_p90: r(this.mic.quantile(0.9)),
            mic_max: r(this.mic.max),
            sys_p50: r(this.sys.quantile(0.5)),
            sys_max: r(this.sys.max),
            mic_silent_warned: this.warned,
            mic_recovered: this.recovered,
        }
    }
}
