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
    /** "Exportera" (transkriptvyn eller Inspelningar) utloggad: konto först, inget köp krävs. */
    | 'export'
    /** Gratiskontots exporter är slut för månaden (klientens räknare, serverns 402 eller förskottet). */
    | 'quota_export'
    /** Gratiskontots AI-protokoll är slut för månaden (klientens räknare eller serverns 402). */
    | 'quota_protocol'
    /** En protokollmall utöver standardmallen, som bara ingår i Pro. */
    | 'quota_template'
    /** Utloggad användare ville skapa ett protokoll: konto först, inget köp krävs. */
    | 'free_account'

/** Källor där fönstret erbjuder ett gratiskonto och stängs efter en inloggning utan köp. */
const FREE_PATH_SOURCES: ReadonlySet<UpsellSource> = new Set<UpsellSource>([
    'quota_protocol', 'quota_template', 'free_account', 'export', 'quota_export',
])

export function isFreePathSource(source: UpsellSource): boolean {
    return FREE_PATH_SOURCES.has(source)
}

/** Räknaren fönstret visar kvotraden ur. */
export interface QuotaLineInput {
    used: number
    limit: number
    /** Dagen räknaren nollställs (ISO-datum, UTC), om den är känd. */
    resets_at?: string | null
}

/**
 * Raden överst i fönstret, eller null. Pro ser den aldrig: där finns ingen kvot att
 * tala om, och fönstret stängs ändå direkt för dem (shouldAutoClose).
 */
export function quotaLine(f: { source: UpsellSource; isPro: boolean; quota: QuotaLineInput | null }): string | null {
    if (f.isPro) return null
    switch (f.source) {
        case 'quota_protocol': {
            if (!f.quota || f.quota.limit <= 0) return "Du har använt månadens AI-protokoll. Pro ger obegränsat."
            return `Du har använt ${f.quota.used} av ${f.quota.limit} AI-protokoll den här månaden. Pro ger obegränsat.`
        }
        case 'quota_template':
            return "Protokollmallar utöver standardmallen ingår i Pro."
        case 'free_account':
            return "AI-protokoll kräver ett konto. Med ett gratiskonto får du 3 i månaden."
        case 'quota_export': {
            if (!f.quota || f.quota.limit <= 0) return "Du har använt månadens exporter. Pro ger obegränsat."
            return `Du har använt ${f.quota.used} av ${f.quota.limit} exporter den här månaden. Pro ger obegränsat.`
        }
        case 'export':
            return "Export kräver ett konto. Med ett gratiskonto får du 10 exporter i månaden."
        default:
            return null
    }
}

/**
 * Fönstrets rubrik. Källorna med ett gratisval får en neutral rubrik: fönstret erbjuder två
 * val, och rubriken ska inte göra det till ett köp.
 */
export function upsellHeading(f: { source: UpsellSource; isSignedIn: boolean }): string {
    if (f.source === 'free_account' && !f.isSignedIn) return "Skapa protokoll med ett konto"
    if (f.source === 'quota_protocol') return "Månadens AI-protokoll är använda"
    if (f.source === 'quota_template') return "Mallen ingår i Pro"
    if (f.source === 'export' && !f.isSignedIn) return "Exportera med ett konto"
    if (f.source === 'quota_export') return "Månadens exporter är använda"
    return "Uppgradera till Sagt Pro"
}

/** Meningen under gratisvalet: vad kontot kostar och binder till. */
export const FREE_ACCOUNT_CAPTION = "Gratiskontot kostar ingenting och kräver inget betalkort."

const MONTHS = ["januari", "februari", "mars", "april", "maj", "juni", "juli", "augusti",
    "september", "oktober", "november", "december"]

/** "2026-11-01" → "1 november". Null för ett datum som inte går att läsa. */
export function resetDay(iso: string | null | undefined): string | null {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? "")
    if (!m) return null
    const month = MONTHS[Number(m[2]) - 1]
    const day = Number(m[3])
    return month && day >= 1 && day <= 31 ? `${day} ${month}` : null
}

