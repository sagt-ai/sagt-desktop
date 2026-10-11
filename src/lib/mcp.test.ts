import { describe, expect, it } from "vitest"
import { mcpEnabledForUser, buildMcpSession, claudeCodeCommand, claudeDesktopConfig, codexCommand, MCP_CONSENT_TEXT, mcpCounterText, normalizeApiBase, type McpSessionInput } from "./mcp"

const base: McpSessionInput = {
    enabled: true,
    isSignedIn: true,
    userId: "user_1",
    token: "tok",
    expiresAt: 2_000,
    isPro: false,
    backendUrl: "https://api.sagt.ai/api/v1",
    now: 1_000,
}

describe("buildMcpSession", () => {
    it("bygger filen för ett inloggat gratiskonto", () => {
        expect(buildMcpSession(base)).toEqual({ user_id: "user_1", token: "tok", plan: "free", exp: 2_000, api_base: "https://api.sagt.ai/api/v1" })
    })

    it("markerar Pro", () => {
        expect(buildMcpSession({ ...base, isPro: true })?.plan).toBe("pro")
    })

    it.each<[string, Partial<McpSessionInput>]>([
        ["MCP av", { enabled: false }],
        ["utloggad", { isSignedIn: false }],
        ["utan token", { token: null }],
        ["utan konto", { userId: null }],
        ["utan utgångstid", { expiresAt: null }],
        ["utgången inloggning", { now: 2_000 }],
    ])("ingen fil när %s", (_, patch) => {
        expect(buildMcpSession({ ...base, ...patch })).toBeNull()
    })

    it("tar med analysens nyckel och appens version bara när de finns", () => {
        const s = buildMcpSession({ ...base, posthogKey: "k", posthogHost: "https://eu.i.posthog.com", appVersion: "0.12.0" })
        expect(s).toMatchObject({ posthog_key: "k", posthog_host: "https://eu.i.posthog.com", app_version: "0.12.0" })
        expect(buildMcpSession(base)).not.toHaveProperty("posthog_key")
    })
})

describe("normalizeApiBase", () => {
    it.each([
        ["http://localhost:8000", "http://localhost:8000/api/v1"],
        ["https://api.sagt.ai/api/v1", "https://api.sagt.ai/api/v1"],
        ["https://api.sagt.ai/api/v1/", "https://api.sagt.ai/api/v1"],
        [" https://x.se// ", "https://x.se/api/v1"],
    ])("%s → %s", (input, out) => {
        expect(normalizeApiBase(input)).toBe(out)
    })
})

describe("konfigurationen för assistenterna", () => {
    const cmd = "C:\\Program Files\\Sagt.ai\\Sagt.ai.exe"

    it("Claude Desktop får kommandot och flaggan som JSON", () => {
        expect(JSON.parse(claudeDesktopConfig(cmd))).toEqual({ mcpServers: { sagt: { command: cmd, args: ["--mcp"] } } })
    })

    it("terminalkommandona citerar sökvägar med mellanslag", () => {
        expect(claudeCodeCommand(cmd)).toBe(`claude mcp add --transport stdio sagt -- "${cmd}" --mcp`)
        expect(codexCommand("/Applications/Sagt.ai.app/Contents/MacOS/Sagt.ai")).toBe('codex mcp add sagt -- "/Applications/Sagt.ai.app/Contents/MacOS/Sagt.ai" --mcp')
    })
})

describe("texterna", () => {
    it("samtycket säger var texten hamnar och att ljudet inte nås", () => {
        expect(MCP_CONSENT_TEXT).toContain("assistentens leverantör")
        expect(MCP_CONSENT_TEXT).toContain("utanför EU")
        expect(MCP_CONSENT_TEXT).toContain("MCP når aldrig ditt ljud")
        expect(MCP_CONSENT_TEXT).not.toMatch(/ljudet lämnar aldrig/i)
    })

    it("räknaren", () => {
        expect(mcpCounterText({ remaining: 7, limit: 10 })).toBe("7 av 10 MCP-anrop kvar i dag")
    })
})

describe("mcpEnabledForUser", () => {
    it("samtycket gäller bara kontot som gav det", () => {
        expect(mcpEnabledForUser("user_a", "user_a")).toBe(true)
        expect(mcpEnabledForUser("user_a", "user_b")).toBe(false)
        expect(mcpEnabledForUser(null, "user_a")).toBe(false)
        expect(mcpEnabledForUser("user_a", null)).toBe(false)
        expect(mcpEnabledForUser("", "")).toBe(false)
    })
})
