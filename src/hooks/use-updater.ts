import { useEffect } from "react"
import { toast } from "sonner"
import type { Update } from "@tauri-apps/plugin-updater"
import { appSessionBusy } from "@/lib/session-busy-app"

// Ett gemensamt toast-id gör att erbjudande → nedladdning → installation → fel
// är EN toast som byter innehåll, i stället för en hög staplade kopior.
const UPDATE_TOAST_ID = "app-update"

const toMb = (bytes: number) => Math.round(bytes / 1048576)

// In-flight-spärr: snabba dubbelklick på "Uppdatera nu"/"Försök igen" får inte
// starta två samtidiga nedladdningar av samma installer.
let updateInProgress = false

export async function runUpdate(update: Update, isBusy: () => Promise<boolean> = appSessionBusy) {
    if (updateInProgress) return
    updateInProgress = true
    // NSIS-installern avslutar appen. Under inspelningen klipps den mitt i, och efter
    // Stopp avbryts sparandet och transkriberingen som fortfarande pågår.
    if (await isBusy()) {
        updateInProgress = false
        toast.warning("Vänta tills inspelningen sparats", {
            id: UPDATE_TOAST_ID,
            description: "Uppdateringen startar om Sagt.ai och skulle avbryta inspelningen eller transkriberingen.",
            action: { label: "Uppdatera nu", onClick: () => { void runUpdate(update, isBusy) } },
            duration: Infinity,
        })
        return
    }

    let totalBytes = 0
    let receivedBytes = 0
    let lastShownStep = -1

    try {
        toast.loading("Laddar ner uppdatering…", {
            id: UPDATE_TOAST_ID,
            description: `v${update.version} — förbereder nedladdning`,
            duration: Infinity,
        })

        await update.downloadAndInstall((event) => {
            switch (event.event) {
                case "Started":
                    totalBytes = event.data.contentLength ?? 0
                    break
                case "Progress": {
                    receivedBytes += event.data.chunkLength
                    // Progress-events kommer per nätverks-chunk — uppdatera toasten
                    // bara vid hel procent (eller per 10 MB om totalen är okänd),
                    // annars triggas hundratals re-renders per sekund.
                    const step = totalBytes > 0
                        ? Math.floor((receivedBytes / totalBytes) * 100)
                        : Math.floor(receivedBytes / (10 * 1048576))
                    if (step === lastShownStep) return
                    lastShownStep = step
                    toast.loading(
                        totalBytes > 0
                            ? `Laddar ner uppdatering… ${step} %`
                            : "Laddar ner uppdatering…",
                        {
                            id: UPDATE_TOAST_ID,
                            description: totalBytes > 0
                                ? `${toMb(receivedBytes)} av ${toMb(totalBytes)} MB`
                                : `${toMb(receivedBytes)} MB nedladdat`,
                            duration: Infinity,
                        }
                    )
                    break
                }
                case "Finished":
                    toast.loading("Installerar uppdateringen", {
                        id: UPDATE_TOAST_ID,
                        description: "Sagt.ai stängs och startas om automatiskt om en stund.",
                        duration: Infinity,
                    })
                    break
            }
        })

        // Windows: NSIS-installern avslutar appen själv innan vi når hit —
        // relaunch är fallback för plattformar där processen lever vidare.
        const { relaunch } = await import("@tauri-apps/plugin-process")
        await relaunch()
    } catch (error) {
        updateInProgress = false
        console.error("Updater: download/install failed", error)
        toast.error("Uppdateringen misslyckades", {
            id: UPDATE_TOAST_ID,
            description: "Kontrollera din uppkoppling och försök igen.",
            action: { label: "Försök igen", onClick: () => { void runUpdate(update) } },
            duration: Infinity,
        })
    }
}

export function useUpdater() {
    useEffect(() => {
        // Dynamic import — plugin only available in Tauri context, not in browser dev mode
        import("@tauri-apps/plugin-updater").then(({ check }) =>
            check().then((update) => {
                if (!update?.available) return
                toast("Ny version av Sagt.ai tillgänglig", {
                    id: UPDATE_TOAST_ID,
                    description: `v${update.version} är klar att installera`,
                    action: { label: "Uppdatera nu", onClick: () => { void runUpdate(update) } },
                    duration: Infinity,
                })
            })
        ).catch(() => {})
    }, [])
}
