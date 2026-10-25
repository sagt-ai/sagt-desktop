import { create } from "zustand"
import { CURRENT_VERSION } from "@/lib/version"
import { DEFAULT_MAX_CLOUD_JOB_MINUTES, FALLBACK_UPLOAD_POLICY, type CloudUploadPolicy } from "@/lib/system-config"

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
    // /system/config → diarize_after_meeting_enabled (äldre backend: diarize_enabled), tolkat
    // av diarizeAvailable. Styr auto-diariseringen
    // vid stopp och om talarsepareringens val visas. false tills ett svar sagt exakt true:
    // storen persisteras inte, så varje start börjar avstängd, och en app som startat
    // offline laddar aldrig upp MÖTET-kanalen på chans.
    diarizeEnabled: boolean
    // /system/config → job_diarize_enabled, tolkat av jobDiarizeAvailable. Styr om
    // "Transkribera om med talarseparering" och dess inställning visas. Samma default.
    jobDiarizeEnabled: boolean
    // /system/config → live_diarize_enabled, tolkat av liveDiarizeAvailable. Grindar
    // mint-anropet i use-live-diarize. Samma default och samma skäl som diarizeEnabled:
    // false tills ett svar sagt exakt true.
    liveDiarizeEnabled: boolean
    // /system/config → pro_yearly_available, tolkat av proYearlyAvailable. Visar valet
    // Månad/År i uppgraderingsfönstret. false tills ett svar sagt exakt true.
    proYearlyAvailable: boolean
    // /system/config → mcp_available, tolkat av mcpAvailable. Visar MCP-avsnittet i
    // Inställningar. false tills ett svar sagt exakt true.
    mcpAvailable: boolean
    // /system/config → max_cloud_job_minutes, tolkat av maxCloudJobMinutes. Längsta möte
    // som laddas upp till molnet.
    maxCloudJobMinutes: number
    // /system/config → opus_bitrate_per_channel + opus_only_when_needed, tolkat av
    // cloudUploadPolicy. Reservläget tills ett giltigt svar kommit.
    uploadPolicy: CloudUploadPolicy
    setMotd: (m: string | null) => void
    setLatestVersion: (v: string) => void
    setDownloadUrl: (url: string) => void
    setDiarizeEnabled: (enabled: boolean) => void
    setJobDiarizeEnabled: (enabled: boolean) => void
    setLiveDiarizeEnabled: (enabled: boolean) => void
    setProYearlyAvailable: (available: boolean) => void
    setMcpAvailable: (available: boolean) => void
    setMaxCloudJobMinutes: (minutes: number) => void
    setUploadPolicy: (policy: CloudUploadPolicy) => void
}

export const useConfigStore = create<ConfigStore>((set) => ({
    motd: null,
    latestVersion: null,
    updateAvailable: false,
    downloadUrl: "https://sagt.ai/downloads",
    diarizeEnabled: false,
    jobDiarizeEnabled: false,
    liveDiarizeEnabled: false,
    proYearlyAvailable: false,
    mcpAvailable: false,
    maxCloudJobMinutes: DEFAULT_MAX_CLOUD_JOB_MINUTES,
    uploadPolicy: FALLBACK_UPLOAD_POLICY,
    setMotd: (m) => set({ motd: m }),
    setLatestVersion: (v) => set({ latestVersion: v, updateAvailable: semverGt(v, CURRENT_VERSION) }),
    setDownloadUrl: (url) => set({ downloadUrl: url }),
    setDiarizeEnabled: (enabled) => set({ diarizeEnabled: enabled }),
    setJobDiarizeEnabled: (enabled) => set({ jobDiarizeEnabled: enabled }),
    setLiveDiarizeEnabled: (enabled) => set({ liveDiarizeEnabled: enabled }),
    setProYearlyAvailable: (available) => set({ proYearlyAvailable: available }),
    setMcpAvailable: (available) => set({ mcpAvailable: available }),
    setMaxCloudJobMinutes: (minutes) => set({ maxCloudJobMinutes: minutes }),
    setUploadPolicy: (policy) => set({ uploadPolicy: policy }),
}))
