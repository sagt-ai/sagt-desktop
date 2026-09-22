// Svaret från GET /system/config (publik, ingen auth), som AppGuard hämtar vid start.
// Samma regel som webbens frontend/lib/system-config.ts; de två paketen delar ingen kod.
//
// Håll modulen importfri, som upsell-state.ts, så att Vitest kan köra den i node-miljö.

export interface SystemConfig {
    // Backendens kill switch för talarseparering (DIARIZE_ENABLED). När den är av svarar
    // POST /diarize 503, men först när hela MÖTET-kanalen laddats upp, och workern släpper
    // `diarize` på POST /jobs utan felsvar.
    diarize_enabled?: boolean
    // Backendens kill switch för live-diarisering (LIVE_DIARIZE_ENABLED). När den är av
    // svarar POST /live-diarize 503 vid varje inspelningsstart, och 503:an räknas i
    // 5xx-larmet. Klienten läser fältet för att inte fråga alls.
    live_diarize_enabled?: boolean
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

/**
 * Är live-diarisering påslagen i backend? Samma strikta regel som ovan, och av samma skäl:
 * en äldre backend utan fältet ska ge false, inte "vi vet inte, testa ändå". Att hoppa över
 * ett valfritt Beta-steg kostar lite. Att be om en session servern ändå nekar kostar en 503
 * i 5xx-larmet vid varje inspelningsstart.
 */
export function liveDiarizeAvailable(config: SystemConfig | null | undefined): boolean {
    return config?.live_diarize_enabled === true
}
