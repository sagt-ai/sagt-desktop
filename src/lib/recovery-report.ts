/** Svaret från återställningen vid start. Speglar `RecoveryReport` i ljudmotorn. */
export interface RecoveryReport {
    recovered: number
    recovered_seconds: number
    interrupted: number
    discarded_short: number
    marker_matched: boolean
    marker_stopped: boolean
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** Notisen efter återställningen, eller null när det inte fanns något att återställa. */
export function recoveryToast(r: RecoveryReport): string | null {
    const parts: string[] = []
    if (r.recovered > 0) {
        parts.push(`${count(r.recovered, "inspelning", "inspelningar")} som inte hann sparas förra gången är återställd${r.recovered === 1 ? "" : "a"}.`)
    }
    if (r.interrupted > 0) {
        parts.push(`${count(r.interrupted, "inspelning", "inspelningar")} stängdes innan texten var klar. Ljudet är sparat.`)
    }
    if (parts.length === 0) return null
    return `${parts.join(" ")} Du hittar ${r.recovered + r.interrupted === 1 ? "den" : "dem"} i Inspelningar.`
}
