import { useState } from "react"
import { X, Clock, AlertTriangle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useAuthStore } from "@/store/auth-store"
import { useCheckout } from "@/hooks/use-checkout"

export function TrialBanner() {
    const trialEndsAt = useAuthStore((s) => s.trialEndsAt)
    const isPro = useAuthStore((s) => s.isPro())
    // Bannern öppnade tidigare Payment Link-URL:en utan client_reference_id, så ett
    // köp härifrån kopplades aldrig till kontot. Via backend bär varje köp identiteten.
    const { openCheckout, isOpening } = useCheckout()
    const [dismissed, setDismissed] = useState(false)

    if (!trialEndsAt || isPro) return null

    const nowSec = Math.floor(Date.now() / 1000)
    const daysLeft = Math.ceil((trialEndsAt - nowSec) / 86400)

    // Hide entirely if more than 7 days remain — no disruption early in trial
    if (daysLeft > 7) return null

    const expired = daysLeft <= 0

    // Expired trial is non-dismissable
    if (!expired && dismissed) return null

    if (expired) {
        return (
            <div className="flex items-center gap-3 px-4 py-2 bg-red-50 border-b border-red-200 text-red-800 text-sm">
                <AlertTriangle className="h-4 w-4 shrink-0 text-red-500" />
                <span className="flex-1">Provperioden har gått ut. Uppgradera till Pro för att fortsätta använda alla funktioner.</span>
                <Button
                    size="sm"
                    className="h-7 px-3 bg-red-600 hover:bg-red-700 text-white text-xs shrink-0"
                    disabled={isOpening}
                    onClick={() => { void openCheckout() }}
                >
                    {isOpening ? "Öppnar..." : "Uppgradera"}
                </Button>
            </div>
        )
    }

    return (
        <div className="flex items-center gap-3 px-4 py-2 bg-ochre-soft border-b border-ochre/20 text-ochre text-sm">
            <Clock className="h-4 w-4 shrink-0 text-ochre" />
            <span className="flex-1">
                Din provperiod slutar om {daysLeft} {daysLeft === 1 ? "dag" : "dagar"}.
            </span>
            <Button
                size="sm"
                variant="outline"
                className="h-7 px-3 border-ochre/30 text-ochre hover:bg-ochre-soft text-xs shrink-0"
                disabled={isOpening}
                onClick={() => { void openCheckout() }}
            >
                {isOpening ? "Öppnar..." : "Uppgradera"}
            </Button>
            <button
                onClick={() => setDismissed(true)}
                className="shrink-0 p-1 rounded hover:bg-ochre/10 transition-colors"
                aria-label="Stäng"
            >
                <X className="h-3.5 w-3.5" />
            </button>
        </div>
    )
}
