import { useRef, useState, type RefObject } from "react";
import { Home, Mic, PanelLeftClose, PanelLeftOpen, Settings, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PANEL_HEADER_HEIGHT } from "@/components/dashboard/panel-chrome";
import { clampSidebarWidth, MAX_SIDEBAR_PX, MIN_SIDEBAR_PX, sidebarWidthFromKey } from "@/lib/panel-layout";
import { pauseLayoutSaving, useLayoutStore } from "@/store/layout-store";
import { cn } from "@/lib/utils";

type View = 'dashboard' | 'settings' | 'recordings';

interface SidebarProps {
    currentView: View;
    onViewChange: (view: View) => void;
}

const ITEMS: Array<{ view: View; label: string; icon: LucideIcon }> = [
    { view: 'dashboard', label: "Hem", icon: Home },
    { view: 'recordings', label: "Inspelningar", icon: Mic },
    { view: 'settings', label: "Inställningar", icon: Settings },
];

export function Sidebar({ currentView, onViewChange }: SidebarProps) {
    // Hopfälld visar menyn bara ikoner. Namnen finns kvar som verktygstips och för
    // skärmläsare.
    const collapsed = useLayoutStore((s) => s.sidebarCollapsed);
    const width = useLayoutStore((s) => s.sidebarWidth);
    const toggleSidebar = useLayoutStore((s) => s.toggleSidebar);
    const toggleLabel = collapsed ? "Fäll ut menyn" : "Fäll ihop menyn";
    const sidebarRef = useRef<HTMLDivElement>(null);
    const [resizing, setResizing] = useState(false);

    return (
        <div
            ref={sidebarRef}
            id="app-sidebar"
            data-sidebar={collapsed ? "collapsed" : "expanded"}
            className={cn(
                "relative border-r h-full bg-paper/80 backdrop-blur-md flex flex-col flex-none",
                // Animationen gäller hopfällningen, inte dragningen: under en dragning
                // skulle den få kanten att släpa efter pekaren.
                !resizing && "transition-[width] duration-200",
                collapsed && "w-14",
            )}
            style={collapsed ? undefined : { width: clampSidebarWidth(width) }}
        >
            {/* Knappen står i samma rubrikrad som panelernas knappar, på samma höjd. */}
            <div className={cn(PANEL_HEADER_HEIGHT, "flex-none flex items-center border-b border-line", collapsed ? "justify-center" : "justify-end px-4")}>
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 flex-none text-ink-muted hover:text-ink-soft rounded-full"
                    onClick={(e) => { e.currentTarget.blur(); toggleSidebar(); }}
                    title={toggleLabel}
                    aria-label={toggleLabel}
                    aria-expanded={!collapsed}
                    aria-controls="app-sidebar"
                >
                    {collapsed ? <PanelLeftOpen className="h-3.5 w-3.5" /> : <PanelLeftClose className="h-3.5 w-3.5" />}
                </Button>
            </div>
            <nav className={cn("flex-1 pt-4 space-y-2 overflow-hidden", collapsed ? "px-2" : "px-4")}>
                {ITEMS.map(({ view, label, icon: Icon }) => (
                    <Button
                        key={view}
                        variant={currentView === view ? "secondary" : "ghost"}
                        className={cn("w-full gap-2", collapsed ? "justify-center px-0" : "justify-start")}
                        onClick={() => onViewChange(view)}
                        title={collapsed ? label : undefined}
                        aria-label={collapsed ? label : undefined}
                        aria-current={currentView === view ? "page" : undefined}
                    >
                        <Icon className="w-4 h-4" />
                        {!collapsed && label}
                    </Button>
                ))}
            </nav>
            {!collapsed && (
                <SidebarResizer sidebarRef={sidebarRef} width={clampSidebarWidth(width)} onDraggingChange={setResizing} />
            )}
        </div>
    );
}

/**
 * Den dragbara högerkanten på sidomenyn. Samma mönster som avdelaren mellan panelerna:
 * pekaren fångas på elementet, och bredden sparas en gång när pekaren släpps. Kanten
 * ligger helt inuti menyn: menyn är ett eget staplingslager, så en del som stack ut
 * över huvudytan skulle hamna under den och inte gå att ta tag i.
 */
function SidebarResizer({
    sidebarRef,
    width,
    onDraggingChange,
}: {
    sidebarRef: RefObject<HTMLDivElement | null>;
    width: number;
    onDraggingChange: (dragging: boolean) => void;
}) {
    const setSidebarWidth = useLayoutStore((s) => s.setSidebarWidth);
    const resetSidebarWidth = useLayoutStore((s) => s.resetSidebarWidth);
    const dragging = useRef(false);
    // Avståndet från pekaren till menyns högerkant när dragningen börjar, så att kanten
    // inte hoppar till pekaren vid första rörelsen.
    const grabOffset = useRef(0);

    const finish = () => {
        if (!dragging.current) return;
        dragging.current = false;
        pauseLayoutSaving(false);
        onDraggingChange(false);
    };

    return (
        <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Menyns bredd"
            aria-controls="app-sidebar"
            aria-valuenow={width}
            aria-valuemin={MIN_SIDEBAR_PX}
            aria-valuemax={MAX_SIDEBAR_PX}
            aria-valuetext={`Menyn ${width} pixlar bred`}
            title="Dra för att ändra bredden. Dubbelklicka för standardbredd."
            tabIndex={0}
            data-sidebar-resizer
            className="group absolute inset-y-0 right-0 z-[60] w-2 cursor-col-resize touch-none focus-visible:outline-none"
            onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                e.currentTarget.setPointerCapture(e.pointerId);
                dragging.current = true;
                const rect = sidebarRef.current?.getBoundingClientRect();
                grabOffset.current = rect ? rect.right - e.clientX : 0;
                pauseLayoutSaving(true);
                onDraggingChange(true);
            }}
            onPointerMove={(e) => {
                if (!dragging.current) return;
                const rect = sidebarRef.current?.getBoundingClientRect();
                if (!rect) return;
                setSidebarWidth(clampSidebarWidth(e.clientX + grabOffset.current - rect.left));
            }}
            onPointerUp={(e) => {
                if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
                finish();
            }}
            onPointerCancel={finish}
            onLostPointerCapture={finish}
            onKeyDown={(e) => {
                const next = sidebarWidthFromKey(e.key, width);
                if (next === null) return;
                e.preventDefault();
                setSidebarWidth(next);
            }}
            onDoubleClick={() => resetSidebarWidth()}
        >
            <div className="ml-auto h-full w-0.5 bg-transparent transition-colors group-hover:bg-brand/30 group-focus-visible:bg-brand/60 group-active:bg-brand/50" />
        </div>
    );
}
