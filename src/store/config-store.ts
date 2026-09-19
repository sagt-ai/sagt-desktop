import { create } from "zustand"
import { CURRENT_VERSION } from "@/lib/version"

function semverGt(a: string, b: string): boolean {
    const pa = a.split(".").map(Number)
    const pb = b.split(".").map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] ?? 0
        const nb = pb[i] ?? 0
        if (na > nb) return true
        if (na < nb) return false
    }
    return false
}

// Ingen stripePaymentLink längre: köp går via POST /billing/checkout-session
// (hooks/use-checkout.ts). Backend skickar fortfarande fältet i /system/config,
// men bara för klienter <= 0.10.2.
interface ConfigStore {
    motd: string | null
    latestVersion: string | null
    updateAvailable: boolean
    downloadUrl: string
    // /system/config → diarize_enabled, tolkat av diarizeAvailable. Styr auto-diariseringen
    // vid stopp och om talarsepareringens val visas. false tills ett svar sagt exakt true:
    // storen persisteras inte, så varje start börjar avstängd, och en app som startat
    // offline laddar aldrig upp MÖTET-kanalen på chans.
    diarizeEnabled: boolean
    setMotd: (m: string | null) => void
    setLatestVersion: (v: string) => void
    setDownloadUrl: (url: string) => void
    setDiarizeEnabled: (enabled: boolean) => void
}

export const useConfigStore = create<ConfigStore>((set) => ({
    motd: null,
    latestVersion: null,
    updateAvailable: false,
    downloadUrl: "https://sagt.ai/downloads",
    diarizeEnabled: false,
    setMotd: (m) => set({ motd: m }),
    setLatestVersion: (v) => set({ latestVersion: v, updateAvailable: semverGt(v, CURRENT_VERSION) }),
    setDownloadUrl: (url) => set({ downloadUrl: url }),
    setDiarizeEnabled: (enabled) => set({ diarizeEnabled: enabled }),
}))
