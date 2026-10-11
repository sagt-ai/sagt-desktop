import { useEffect, useState } from "react"
import { invoke } from "@tauri-apps/api/core"
import { Bot, Copy, Sparkles } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { useBrowserAuth } from "@/hooks/use-browser-auth"
import { useCheckout } from "@/hooks/use-checkout"
import { usePostHogEvents } from "@/hooks/use-posthog-events"
import { claudeCodeCommand, claudeDesktopConfig, codexCommand, MCP_CONSENT_TEXT, mcpCounterText, mcpEnabledForUser } from "@/lib/mcp"
import { useAuthStore } from "@/store/auth-store"
import { useConfigStore } from "@/store/config-store"
import { useEntitlementsStore, useQuotaCounter } from "@/store/entitlements-store"
import { useMcpSyncStore } from "@/store/mcp-sync"
import { useSettingsStore } from "@/store/settings-store"

function CopyBlock({ label, text }: { label: string; text: string }) {
    const copy = async () => {
        try {
            await navigator.clipboard.writeText(text)
            toast.success("Kopierat")
        } catch {
            toast.error("Kunde inte kopiera. Markera texten och kopiera den själv.")
        }
    }
    return (
        <div className="space-y-1">
            <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-ink">{label}</span>
                <button type="button" onClick={copy} className="text-xs text-ink-muted hover:text-ink inline-flex items-center gap-1">
                    <Copy className="w-3 h-3" /> Kopiera
                </button>
            </div>
            <pre className="text-[11px] bg-paper-dim border border-line rounded p-2 overflow-x-auto whitespace-pre-wrap break-all select-all">{text}</pre>
        </div>
    )
}

/**
 * "Låt min AI-assistent läsa mina möten": MCP. Visas bara när servern har slagit på
 * funktionen. Av som standard; påslaget först efter samtyckestexten, och bara för ett
 * inloggat konto (gratiskonto med dagskvot, Pro obegränsat).
 */
