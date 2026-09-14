import { useCallback, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { useAuthStore } from "@/store/auth-store"
import { showError } from "@/hooks/use-posthog-events"
import { interpretCheckoutResponse } from "@/lib/checkout-response"

const _raw = (import.meta.env.VITE_API_URL || "https://api.sagt.ai/api/v1").replace(/\/$/, "")
const BASE_URL = _raw.endsWith("/api/v1") ? _raw : `${_raw}/api/v1`

/**
 * Öppnar Stripe Checkout i systemets webbläsare, via backend.
 *
 * Ersätter Payment Link-URL:en från /system/config. Payment Links skapar en ny
 * Stripe-kund vid varje köp; backendens session återanvänder användarens kund, och
 * sätter kopplingen till kontot innan betalningen i stället för efter.
 *
 * Returnerar true när webbläsaren öppnades — upsell-modalen startar pollingen först då.
 */
export function useCheckout() {
    const [isOpening, setIsOpening] = useState(false)
    // Ref och inte bara state: ett dubbelklick hinner före omrenderingen som
    // inaktiverar knappen, och varje anrop skapar en ny session hos Stripe.
    const inFlight = useRef(false)

    const openCheckout = useCallback(async (): Promise<boolean> => {
        if (inFlight.current) return false

        const token = useAuthStore.getState().getToken()
        if (!token) {
            showError("unauthorized", "Logga in för att uppgradera till Pro.", { action: "checkout" })
            return false
        }
        if (!navigator.onLine) {
            showError("offline", "Ingen internetanslutning — kunde inte öppna betalningen.", { action: "checkout" })
            return false
        }

        inFlight.current = true
        setIsOpening(true)
        try {
            let res: Response
            try {
                res = await fetch(`${BASE_URL}/billing/checkout-session`, {
                    method: "POST",
                    headers: { Authorization: `Bearer ${token}` },
                })
            } catch {
                showError("offline", "Kunde inte nå servern. Kontrollera din anslutning och försök igen.", { action: "checkout" })
                return false
            }

            let body: unknown = null
            try {
                body = await res.json()
            } catch {
                // Tomt eller icke-JSON-svar (proxy-fel, timeout) — tolkas som generiskt fel.
            }

            const outcome = interpretCheckoutResponse(res.status, body)
            if (res.status === 401) {
                // Samma som split-view och use-payment-refresh: servern har underkänt
                // token. Lämnas sessionen kvar ser upsell-modalen fortfarande ett userId,
                // hoppar över inloggningen och ger samma fel vid varje klick.
                useAuthStore.getState().clearSession()
            }
            if (!outcome.ok) {
                showError(outcome.code, outcome.message, { action: "checkout", http_status: res.status })
                return false
            }

            await invoke("plugin:shell|open", { path: outcome.url })
            return true
        } catch (err) {
            console.error("Failed to open checkout:", err)
            showError("unknown", "Kunde inte öppna betalningen. Försök igen.", { action: "checkout" })
            return false
        } finally {
            inFlight.current = false
            setIsOpening(false)
        }
    }, [])

    return { openCheckout, isOpening }
}
