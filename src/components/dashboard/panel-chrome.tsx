import { useRef, type ReactNode, type RefObject } from "react";
import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { clampSplit, splitFromKey, splitFromPointer, type Panel } from "@/lib/panel-layout";
import { pauseLayoutSaving, useLayoutStore } from "@/store/layout-store";
import { cn } from "@/lib/utils";

/**
 * Rubrikradens höjd, gemensam för båda panelerna, de hopfällda listerna och sidomenyn. Fast höjd i
 * stället för padding: innehållet skiljer sig (kontoknappen i protokollet är högre än
 * rubriken i transkriptionen), och med padding hamnade avdelarna på olika höjd.
 */
export const PANEL_HEADER_HEIGHT = "h-20";

const TITLES: Record<Panel, string> = { transcript: "Transkription", protocol: "Protokoll" };

/** Knappen för att fälla ihop en panel, i panelens rubrik. */
export function PanelControls({ panel }: { panel: Panel }) {
    const collapse = useLayoutStore((s) => s.collapse);
    const label = `Fäll ihop ${TITLES[panel].toLowerCase()}`;
    const CollapseIcon = panel === "transcript" ? PanelLeftClose : PanelRightClose;

    return (
        <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 flex-none text-ink-muted hover:text-ink-soft rounded-full"
            onClick={(e) => { e.currentTarget.blur(); collapse(panel); }}
            title={label}
            aria-label={label}
        >
            <CollapseIcon className="h-3.5 w-3.5" />
        </Button>
    );
}

/** En hopfälld panel: en smal list med rubriken och en knapp för att öppna den igen. */
export function CollapsedPanelStrip({ panel, icon }: { panel: Panel; icon: ReactNode }) {
    const expand = useLayoutStore((s) => s.expand);
    const title = TITLES[panel];
    const ExpandIcon = panel === "transcript" ? PanelLeftOpen : PanelRightOpen;
    const label = `Visa ${title.toLowerCase()}`;

    return (
        <div
            className={cn(
                "flex-none w-12 h-full flex flex-col overflow-hidden",
                panel === "transcript" ? "bg-white border-r border-line/60" : "bg-paper/60 border-l border-line/60",
            )}
            data-panel-strip={panel}
        >
            <div className={cn(PANEL_HEADER_HEIGHT, "flex-none flex items-center justify-center border-b border-line")}>
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-ink-muted hover:text-ink-soft rounded-full"
                    onClick={() => expand(panel)}
                    title={label}
                    aria-label={label}
                >
                    <ExpandIcon className="h-4 w-4" />
                </Button>
            </div>
            {/* Hela listan är klickbar. Knappen ovan är den åtkomliga vägen, så den här
                hålls utanför tabbordningen och skärmläsaren. */}
            <button
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                onClick={() => expand(panel)}
                className="flex-1 flex flex-col items-center gap-3 pt-5 text-ink-muted hover:text-ink-soft hover:bg-paper-dim/60 transition-colors"
            >
                {icon}
                <span className="[writing-mode:vertical-rl] text-[11px] font-semibold uppercase tracking-widest">
                    {title}
                </span>
            </button>
        </div>
    );
}

/**
 * Den dragbara avdelaren mellan panelerna. Pekaren fångas på elementet självt, så att
 * dragningen fortsätter utanför det och inga lyssnare på fönstret behöver städas bort.
 * Bredden sparas en gång när pekaren släpps, inte vid varje rörelse.
 */
export function PanelResizer({
    containerRef,
    containerWidth,
    split,
    controls,
    onDraggingChange,
}: {
    containerRef: RefObject<HTMLDivElement | null>;
    containerWidth: number;
    split: number;
    controls: string;
    onDraggingChange: (dragging: boolean) => void;
}) {
    const setSplit = useLayoutStore((s) => s.setSplit);
    const resetSplit = useLayoutStore((s) => s.resetSplit);
    const dragging = useRef(false);

    const finish = () => {
        if (!dragging.current) return;
        dragging.current = false;
        pauseLayoutSaving(false);
        onDraggingChange(false);
    };

    const min = Math.round(clampSplit(0, containerWidth) * 100);
    const max = Math.round(clampSplit(1, containerWidth) * 100);

    return (
        <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Panelernas bredd"
            aria-controls={controls}
            aria-valuenow={Math.round(split * 100)}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuetext={`Transkriptionen ${Math.round(split * 100)} procent av bredden`}
            title="Dra för att ändra bredden. Dubbelklicka för standardbredd."
            tabIndex={0}
            data-panel-resizer
            className="group relative z-[60] -mx-1 w-2 flex-none cursor-col-resize touch-none focus-visible:outline-none"
            onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                dragging.current = true;
                pauseLayoutSaving(true);
                onDraggingChange(true);
            }}
            onPointerMove={(e) => {
                if (!dragging.current) return;
                const rect = containerRef.current?.getBoundingClientRect();
                if (!rect) return;
                setSplit(splitFromPointer(e.clientX, rect.left, rect.width));
            }}
            onPointerUp={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
                finish();
            }}
            onPointerCancel={finish}
            onLostPointerCapture={finish}
            onKeyDown={(e) => {
                const next = splitFromKey(e.key, split, containerWidth);
                if (next === null) return;
                e.preventDefault();
                setSplit(next);
            }}
            onDoubleClick={() => resetSplit()}
        >
            <div className="mx-auto h-full w-0.5 bg-transparent transition-colors group-hover:bg-brand/30 group-focus-visible:bg-brand/60 group-active:bg-brand/50" />
        </div>
    );
}
