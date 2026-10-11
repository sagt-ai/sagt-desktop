import { invoke } from "@tauri-apps/api/core"
import { create } from "zustand"
import { buildMcpSession, mcpEnabledForUser, type McpSessionFile } from "@/lib/mcp"
import { CURRENT_VERSION } from "@/lib/version"
import { useAuthStore } from "@/store/auth-store"
import { useSettingsStore } from "@/store/settings-store"

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_KEY as string | undefined
const POSTHOG_HOST = (import.meta.env.VITE_POSTHOG_HOST as string | undefined) ?? "https://eu.i.posthog.com"

/** Sessionen som ska stå i filen just nu, ur inloggningen och inställningen. */
export function currentMcpSession(now: number = Date.now() / 1000): McpSessionFile | null {
    const auth = useAuthStore.getState()
    const settings = useSettingsStore.getState()
    return buildMcpSession({
        enabled: mcpEnabledForUser(settings.mcpEnabledFor, auth.userId),
        isSignedIn: auth.isSignedIn,
        userId: auth.userId,
        token: auth.token,
        expiresAt: auth.expiresAt,
        isPro: auth.isPro(),
        backendUrl: settings.backendUrl,
        posthogKey: POSTHOG_KEY,
        posthogHost: POSTHOG_HOST,
        appVersion: CURRENT_VERSION,
        now,
    })
}

/** Gick senaste skrivningen av sessionsfilen fel? Visas i Inställningar, så att MCP inte ser
 *  påslaget ut medan assistenten får beskedet att det är av. */
export const useMcpSyncStore = create<{ error: string | null }>(() => ({ error: null }))

let lastWritten: string | null | undefined = undefined

async function apply(session: McpSessionFile | null): Promise<void> {
    const next = session ? JSON.stringify(session) : null
    if (next === lastWritten) return
    // Sätts före anropet, så att två ändringar i samma ögonblick (start och första
    // förnyelsen) inte skriver samma sak två gånger.
    const previous = lastWritten
    lastWritten = next
    try {
        if (next) await invoke("mcp_write_session", { session: next })
        else await invoke("mcp_clear_session")
        useMcpSyncStore.setState({ error: null })
    } catch (e) {
        useMcpSyncStore.setState({ error: String(e) })
        // Skrivs inget nytt står den gamla filen kvar; nästa ändring försöker igen.
        if (lastWritten === next) lastWritten = previous
        console.warn("[mcp] sessionsfilen gick inte att uppdatera:", e)
    }
}

// Anropen körs i tur och ordning: två snabba ändringar ska inte kunna landa i omvänd ordning
// och lämna en äldre session i filen.
let queue: Promise<void> = Promise.resolve()
function enqueue(session: McpSessionFile | null): void {
    queue = queue.then(() => apply(session))
}

/**
 * Håller sessionsfilen i takt med inloggningen och MCP-inställningen: skrivs när MCP är på
 * och användaren inloggad (och skrivs om vid varje förnyad inloggning), raderas annars.
 * Vid start raderas en kvarlämnad fil om MCP är av. Returnerar avregistreringen.
 */
export function startMcpSessionSync(): () => void {
    enqueue(currentMcpSession())
    const sync = () => enqueue(currentMcpSession())
    const unsubAuth = useAuthStore.subscribe(sync)
    const unsubSettings = useSettingsStore.subscribe((s, prev) => {
        if (s.mcpEnabledFor !== prev.mcpEnabledFor || s.backendUrl !== prev.backendUrl) sync()
    })
    return () => {
        unsubAuth()
        unsubSettings()
    }
}
