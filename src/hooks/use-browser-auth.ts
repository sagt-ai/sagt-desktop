import { useCallback } from "react"
import { invoke } from "@tauri-apps/api/core"
import { useAuthStore } from "@/store/auth-store"
import { setBrowserAuthIntent, startBrowserAuth, stopBrowserAuthFor, useBrowserAuthStore, type AuthIntent } from "@/lib/browser-auth"
import { clearSignInIntent, setSignInIntent } from "@/lib/sign-in-intent"

const API_URL = import.meta.env.VITE_API_URL || "https://api.sagt.ai/api/v1"
const FRONTEND_URL = import.meta.env.VITE_FRONTEND_URL || "https://sagt.ai"

function apiBase(): string {
    const base = API_URL.replace(/\/$/, "")
    return base.endsWith("/api/v1") ? base : `${base}/api/v1`
}

/**
 * Inloggningen i webbläsaren för en komponent. Själva inloggningen är gemensam för appen
 * (lib/browser-auth.ts) och avbryts inte när komponenten försvinner, så att ett vybyte
 * medan webbläsaren är öppen inte tappar sessionen. Därför ingen städning här.
 *
 * `owner` är komponentens ägarnyckel: `stopAuth` släpper bara dess intresse, och
 * `isWaiting` säger om just den väntar.
 */
export function useBrowserAuth(owner: string) {
    const isAuthenticating = useBrowserAuthStore((s) => s.isAuthenticating)
    const isWaiting = useBrowserAuthStore((s) => s.owners.includes(owner))
    const startAuth = useCallback((intent: AuthIntent) => startBrowserAuth({
        openUrl: (path) => invoke("plugin:shell|open", { path }),
        fetchFn: (url) => fetch(url),
        onSession: (data) => useAuthStore.getState().setSession(data.token, data.user, data.expires_at),
        // Avsikten sätts först här, när inloggningen lyckats, ur alla som väntade på den.
        onIntent: (i) => i ? setSignInIntent(i.intent, i.source) : clearSignInIntent(),
        apiBase: apiBase(),
        frontendUrl: FRONTEND_URL,
    }, owner, intent), [owner])
    const stopAuth = useCallback(() => stopBrowserAuthFor(owner), [owner])
    const setIntent = useCallback((i: AuthIntent) => setBrowserAuthIntent(owner, i), [owner])
    return { startAuth, stopAuth, setIntent, isAuthenticating, isWaiting }
}
