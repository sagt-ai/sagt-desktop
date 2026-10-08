/**
 * Panelernas layout på startsidan: bredden mellan transkription och protokoll, vilken
 * panel som är hopfälld, sidomenyns bredd, och om sidomenyn visar bara ikoner.
 *
 * Ren modul utan React- eller DOM-beroenden, så att reglerna kan testas i node-miljö.
 * Lagringen skickas in som en funktion, och varje läsning och skrivning går genom
 * try/catch: en blockerad eller full lagring får aldrig hindra appen från att starta,
 * bara göra att layouten inte sparas.
 */

/** Transkriptionspanelens andel av bredden. Motsvarar den tidigare fördelningen 3/5. */
export const DEFAULT_SPLIT = 0.6

/** Minsta läsbara bredd per panel, i CSS-pixlar. */
export const MIN_TRANSCRIPT_PX = 360
export const MIN_PROTOCOL_PX = 320

/** Ett steg med piltangenterna, i CSS-pixlar. */
export const KEYBOARD_STEP_PX = 32

/** Sidomenyns bredd i CSS-pixlar. Standard motsvarar den tidigare fasta bredden. */
export const DEFAULT_SIDEBAR_PX = 256
export const MIN_SIDEBAR_PX = 180
/** Taket lämnar plats åt båda panelerna i standardfönstret (1040 px). */
export const MAX_SIDEBAR_PX = 360

export const PANEL_LAYOUT_KEY = "sagt_panel_layout"

export type Panel = "transcript" | "protocol"

/**
 * Hopfällningen är ETT fält, inte två booleans. Att båda panelerna är hopfällda samtidigt
 * går då inte att uttrycka.
 */
export type Collapsed = Panel | null

export interface PanelLayout {
    split: number
    collapsed: Collapsed
    sidebarWidth: number
    sidebarCollapsed: boolean
}

export const DEFAULT_LAYOUT: PanelLayout = {
    split: DEFAULT_SPLIT,
    collapsed: null,
    sidebarWidth: DEFAULT_SIDEBAR_PX,
    sidebarCollapsed: false,
}

/**
 * Begränsar andelen så att ingen panel blir smalare än sin minsta bredd.
 *
 * Är behållaren för smal för båda minimibredderna delas den i proportion till dem, i
 * stället för att låta den ena gränsen vinna och tömma den andra panelen. Utan känd
 * bredd (0 eller ogiltig) begränsas bara till ett rimligt intervall.
 */
export function clampSplit(
    fraction: number,
    containerWidth: number,
    minLeft: number = MIN_TRANSCRIPT_PX,
    minRight: number = MIN_PROTOCOL_PX,
): number {
    const f = Number.isFinite(fraction) ? fraction : DEFAULT_SPLIT
    if (!Number.isFinite(containerWidth) || containerWidth <= 0) {
        return Math.min(0.8, Math.max(0.2, f))
    }
    if (containerWidth < minLeft + minRight) {
        return minLeft / (minLeft + minRight)
    }
    const lo = minLeft / containerWidth
    const hi = 1 - minRight / containerWidth
    return Math.min(hi, Math.max(lo, f))
}

/** Andelen som pekaren pekar på, begränsad. */
export function splitFromPointer(pointerX: number, containerLeft: number, containerWidth: number): number {
    if (!Number.isFinite(containerWidth) || containerWidth <= 0) return DEFAULT_SPLIT
    return clampSplit((pointerX - containerLeft) / containerWidth, containerWidth)
}

/**
 * Tangentbordsstyrning av avdelaren. Returnerar null för tangenter som inte hör till
 * avdelaren, så att anroparen bara förhindrar standardbeteendet för sina egna.
 */
export function splitFromKey(key: string, fraction: number, containerWidth: number): number | null {
    const step = containerWidth > 0 ? KEYBOARD_STEP_PX / containerWidth : 0.04
    switch (key) {
        case "ArrowLeft": return clampSplit(fraction - step, containerWidth)
        case "ArrowRight": return clampSplit(fraction + step, containerWidth)
        case "Home": return clampSplit(0, containerWidth)
        case "End": return clampSplit(1, containerWidth)
        default: return null
    }
}

/** Fäll ihop en panel. Är den andra redan hopfälld öppnas den, så att en panel alltid syns. */
export function collapsePanel(layout: PanelLayout, panel: Panel): PanelLayout {
    return { ...layout, collapsed: panel }
}