export function McpSection() {
    const available = useConfigStore((s) => s.mcpAvailable)
    const userId = useAuthStore((s) => s.userId)
    const enabled = useSettingsStore((s) => mcpEnabledForUser(s.mcpEnabledFor, userId))
    const setEnabledFor = useSettingsStore((s) => s.setMcpEnabledFor)
    const syncError = useMcpSyncStore((s) => s.error)
    const isSignedIn = useAuthStore((s) => s.isSignedIn)
    const isPro = useAuthStore((s) => s.isPro())
    const counter = useQuotaCounter("mcp_tool_call")
    const { startAuth, isWaiting } = useBrowserAuth("mcp-settings")
    const { openCheckout, isOpening } = useCheckout()
    const events = usePostHogEvents()
    const [command, setCommand] = useState<string | null>(null)

    // Räknaren hämtas annars bara vid inloggning och förnyelse, medan assistenten förbrukar
    // anrop hela tiden. Hämta den när avsnittet visas.
    useEffect(() => {
        if (available && enabled && isSignedIn && !isPro) void useEntitlementsStore.getState().refresh()
    }, [available, enabled, isSignedIn, isPro])

    useEffect(() => {
        if (!enabled || command) return
        invoke<string>("mcp_server_command").then(setCommand).catch((e) => console.warn("[mcp] sökvägen:", e))
    }, [enabled, command])

    if (!available) return null

    const plan = isPro ? "pro" : "free"
    const turnOn = () => {
        if (!userId) return
        setEnabledFor(userId)
        events.mcpToggled(true, plan)
    }
    const turnOff = () => {
        setEnabledFor(null)
        events.mcpToggled(false, plan)
    }

    return (
        <section className="space-y-6">
            <div className="flex items-center gap-2 mb-4">
                <Bot className="text-primary w-5 h-5" />
                <h2 className="text-lg font-display font-semibold text-ink">AI-assistent (MCP)</h2>
            </div>

            <div className="bg-white p-6 rounded-lg border shadow-sm space-y-4">
                <div>
                    <h3 className="text-sm font-semibold text-ink">Låt min AI-assistent läsa mina möten</h3>
                    <p className="text-xs text-muted-foreground mt-1">
                        En AI-assistent på den här datorn, till exempel Claude Desktop, Claude Code eller Codex i ChatGPT-appen,
                        kan söka i och läsa dina transkript och protokoll. Bara läsning; assistenten kan inte ändra något.
                    </p>
                </div>

                {/* Samtycket står alltid synligt, inte bakom valet: det är det användaren tar ställning till. */}
                <p className="text-xs text-ink rounded border border-line bg-paper-dim p-3">{MCP_CONSENT_TEXT}</p>

                {!isSignedIn && (
                    <div className="flex items-center justify-between gap-4 rounded border border-line bg-paper-dim p-3">
                        <p className="text-xs text-ink-muted">Kräver ett konto. Med ett gratiskonto ingår ett antal anrop per dag, med Pro obegränsat.</p>
                        <Button size="sm" variant="outline" disabled={isWaiting} onClick={() => startAuth({ intent: "free", source: "mcp_settings" })}>
                            {isWaiting ? "Väntar på inloggningen..." : "Logga in eller skapa gratiskonto"}
                        </Button>
                    </div>
                )}

                {isSignedIn && (
                    <div className="grid grid-cols-2 gap-3" role="group" aria-label="Låt min AI-assistent läsa mina möten">
                        {([
                            { on: false, label: "Av" },
                            { on: true, label: "På" },
                        ] as { on: boolean; label: string }[]).map(({ on, label }) => (
                            <button
                                key={label}
                                type="button"
                                aria-pressed={enabled === on}
                                onClick={() => { if (on !== enabled) { if (on) turnOn(); else turnOff() } }}
                                className={`px-3 py-2 rounded-md border text-sm font-medium transition-all ${enabled === on
                                    ? "border-primary bg-primary/5 text-primary ring-1 ring-primary"
                                    : "border-line bg-white text-ink-soft hover:bg-paper-dim"
                                }`}
                            >
                                {label}
                            </button>
                        ))}
                    </div>
                )}

                {isSignedIn && enabled && syncError && (
                    <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">
                        Sagt kunde inte spara MCP-inställningen, så assistenten når inte mötena än. Slå av och på MCP, eller starta om Sagt.
                    </p>
                )}

                {isSignedIn && enabled && (
                    <div className="space-y-3">
                        {!isPro && counter && (
                            <div className="flex items-center justify-between gap-4">
                                <p className="text-xs text-ink-muted">{mcpCounterText(counter)}</p>
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="h-7 text-xs text-primary border-primary/20 bg-primary/5 hover:bg-primary/10"
                                    disabled={isOpening}
                                    onClick={() => { void openCheckout() }}
                                >
                                    <Sparkles className="w-3 h-3 mr-1" />
                                    {isOpening ? "Öppnar betalningen..." : "Obegränsat med Pro"}
                                </Button>
                            </div>
                        )}
                        <p className="text-xs text-muted-foreground">
                            Lägg till Sagt i din assistent med en av raderna nedan och starta om assistenten. Sagt läser bara möten medan
                            den här inställningen är på och du är inloggad.
                        </p>
                        {command ? (
                            <>
                                <CopyBlock label="Claude Desktop (Inställningar → Utvecklare → Redigera konfiguration)" text={claudeDesktopConfig(command)} />
                                <CopyBlock label="Claude Code (terminal)" text={claudeCodeCommand(command)} />
                                <CopyBlock label="Codex i ChatGPT-appen eller terminalen" text={codexCommand(command)} />
                            </>
                        ) : (
                            <p className="text-xs text-ink-muted">Hämtar sökvägen till Sagt...</p>
                        )}
                    </div>
                )}
            </div>
        </section>
    )
}
