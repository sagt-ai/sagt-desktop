// MCP: låt en AI-assistent på datorn läsa mötena i Sagt. Ren modul utan Tauri-, React- eller
// store-beroenden, så att besluten kan tabelltestas i node.
//
// Appen skriver en sessionsfil när MCP är påslaget och användaren är inloggad, och raderar
// den annars. MCP-processen (`sagt --mcp`, startad av assistenten) läser inga möten utan
// filen, så det är filen som gör att funktionen är av tills användaren slår på den.

/** Sessionsfilen som MCP-processen läser. Fältnamnen är processens. */
export interface McpSessionFile {
    user_id: string
    token: string
    plan: "free" | "pro"
    exp: number
    api_base: string
    posthog_key?: string
    posthog_host?: string
    app_version?: string
}

export interface McpSessionInput {
    enabled: boolean
    isSignedIn: boolean
    userId: string | null
    token: string | null
    /** Inloggningens sista giltiga sekund (Unix-tid). */
    expiresAt: number | null
    isPro: boolean
    backendUrl: string
    posthogKey?: string
    posthogHost?: string
    appVersion?: string
    /** Nu, i sekunder. */
    now: number
}

/** Är MCP påslaget för kontot som är inloggat? Bara om det är samma konto som godkände. */
export function mcpEnabledForUser(enabledFor: string | null | undefined, userId: string | null | undefined): boolean {
    return !!enabledFor && !!userId && enabledFor === userId
}

/** Samma regel som appens övriga anrop: adressen slutar alltid på /api/v1. */
export function normalizeApiBase(backendUrl: string): string {
    const base = backendUrl.trim().replace(/\/+$/, "")
    return base.endsWith("/api/v1") ? base : `${base}/api/v1`
}

/**
 * Sessionen som ska stå i filen, eller null när filen ska raderas: MCP av, utloggad,
 * eller en inloggning som har gått ut.
 */
export function buildMcpSession(i: McpSessionInput): McpSessionFile | null {
    if (!i.enabled || !i.isSignedIn || !i.userId || !i.token || !i.expiresAt) return null
    if (i.now >= i.expiresAt) return null
    const s: McpSessionFile = {
        user_id: i.userId,
        token: i.token,
        plan: i.isPro ? "pro" : "free",
        exp: Math.floor(i.expiresAt),
        api_base: normalizeApiBase(i.backendUrl),
    }
    if (i.posthogKey) s.posthog_key = i.posthogKey
    if (i.posthogHost) s.posthog_host = i.posthogHost
    if (i.appVersion) s.app_version = i.appVersion
    return s
}

// ─── Konfigurationen för assistenterna ────────────────────────────────────────

const quote = (p: string) => `"${p.replace(/"/g, '\\"')}"`

/** Posten i Claude Desktops `claude_desktop_config.json`. */
export function claudeDesktopConfig(command: string): string {
    return JSON.stringify({ mcpServers: { sagt: { command, args: ["--mcp"] } } }, null, 2)
}

/** Kommandot för Claude Code i en terminal. */
export function claudeCodeCommand(command: string): string {
    return `claude mcp add --transport stdio sagt -- ${quote(command)} --mcp`
}

/** Kommandot för Codex (ChatGPT-appens Codex-läge, Codex CLI och IDE-tillägget delar det). */
export function codexCommand(command: string): string {
    return `codex mcp add sagt -- ${quote(command)} --mcp`
}

/** Texten användaren godkänner när MCP slås på. */
export const MCP_CONSENT_TEXT =
    "När MCP är på kan en AI-assistent som du kopplar till Sagt, till exempel Claude Desktop eller Claude Code, läsa dina transkript och protokoll. Texten skickas då från din dator till assistentens leverantör, som kan ligga utanför EU. Sagt skickar ingenting självt, och MCP når aldrig ditt ljud. Du kan slå av det när som helst."

/** Raden under knappen för ett gratiskonto. */
export function mcpCounterText(c: { remaining: number; limit: number }): string {
    return `${c.remaining} av ${c.limit} MCP-anrop kvar i dag`
}
