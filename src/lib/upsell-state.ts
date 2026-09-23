/**
 * Tillståndsval för uppgraderingsmodalen.
 *
 * Modalens beteende styrdes tidigare av lösa booleans inflätade direkt i JSX. Två
 * buggar i följd satt där — rubrik och kropp kunde hamna i
 * konflikt, och auto-stängningen kunde kopplas ur permanent — eftersom varje villkor
 * läste flaggorna på sitt eget sätt. Här bor besluten i stället som rena funktioner
 * med ett gemensamt tillståndsbegrepp, så de kan testas uttömmande och inte kan glida
 * isär.
 *
 * Ren modul utan React- eller DOM-beroenden, i linje med övriga src/lib — vitest kör
 * i node-miljö (se vitest.config.ts).
 */

export interface UpsellFlags {
    /** Serverbekräftad Pro-status (stripe_status === "active"). */
    isPro: boolean
    /**
     * En betalning har påbörjats i den här app-sessionen. Överlever pollingens
     * 5-minuterstimeout, till skillnad från isWaiting, och nollställs vid uttrycklig
     * avfärdning eller när aktiveringen bekräftats.
     */
    paymentAttempted: boolean
    /** Pollar aktivt mot servern just nu (inom timeouten). */
    isWaiting: boolean
}

/**
 * Delmängden som avgör aktivering. Egen typ för att besluten nedan inte ska tvinga
 * anroparen att skicka in isWaiting — effekterna i modalen beror inte på pollingläget,
 * och att skicka det ändå hade inbjudit till att lägga det i effekternas beroenden.
 */
export type UpsellActivation = Pick<UpsellFlags, 'isPro' | 'paymentAttempted'>

export type UpsellView =
    /** Säljsidan — prislista och uppgraderingsknapp. */
    | 'sales'
    /** Betalning öppnad, vi pollar efter Stripe-bekräftelse. */
    | 'awaiting-confirmation'
    /** Pollingen har gett upp; användaren får uppdatera manuellt eller öppna betalningen igen. */
    | 'confirmation-stalled'
    /** Betalningen bekräftad i den här sessionen — kvittot, strax innan modalen stänger. */
    | 'activated'

/** Vad modalens kropp ska visa. */
export function selectUpsellView(f: UpsellFlags): UpsellView {
    if (f.isPro) return f.paymentAttempted ? 'activated' : 'sales'
    if (f.paymentAttempted) return f.isWaiting ? 'awaiting-confirmation' : 'confirmation-stalled'
    return 'sales'
}

// Rubriken har medvetet ingen egen funktion. Den ska läsa 'activated' ur selectUpsellView
// precis som kroppen gör — det är enda sättet att göra det strukturellt omöjligt för dem
// att säga emot varandra. Tidigare hade rubriken ett eget villkor, och visade då
// "Pro aktiverat!" ovanför prislistan och "Uppgradera nu" vid varje lyckat köp.

/**
 * Återvändande Pro-kund utan pågående betalning → det finns inget att sälja, stäng.
 *
 * Villkoret måste läsa paymentAttempted och inte isWaiting: isWaiting slocknar av sig
 * självt när betalningen går igenom, vilket gjorde att en nyss uppgraderad kund kunde
 * få modalen stängd mitt i firandet.
 */
export function shouldAutoClose(f: UpsellActivation & { isOpen: boolean }): boolean {
    return f.isOpen && f.isPro && !f.paymentAttempted
}

/**
 * Om aktiveringen ska firas (toast + fördröjd stängning).
 *
 * alreadyCelebrated är nödvändig eftersom paymentAttempted inte självslocknar när
 * betalningen går igenom: utan spärren fyrar varje omrendering av föräldern en ny
 * toast och skjuter stängningen framför sig.
 */
export function shouldCelebrate(f: UpsellActivation & { alreadyCelebrated: boolean }): boolean {
    return f.isPro && f.paymentAttempted && !f.alreadyCelebrated
}

/**
 * Varifrån uppgraderingsmodalen öppnades. Skickas som `source` på modalens PostHog-events
 * (`upsell_modal_opened`, `upgrade_clicked`, `checkout_opened`, `upsell_modal_dismissed`),
 * så tratten kan delas upp per ingång. Stabila slugs, aldrig fri text.
 *
 * `*_402`-varianterna betyder att klienten släppte igenom anropet men servern svarade 402.
 * I dag släpper klienten bara igenom Pro-användare, och för dem stänger auto-stängningen
 * modalen direkt utan att öppningen räknas (upsell-modal.tsx) — varianterna syns alltså
 * först om ett flöde släpper igenom gratisanvändare till servern. Glappet mellan klientens
 * och serverns bild av prenumerationen syns under tiden i `error_shown` / `analysis_failed`.
 */
export type UpsellSource =
    /** Långsamhetstipset "Därför tar det tid" → "Se Pro". */
    | 'slow_hint'
    /** Låsöverlägget över Protokoll-panelen → "Lås upp med Pro". */
    | 'locked_panel'
    /** Lägesväljaren i headern: gratisanvändare valde Moln. */
    | 'mode_pill'
    /** "Starta analys" / "Analysera igen" utan Pro. */
    | 'analysis'
    /** Analysen fick 402 från servern. */
    | 'analysis_402'
    /** Omtranskribering i molnet utan Pro. */
    | 'retranscribe'
    /** "Identifiera talare" utan Pro. */
    | 'identify_speakers'
    /** Talaridentifieringen fick 402 från servern. */
    | 'identify_speakers_402'
