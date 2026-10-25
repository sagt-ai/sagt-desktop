export const CURRENT_VERSION = "0.12.4"

export type BuildChannel = "release" | "test" | "dev"

/**
 * Var bygget kommer ifrån: "release" (tagg), "test" (manuellt CI-bygge) eller
 * "dev" (lokalt). Skickas med varje händelse så att egna byggen kan filtreras
 * bort i PostHog utan kohort- eller stadsfilter. CI sätter VITE_BUILD_CHANNEL
 * uttryckligen; allt annat, även ett lokalt produktionsbygge, räknas som dev.
 */
export function buildChannel(isDev: boolean, raw: string | undefined): BuildChannel {
    if (isDev) return "dev"
    return raw === "release" || raw === "test" ? raw : "dev"
}

export const BUILD_CHANNEL: BuildChannel = buildChannel(
    import.meta.env.DEV,
    import.meta.env.VITE_BUILD_CHANNEL as string | undefined,
)
