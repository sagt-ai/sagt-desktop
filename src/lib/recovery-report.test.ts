import { describe, it, expect } from "vitest"
import { recoveryToast, type RecoveryReport } from "./recovery-report"

const none: RecoveryReport = {
    recovered: 0, recovered_seconds: 0, interrupted: 0, discarded_short: 0,
    marker_matched: false, marker_stopped: false,
}

describe("recoveryToast", () => {
    it("ingen notis när inget återställdes, inte heller för bortrensade korta filer", () => {
        expect(recoveryToast(none)).toBeNull()
        expect(recoveryToast({ ...none, discarded_short: 3 })).toBeNull()
    })

    it("en återställd inspelning", () => {
        expect(recoveryToast({ ...none, recovered: 1, recovered_seconds: 5820 })).toBe(
            "1 inspelning som inte hann sparas förra gången är återställd. Du hittar den i Inspelningar.",
        )
    })

    it("flera, och avbrutna", () => {
        expect(recoveryToast({ ...none, recovered: 2, interrupted: 1 })).toBe(
            "2 inspelningar som inte hann sparas förra gången är återställda. " +
            "1 inspelning stängdes innan texten var klar. Ljudet är sparat. Du hittar dem i Inspelningar.",
        )
    })
})
