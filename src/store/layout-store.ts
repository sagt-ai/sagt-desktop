import { create } from "zustand";
import {
    collapsePanel,
    expandPanel,
    loadPanelLayout,
    resetSidebarWidth,
    resetSplit,
    sameLayout,
    savePanelLayout,
    type Panel,
    type PanelLayout,
} from "@/lib/panel-layout";

/**
 * Panelernas layout, delad mellan sidomenyn och startsidan. Egen nyckel i lagringen,
 * skild från inställningarna: layouten ska varken följa med "Återställ standard" för
 * ljudet eller inställningarnas versionsmigreringar.
 */
interface LayoutState extends PanelLayout {
    setSplit: (split: number) => void;
    resetSplit: () => void;
    collapse: (panel: Panel) => void;
    expand: (panel: Panel) => void;
    setSidebarWidth: (width: number) => void;
    resetSidebarWidth: () => void;
    toggleSidebar: () => void;
}

const storage = () => window.localStorage;

const pick = (s: PanelLayout): PanelLayout =>
    ({ split: s.split, collapsed: s.collapsed, sidebarWidth: s.sidebarWidth, sidebarCollapsed: s.sidebarCollapsed });

export const useLayoutStore = create<LayoutState>()((set, get) => ({
    ...loadPanelLayout(storage),
    setSplit: (split) => set({ split }),
    resetSplit: () => set(resetSplit(pick(get()))),
    collapse: (panel) => set(collapsePanel(pick(get()), panel)),
    expand: (panel) => set(expandPanel(pick(get()), panel)),
    setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
    resetSidebarWidth: () => set(resetSidebarWidth(pick(get()))),
    toggleSidebar: () => set({ sidebarCollapsed: !get().sidebarCollapsed }),
}));

/**
 * Sparar vid varje ändring utom under en pågående dragning, där anroparen sparar en gång
 * när pekaren släpps.
 */
let saving = true;
export function pauseLayoutSaving(paused: boolean) {
    saving = !paused;
    if (!paused) savePanelLayout(storage, pick(useLayoutStore.getState()));
}

useLayoutStore.subscribe((state, prev) => {
    if (!saving) return;
    if (sameLayout(pick(state), pick(prev))) return;
    savePanelLayout(storage, pick(state));
});
