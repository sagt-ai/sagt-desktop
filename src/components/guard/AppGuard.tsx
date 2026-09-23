import { useState, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { ShieldAlert, Loader2 } from "lucide-react"
import { useConfigStore } from "@/store/config-store"
import { CURRENT_VERSION } from "@/lib/version"
import { diarizeAvailable, liveDiarizeAvailable } from "@/lib/system-config"

function compareSemver(a: string, b: string): number {
    const pa = a.split(".").map(Number)
    const pb = b.split(".").map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const na = pa[i] ?? 0
        const nb = pb[i] ?? 0
        if (na < nb) return -1
        if (na > nb) return 1
    }
    return 0
}
const API_URL = import.meta.env.VITE_API_URL || "https://api.sagt.ai/api/v1"

// Modulnivå (inte state): skyddar mot dubbla install-POST:ar när React StrictMode
// kör mount-effekten två gånger innan första svaret hunnit rensa pending-flaggan.
let installLogInFlight = false

type GuardState = 'CHECKING' | 'UPDATE_REQUIRED' | 'READY'

export function AppGuard({ children }: { children: React.ReactNode }) {
    const [state, setState] = useState<GuardState>('CHECKING')
    const [maintenanceMessage, setMaintenanceMessage] = useState("")
    // Hämtas från /system/config så att vi kan byta CDN-URL utan ny release.
    // Faller tillbaka på sagt.ai/downloads om backend inte returnerar fältet.
    const [downloadUrl, setDownloadUrl] = useState("https://sagt.ai/downloads")
    const setMotd = useConfigStore((s) => s.setMotd)
    const setLatestVersion = useConfigStore((s) => s.setLatestVersion)
    const setDownloadUrlStore = useConfigStore((s) => s.setDownloadUrl)
    const setDiarizeEnabled = useConfigStore((s) => s.setDiarizeEnabled)
    const setLiveDiarizeEnabled = useConfigStore((s) => s.setLiveDiarizeEnabled)

    useEffect(() => {
        validateAccess()
    }, [])

    // Hämta om configen när nätet kommer tillbaka. diarizeEnabled börjar som false, så en
    // app som startat offline hade annars haft talarsepareringen avstängd tills omstart.
    useEffect(() => {
        const onOnline = () => { refreshConfigInBackground() }
        window.addEventListener("online", onOnline)
        return () => window.removeEventListener("online", onOnline)
    }, [])

    // Delad config-applicering: används av första kollen och av bakgrundsuppdateringarna.
    const applyConfig = (data: any) => {
        if (data.download_url) {
            setDownloadUrl(data.download_url)
            setDownloadUrlStore(data.download_url)
        }
        if (data.motd) setMotd(data.motd)
        if (data.latest_version) setLatestVersion(data.latest_version)
        // Utan if, till skillnad från fälten ovan: ett svar som saknar fältet (en backend
        // före diarize_enabled) ska stänga av talarsepareringen, inte lämna ett gammalt true.
        setDiarizeEnabled(diarizeAvailable(data))
        setLiveDiarizeEnabled(liveDiarizeAvailable(data))
    }

    // Hämta config i bakgrunden (utan timeout) efter att användaren släppts in via
    // offline-toleransen — uppdaterar motd/version/länkar utan att blockera starten.
    // Poängen är cold start-fallet: första fetchens 4s-timeout hinner inte vänta ut
    // en backend som skalat till noll, men denna hämtning utan timeout lyckas när den vaknat.
    // Körs också när nätet kommer tillbaka (online-effekten ovan).
    // Rör aldrig guard-state (ingen oväntad UPDATE_REQUIRED mitt i sessionen).
    const refreshConfigInBackground = async () => {
        try {
            const res = await fetch(`${API_URL}/system/config`, { headers: { "Cache-Control": "no-cache" } })
            if (res.ok) applyConfig(await res.json())
        } catch {
            /* tyst — appen är redan READY */
        }
    }

    // Licensen utfärdas LOKALT vid första start — offline-first är kärn-USP:n och
    // första starten får aldrig kräva nätverk (t.ex. installation på tåget). Backend
    // returnerade ändå alltid samma statiska nyckel, så nätverksrundan gav inget.
    // POST:en är anonym installoggning (tom body — e-postgaten är borttagen; fältet
    // är Optional i backend för klienter ≤0.9.33). Pending-flaggan gör loggningen
    // eventuellt-konsistent: en offline första start POST:ar vid en senare start i
    // stället för att tappas — flaggan sätts BARA när licensen just skapades, så
    // uppgraderade befintliga installationer räknas aldrig som nya.
    const ensureLicense = () => {
        if (!localStorage.getItem("sagt_beta_license")) {
            localStorage.setItem("sagt_beta_license", "BETA-EARLY-ACCESS")
            localStorage.setItem("sagt_install_log_pending", "1")
        }
        if (localStorage.getItem("sagt_install_log_pending") && !installLogInFlight) {
            installLogInFlight = true
            fetch(`${API_URL}/system/register`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({}),
            })
                .then((res) => {
                    if (res.ok) localStorage.removeItem("sagt_install_log_pending")
                })
                .catch(() => { /* installoggning är best-effort — retry vid nästa start */ })
                .finally(() => { installLogInFlight = false })
        }
    }

    const validateAccess = async () => {
        ensureLicense()
        try {
            // Backend skalar till noll vid inaktivitet → första anropet är en cold start (10–30 s).
            // Utan timeout frös appen i CHECKING tills servern vaknat ("not responding"). Vänta
            // max 4 s; därefter släpps en redan registrerad användare in direkt (offline-tolerans)
            // och config hämtas i bakgrunden. Offline/nätfel går samma väg.
            const controller = new AbortController()
            const timer = setTimeout(() => controller.abort(), 4000)
            let data: any
            try {
                const res = await fetch(`${API_URL}/system/config`, {
                    headers: { "Cache-Control": "no-cache" },
                    signal: controller.signal,
                })
                if (!res.ok) throw new Error("Network response was not ok")
                data = await res.json()
            } finally {
                clearTimeout(timer)
            }

            applyConfig(data)

            if (data.maintenance_mode) {
                setMaintenanceMessage(data.message || "Sagt.ai genomgår tillfälligt underhåll.")
                setState('UPDATE_REQUIRED')
                return
            }

            // Semantic version check
            if (compareSemver(data.min_version, CURRENT_VERSION) > 0) {
                setState('UPDATE_REQUIRED')
                return
            }

            setState('READY')

        } catch (error) {
            console.error("AppGuard: config-koll timeout/fel — tillämpar offline-tolerans...", error)
            // OFFLINE TOLERANCE RULE — användaren blockeras aldrig av en kall/långsam
            // backend. Licensen finns alltid (ensureLicense ovan), så även en HELT
            // offline första start går rakt till dashboard.
            setState('READY')
            refreshConfigInBackground()
        }
    }

    if (state === 'CHECKING') {
        return (
            <div className="h-full w-full flex items-center justify-center bg-brand text-paper">
                <div className="flex flex-col items-center gap-4">
                    <Loader2 className="h-8 w-8 animate-spin text-white/80" />
                    <p className="text-white/60 font-medium">Ansluter till Sagt.ai...</p>
                </div>
            </div>
        )
    }

    if (state === 'UPDATE_REQUIRED') {
        return (
            <div className="h-full w-full flex items-center justify-center bg-brand text-paper p-6">
                <div className="max-w-md w-full bg-brand-deep border border-white/10 rounded-2xl p-8 text-center shadow-2xl">
                    <div className="w-16 h-16 bg-red-500/10 rounded-2xl flex items-center justify-center mx-auto mb-6">
                        <ShieldAlert className="h-8 w-8 text-red-400" />
                    </div>
                    <h1 className="text-2xl font-display font-bold tracking-tight mb-3">Uppdatering krävs</h1>
                    <p className="text-white/60 mb-8 leading-relaxed">
                        {maintenanceMessage || "En kritisk uppdatering finns tillgänglig. Vänligen ladda ner den senaste versionen av Sagt.ai för att fortsätta."}
                    </p>
                    <Button
                        className="w-full bg-white text-brand hover:bg-paper font-medium"
                        onClick={() => window.open(downloadUrl, "_blank")}
                    >
                        Ladda ner senaste versionen
                    </Button>
                </div>
            </div>
        )
    }

    // READY state
    return <>{children}</>
}
