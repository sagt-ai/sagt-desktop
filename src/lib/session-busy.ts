// Finns det en inspelning som inte är färdigsparad? Frågan som stängvakten,
// uppdateraren och omladdningsspärren ställer innan de låter appen gå.
//
// Två källor, och båda behövs:
//
// - Gränssnittets tillstånd (spelar in, slutför). Det täcker också molnläget, där texten
//   kommer från servern och ljudmotorn inte vet när den sista biten är klar.
// - Ljudmotorns svar (`session_busy`). Det täcker glappet mellan Stopp och sparandet och
//   en lång kö till den lokala transkriberingen, och det stämmer även efter att
//   gränssnittet laddats om: då har gränssnittets tillstånd börjat om från noll medan
//   ljudmotorn fortsätter.
//
// Går ljudmotorn inte att fråga räknas det som upptaget. Ett onödigt "vill du verkligen
// stänga?" kostar ett klick; en stängning mitt i ett sparande kostar mötet.

export interface BusyState {
    isRecording: boolean
    isProcessing: boolean
}

export function uiBusy(s: BusyState): boolean {
    return s.isRecording || s.isProcessing
}

export async function sessionBusy(
    ui: BusyState,
    askEngine: () => Promise<boolean>,
): Promise<boolean> {
    if (uiBusy(ui)) return true
    try {
        return (await askEngine()) === true
    } catch {
        return true
    }
}

/** Tangenterna som laddar om webbvyn: F5, Ctrl+R, Ctrl+Shift+R och Cmd+R. */
export function isReloadShortcut(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey">): boolean {
    if (e.key === "F5") return true
    return (e.ctrlKey || e.metaKey) && (e.key === "r" || e.key === "R")
}

export const LEAVE_TITLE = "Inspelningen är inte färdigsparad"
export const LEAVE_MESSAGE =
    "En inspelning pågår eller transkriberas fortfarande. Stänger du nu kan slutet av " +
    "texten saknas. Ljudet sparas och visas i Inspelningar nästa gång du öppnar Sagt.ai."

/**
 * Stängvakten. Svarar om fönstret får stängas: direkt om ingen inspelning är på väg,
 * annars bara om användaren bekräftar.
 *
 * Går dialogen inte att visa stängs fönstret ändå. Annars vore en trasig dialog ett
 * fönster som inte går att stänga, och ljudet återställs ändå vid nästa start.
 */
export async function allowLeave(
    isBusy: () => Promise<boolean>,
    confirm: () => Promise<boolean>,
): Promise<boolean> {
    if (!(await isBusy())) return true
    try {
        return (await confirm()) === true
    } catch {
        return true
    }
}

/**
 * Omladdningsspärren. En omladdning av webbvyn nollställer gränssnittets tillstånd medan
 * ljudmotorn fortsätter: en pågående inspelning syns då inte längre, och ingen knapp
 * stoppar den. Appen har ingen användning för omladdning, så den spärras alltid utom
 * under utveckling. Returnerar true om tangenten spärrades.
 */
export function blockReload(
    e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "preventDefault" | "stopPropagation">,
    dev: boolean,
): boolean {
    if (dev || !isReloadShortcut(e)) return false
    e.preventDefault()
    e.stopPropagation()
    return true
}

/**
 * Webbvyns egen högerklicksmeny har "Uppdatera" och laddar om precis som F5. Menyn
 * spärras därför, utom i textfält och på markerad text, där den behövs för att klippa
 * ut, kopiera och klistra in.
 * ⚠️ ANTAGANDE: att menyn i textfält och på markerad text saknar "Uppdatera", som i
 * Chromium. Inte kört i appen.
 */
export function blockContextMenu(
    e: Pick<MouseEvent, "preventDefault">,
    target: { editable: boolean },
    hasSelection: boolean,
    dev: boolean,
): boolean {
    if (dev || target.editable || hasSelection) return false
    e.preventDefault()
    return true
}