/** Gratisvalet i fönstret, som står bredvid Pro med "eller" emellan. */
export interface FreeChoice {
    label: string
    caption: string
    /** `sign_in`: inloggning i webbläsaren utan köp. `close`: stäng, fortsätt gratis. */
    action: 'sign_in' | 'close'
}

/**
 * Gratisvalet, eller null när fönstret bara säljer Pro (Pro-källorna, och Pro själv).
 * Utloggad: konto först. Inloggad med kvoten slut: fortsätt gratis, med dagen då nya
 * protokoll kommer. Gratisvalet och Pro ska vara två tydligt åtskilda val.
 */
export function freeChoice(f: {
    source: UpsellSource
    isPro: boolean
    isSignedIn: boolean
    quota: QuotaLineInput | null
}): FreeChoice | null {
    if (f.isPro || !isFreePathSource(f.source)) return null
    if (!f.isSignedIn) return { label: "Skapa gratiskonto / logga in", caption: FREE_ACCOUNT_CAPTION, action: 'sign_in' }
    if (f.source === 'quota_protocol') {
        const day = resetDay(f.quota?.resets_at)
        return {
            label: "Fortsätt med gratiskontot",
            caption: day
                ? `Nya AI-protokoll den ${day}. Gratiskontot kostar ingenting.`
                : "Nya AI-protokoll nästa månad. Gratiskontot kostar ingenting.",
            action: 'close',
        }
    }
    if (f.source === 'quota_template') {
        return { label: "Fortsätt med gratiskontot", caption: "Standardmallen ingår i gratiskontot och kostar ingenting.", action: 'close' }
    }
    if (f.source === 'quota_export') {
        const day = resetDay(f.quota?.resets_at)
        return {
            label: "Fortsätt med gratiskontot",
            caption: day
                ? `Nya exporter den ${day}. Gratiskontot kostar ingenting.`
                : "Nya exporter nästa månad. Gratiskontot kostar ingenting.",
            action: 'close',
        }
    }
    return null
}

/**
 * Stäng fönstret när användaren loggat in utan att välja köp, om det öppnades för
 * gratiskontot. Den som valde "Uppgradera" fortsätter i stället till betalningen.
 */
export function shouldCloseAfterSignIn(f: {
    source: UpsellSource
    isOpen: boolean
    signedInAtOpen: boolean
    isSignedIn: boolean
    pendingUpgrade: boolean
}): boolean {
    return f.isOpen && isFreePathSource(f.source) && !f.signedInAtOpen && f.isSignedIn && !f.pendingUpgrade
}

/**
 * Vilket fönster ett klick på "Skapa protokoll" öppnar, givet grinden, eller null när
 * begäran ska skickas. Gratiskontot med protokoll kvar och Pro öppnar aldrig fönstret.
 */
export function upsellForProtocolGate(gate: 'allowed' | 'sign_in' | 'quota_exhausted'): UpsellSource | null {
    if (gate === 'sign_in') return 'free_account'
    if (gate === 'quota_exhausted') return 'quota_protocol'
    return null
}

/**
 * Pro-listan. Varje rad ska gå att belägga i koden eller villkoren:
 *  - molnmodellen är ett val i Pro, inte standard
 *  - synk = resultatet sparas i kontot och syns i webbens översikt
 *  - export = Word, Markdown, text och PDF (gratiskontot har en månadskvot, Pro obegränsat)
 *  - uppsägning i kundportalen, när som helst
 */
export const PRO_ROWS = [
    "KB-Whisper Large i molnet, när du vill ha högre precision än den lokala modellen",
    "Obegränsade AI-mötesprotokoll — sammanfattning, beslut & åtgärder",
    "Synk mellan enheter",
    "Export till Word, Markdown, text och PDF",
    "Avbryt när du vill",
] as const;

/** AI:n körs på svenska servrar. Uppladdat ljud raderas automatiskt efter ett dygn.
 *  Inte "allt i Sverige": appens drift och lagring ligger i Finland, kontot hos en
 *  leverantör i USA. */
export const PRO_FOOTNOTE = "Körs på EU-servrar. Ljud raderas automatiskt inom 24 h.";
