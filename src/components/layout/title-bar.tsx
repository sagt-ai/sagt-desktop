import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Mic2, Minus, Square, Copy, X } from "lucide-react";
import { isMacOS } from "@/lib/platform";
import { allowLeave, blockContextMenu, blockReload, LEAVE_MESSAGE, LEAVE_TITLE } from "@/lib/session-busy";
import { appSessionBusy } from "@/lib/session-busy-app";

/**
 * Titelrad — samma komponent på båda plattformarna, med TVÅ oberoende villkor.
 *
 * Renderas ALLTID — även utanför AppGuards blockerande lägen — så att
 * fönsterkontrollerna fungerar på varje skärm.
 *
 * Poängen med att hålla villkoren isär är att de svarar på olika frågor, och att ett
 * enda plattformsvillkor för båda vore fel av rätt skäl:
 *
 * **Fönsterknapparna beror på FÖNSTRET, inte på OS:et.** De finns därför att fönstret
 * byggs utan nativt krom. Frågan är alltså "saknar fönstret krom?" (`isDecorated()`),
 * inte "är detta macOS?". Skillnaden är inte akademisk: sätter någon `decorations: false`
 * på macOS, eller `true` på Windows, ger ett plattformsvillkor fel svar — och i
 * Windows-fallet blir följden ett fönster utan vare sig nativa eller egna knappar, som
 * inte går att stänga med musen. `isDecorated()` kan inte hamna fel, för den läser det
 * faktiska tillståndet.
 *
 * **Wordmarken beror på OS:et.** På macOS bär menyraden appens namn (`CFBundleName`,
 * "Sagt.ai") — en wordmark i fönstret vore dubblering, och en logotyp inne i fönstret är
 * en av de tydligaste signalerna att en app är portad snarare än byggd för plattformen.
 * Windows saknar global menyrad och måste bära namnet själv. Det villkoret är alltså
 * genuint plattformsberoende och ska förbli det.
 *
 * `pl-20` (80 px) håller remsan fri från trafikljusen. De finns bara när macOS kör med
 * krom (`titleBarStyle: Overlay`, se `tauri.macos.conf.json`), därför är även den
 * paddingen villkorad på båda sakerna. Att i stället flytta wordmarken åt höger löser
 * kollisionen men behåller dubbleringen — appen ser då fortfarande ut som en
 * Windows-app med marginal.
 */
export function TitleBar() {
    const appWindow = getCurrentWindow();
    const [isMaximized, setIsMaximized] = useState(false);

    const mac = isMacOS();

    // Startgissningen kommer från plattformen enbart för att `isDecorated()` är async:
    // en bildruta med fel titelrad går inte att felsöka i efterhand. Den korrigeras
    // nedan av det faktiska fönstertillståndet, som är sanningen.
    const [decorated, setDecorated] = useState<boolean>(mac);

    useEffect(() => {
        appWindow.isDecorated()
            .then(setDecorated)
            .catch(() => { /* behåll plattformsgissningen — hellre fel padding än ingen titelrad */ });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Stängvakten. Med en lyssnare här stänger Tauri inte fönstret själv vid
    // CloseRequested, utan lämnar beslutet hit. Utan vakten kunde appen stängas mellan
    // Stopp och sparandet, och mötet fanns då bara som en temporär fil.
    // ⚠️ ANTAGANDE: att Alt+F4 och stängning från aktivitetsfältet går samma väg som
    // krysset. Inte kört i appen.
    useEffect(() => {
        const unlistenPromise = appWindow.onCloseRequested(async (event) => {
            const ok = await allowLeave(appSessionBusy, async () => {
                const { ask } = await import("@tauri-apps/plugin-dialog");
                return ask(LEAVE_MESSAGE, {
                    title: LEAVE_TITLE,
                    kind: "warning",
                    okLabel: "Stäng ändå",
                    cancelLabel: "Fortsätt",
                });
            });
            if (!ok) event.preventDefault();
        });
        // Omladdningsspärren: i fångstfasen, före allt annat som lyssnar på tangenter.
        const onKey = (e: KeyboardEvent) => { blockReload(e, import.meta.env.DEV); };
        window.addEventListener("keydown", onKey, true);
        const onMenu = (e: MouseEvent) => {
            const t = e.target as HTMLElement | null;
            const editable = !!t?.closest?.("input, textarea, [contenteditable=''], [contenteditable='true']");
            const hasSelection = (window.getSelection()?.toString() ?? "").length > 0;
            blockContextMenu(e, { editable }, hasSelection, import.meta.env.DEV);
        };
        window.addEventListener("contextmenu", onMenu, true);
        return () => {
            window.removeEventListener("contextmenu", onMenu, true);
            unlistenPromise.then((unlisten) => unlisten());
            window.removeEventListener("keydown", onKey, true);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const showWindowControls = !decorated;
    const showWordmark = !mac;
    const padForTrafficLights = mac && decorated;

    useEffect(() => {
        // Maximerings-state används bara av de egna knapparna. Utan dem behövs varken
        // anropet eller onResized-prenumerationen.
        if (!showWindowControls) return;
        appWindow.isMaximized().then(setIsMaximized);
        // onResized fångar maximera/återställ → uppdatera ikonen
        const unlistenPromise = appWindow.onResized(() => {
            appWindow.isMaximized().then(setIsMaximized);
        });
        return () => {
            unlistenPromise.then((unlisten) => unlisten());
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showWindowControls]);

    return (
        <div
            data-tauri-drag-region
            className={`flex items-center justify-between h-9 shrink-0 bg-paper-dim border-b border-line select-none ${padForTrafficLights ? "pl-20" : ""}`}
        >
            {/* Wordmark — bara där ingen menyrad bär appnamnet. */}
            {showWordmark && (
                <div data-tauri-drag-region className="flex items-center gap-2 px-3">
                    <Mic2 className="h-4 w-4 text-brand" />
                    <span className="text-sm font-bold tracking-tight text-ink">
                        Sagt<span className="text-ochre">.ai</span>
                    </span>
                </div>
            )}

            {/* Fönsterkontroller — bara när fönstret saknar nativt krom. */}
            {showWindowControls && (
                <div className="flex items-center h-full">
                    <button
                        type="button"
                        onClick={() => appWindow.minimize()}
                        aria-label="Minimera"
                        className="inline-flex items-center justify-center h-full w-12 text-ink-soft hover:bg-line transition-colors"
                    >
                        <Minus className="h-4 w-4" />
                    </button>
                    <button
                        type="button"
                        onClick={() => appWindow.toggleMaximize()}
                        aria-label={isMaximized ? "Återställ" : "Maximera"}
                        className="inline-flex items-center justify-center h-full w-12 text-ink-soft hover:bg-line transition-colors"
                    >
                        {isMaximized ? <Copy className="h-3.5 w-3.5" /> : <Square className="h-3.5 w-3.5" />}
                    </button>
                    <button
                        type="button"
                        onClick={() => appWindow.close()}
                        aria-label="Stäng"
                        className="inline-flex items-center justify-center h-full w-12 text-ink-soft hover:bg-red-600 hover:text-white transition-colors"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>
            )}
        </div>
    );
}
