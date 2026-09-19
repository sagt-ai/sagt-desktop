// Svaret från GET /system/config (publik, ingen auth), som AppGuard hämtar vid start.
// Samma regel som webbens frontend/lib/system-config.ts; de två paketen delar ingen kod.
//
// Håll modulen importfri, som upsell-state.ts, så att Vitest kan köra den i node-miljö.

export interface SystemConfig {
    // Backendens kill switch för talarseparering (DIARIZE_ENABLED). När den är av svarar
    // POST /diarize 503, men först när hela MÖTET-kanalen laddats upp, och workern släpper
    // `diarize` på POST /jobs utan felsvar.
    diarize_enabled?: boolean
}

/**
 * Är talarseparering påslagen i backend? Bara när svaret uttryckligen är `true`.
 * Allt annat ger false: en config som inte hämtats (appen startade offline, eller
 * hämtningen har inte hunnit klart), en äldre backend utan fältet, och värden som bara
 * är sanna i JavaScript (strängen "false", 1).
 * Att hoppa över ett valfritt Beta-steg i onödan kostar lite. Att ladda upp mötesljudet
 * till en endpoint som ändå svarar 503 är felet.
 */
export function diarizeAvailable(config: SystemConfig | null | undefined): boolean {
    return config?.diarize_enabled === true
}
