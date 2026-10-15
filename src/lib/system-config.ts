// Svaret från GET /system/config (publik, ingen auth), som AppGuard hämtar vid start.
// Samma regel som webbens frontend/lib/system-config.ts; de två paketen delar ingen kod.
//
// Håll modulen importfri, som upsell-state.ts, så att Vitest kan köra den i node-miljö.

export interface SystemConfig {
    // Talarseparering har två vägar med var sin kill switch i backend:
    // - efter mötet (POST /diarize). Av → 503, men först när hela MÖTET-kanalen laddats upp.
    // - omtranskribering med talare (POST /jobs med `diarize`). Av → servern släpper
    //   `diarize` utan felsvar, så valet vore en tyst no-op.
    diarize_after_meeting_enabled?: boolean
    job_diarize_enabled?: boolean
    // Det gamla fältet, som en äldre backend skickar för båda vägarna. Läses bara när de
    // nya fälten saknas.
    diarize_enabled?: boolean
    // Backendens kill switch för live-diarisering (LIVE_DIARIZE_ENABLED). När den är av
    // svarar POST /live-diarize 503 vid varje inspelningsstart, och 503:an räknas som ett
    // serverfel. Klienten läser fältet för att inte fråga alls.
    live_diarize_enabled?: boolean
    // Erbjuder servern årsbetalning? Utan det svarar kassan 503 på `interval: "year"`.
    pro_yearly_available?: boolean
    // MCP (lokal server för en AI-assistent på datorn). Styr om avsnittet i Inställningar
    // visas. En MCP-server som redan slagits på fortsätter fungera oavsett fältet.
    mcp_available?: boolean
}

// Det nya fältet om backend skickar det, annars det gamla gemensamma.
function pathFlag(config: SystemConfig | null | undefined, field: "diarize_after_meeting_enabled" | "job_diarize_enabled"): unknown {
    if (!config) return undefined
    return field in config ? config[field] : config.diarize_enabled
}

/**
 * Är talarsepareringen efter mötet påslagen i backend? Bara när svaret uttryckligen är
 * `true`. Allt annat ger false: en config som inte hämtats (appen startade offline, eller
 * hämtningen har inte hunnit klart), en äldre backend utan fälten, och värden som bara
 * är sanna i JavaScript (strängen "false", 1).
 * Att hoppa över ett valfritt Beta-steg i onödan kostar lite. Att ladda upp mötesljudet
 * till en endpoint som ändå svarar 503 är felet.
 */
export function diarizeAvailable(config: SystemConfig | null | undefined): boolean {
    return pathFlag(config, "diarize_after_meeting_enabled") === true
}

/**
 * Tar backend emot omtranskribering med talarseparering? Samma strikta regel. Ett val som
 * servern släpper utan felsvar är felet; ett dolt val kostar lite.
 */
export function jobDiarizeAvailable(config: SystemConfig | null | undefined): boolean {
    return pathFlag(config, "job_diarize_enabled") === true
}

/**
 * Är live-diarisering påslagen i backend? Samma strikta regel som ovan, och av samma skäl:
 * en äldre backend utan fältet ska ge false, inte "vi vet inte, testa ändå". Att hoppa över
 * ett valfritt Beta-steg kostar lite. Att be om en session servern ändå nekar kostar en 503
 * vid varje inspelningsstart.
 */
export function liveDiarizeAvailable(config: SystemConfig | null | undefined): boolean {
    return config?.live_diarize_enabled === true
}

/**
 * Ska uppgraderingsfönstret erbjuda årsbetalning? Samma strikta regel som ovan: bara ett
 * uttryckligt `true`. Ett dolt årsval kostar en köpare som fick betala månadsvis. Ett
 * visat val som servern svarar 503 på är ett köp som inte blir av.
 */
export function proYearlyAvailable(config: SystemConfig | null | undefined): boolean {
    return config?.pro_yearly_available === true
}

export type BillingInterval = "month" | "year"

/**
 * Intervallet som skickas till kassan. Ett årsval som valdes medan årspriset fanns, men
 * som skickas efter att configen sagt nej (en inloggning emellan, en ny hämtning),
 * blir månad: hellre det pris som står i rubriken än ett 503.
 */
export function checkoutInterval(chosen: BillingInterval, yearlyAvailable: boolean): BillingInterval {
    return chosen === "year" && yearlyAvailable ? "year" : "month"
}

/** Ska MCP-avsnittet visas? Samma strikta regel: bara ett uttryckligt `true`. */
export function mcpAvailable(config: SystemConfig | null | undefined): boolean {
    return config?.mcp_available === true
}