/** Öppna en hopfälld panel. Båda panelerna syns efteråt. */
export function expandPanel(layout: PanelLayout, panel: Panel): PanelLayout {
    return layout.collapsed === panel ? { ...layout, collapsed: null } : layout
}

/** Dubbelklick på avdelaren: standardbredden tillbaka, och båda panelerna öppna. */
export function resetSplit(layout: PanelLayout): PanelLayout {
    return { ...layout, split: DEFAULT_SPLIT, collapsed: null }
}

/** Begränsar sidomenyns bredd till intervallet. En ogiltig bredd ger standard. */
export function clampSidebarWidth(px: number): number {
    if (!Number.isFinite(px)) return DEFAULT_SIDEBAR_PX
    return Math.round(Math.min(MAX_SIDEBAR_PX, Math.max(MIN_SIDEBAR_PX, px)))
}

/** Tangentbordsstyrning av sidomenyns kant. Null för tangenter som inte hör dit. */
export function sidebarWidthFromKey(key: string, width: number): number | null {
    switch (key) {
        case "ArrowLeft": return clampSidebarWidth(width - KEYBOARD_STEP_PX)
        case "ArrowRight": return clampSidebarWidth(width + KEYBOARD_STEP_PX)
        case "Home": return MIN_SIDEBAR_PX
        case "End": return MAX_SIDEBAR_PX
        default: return null
    }
}

/** Dubbelklick på sidomenyns kant: standardbredden tillbaka. Inget annat ändras. */
export function resetSidebarWidth(layout: PanelLayout): PanelLayout {
    return { ...layout, sidebarWidth: DEFAULT_SIDEBAR_PX }
}

/** Om två layouter är lika i varje sparat fält. Avgör om en ändring ska sparas. */
export function sameLayout(a: PanelLayout, b: PanelLayout): boolean {
    return a.split === b.split
        && a.collapsed === b.collapsed
        && a.sidebarWidth === b.sidebarWidth
        && a.sidebarCollapsed === b.sidebarCollapsed
}

/**
 * Tolkar sparad layout fält för fält. Okända eller trasiga värden faller tillbaka på
 * standard, så att en gammal eller manipulerad post inte kan låsa layouten.
 */
export function parsePanelLayout(raw: string | null): PanelLayout {
    if (!raw) return { ...DEFAULT_LAYOUT }
    let data: unknown
    try {
        data = JSON.parse(raw)
    } catch {
        return { ...DEFAULT_LAYOUT }
    }
    if (typeof data !== "object" || data === null) return { ...DEFAULT_LAYOUT }
    const d = data as Record<string, unknown>
    const split = typeof d.split === "number" && Number.isFinite(d.split) && d.split > 0 && d.split < 1
        ? d.split
        : DEFAULT_SPLIT
    const collapsed: Collapsed = d.collapsed === "transcript" || d.collapsed === "protocol" ? d.collapsed : null
    // En bredd utanför intervallet (till exempel från en äldre version med andra gränser)
    // begränsas i stället för att kastas, så att närmaste giltiga bredd behålls.
    const sidebarWidth = typeof d.sidebarWidth === "number" ? clampSidebarWidth(d.sidebarWidth) : DEFAULT_SIDEBAR_PX
    const sidebarCollapsed = d.sidebarCollapsed === true
    return { split, collapsed, sidebarWidth, sidebarCollapsed }
}

export type StorageLike = Pick<Storage, "getItem" | "setItem">

export function loadPanelLayout(storage: () => StorageLike): PanelLayout {
    try {
        return parsePanelLayout(storage().getItem(PANEL_LAYOUT_KEY))
    } catch {
        return { ...DEFAULT_LAYOUT }
    }
}

/** Sparar layouten. Returnerar false om lagringen inte gick att skriva. */
export function savePanelLayout(storage: () => StorageLike, layout: PanelLayout): boolean {
    try {
        storage().setItem(PANEL_LAYOUT_KEY, JSON.stringify(layout))
        return true
    } catch {
        return false
    }
}

/**
 * Vilken panels rubrik som bär kontoknappen. Normalt protokollets, men när protokollet
 * är hopfällt flyttar den till transkriptionen: annars försvinner både Logga in och
 * Logga ut så länge panelen är dold, och läget sparas mellan starter.
 */
export function accountButtonPanel(collapsed: Collapsed): Panel {
    return collapsed === "protocol" ? "transcript" : "protocol"
}
