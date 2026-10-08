import { describe, it, expect } from "vitest";
import {
    accountButtonPanel,
    clampSidebarWidth,
    clampSplit,
    collapsePanel,
    DEFAULT_LAYOUT,
    DEFAULT_SIDEBAR_PX,
    DEFAULT_SPLIT,
    expandPanel,
    KEYBOARD_STEP_PX,
    loadPanelLayout,
    MAX_SIDEBAR_PX,
    MIN_PROTOCOL_PX,
    MIN_SIDEBAR_PX,
    MIN_TRANSCRIPT_PX,
    PANEL_LAYOUT_KEY,
    parsePanelLayout,
    resetSidebarWidth,
    resetSplit,
    sameLayout,
    savePanelLayout,
    sidebarWidthFromKey,
    splitFromKey,
    splitFromPointer,
    type Collapsed,
    type Panel,
    type PanelLayout,
    type StorageLike,
} from "./panel-layout";

const layout = (collapsed: Collapsed, split = DEFAULT_SPLIT): PanelLayout =>
    ({ split, collapsed, sidebarWidth: DEFAULT_SIDEBAR_PX, sidebarCollapsed: false });

/** Ett minneslager som beter sig som localStorage. */
function memoryStorage(): StorageLike & { data: Map<string, string> } {
    const data = new Map<string, string>();
    return {
        data,
        getItem: (k) => data.get(k) ?? null,
        setItem: (k, v) => { data.set(k, v); },
    };
}

const throwing: StorageLike = {
    getItem: () => { throw new Error("SecurityError"); },
    setItem: () => { throw new Error("QuotaExceededError"); },
};

describe("clampSplit", () => {
    const W = 1000;

    it("släpper igenom en andel inom gränserna", () => {
        expect(clampSplit(0.5, W)).toBe(0.5);
    });

    it("håller transkriptionen på minst sin minsta bredd", () => {
        expect(clampSplit(0.05, W)).toBeCloseTo(MIN_TRANSCRIPT_PX / W);
    });

    it("håller protokollet på minst sin minsta bredd", () => {
        expect(clampSplit(0.98, W)).toBeCloseTo(1 - MIN_PROTOCOL_PX / W);
    });

    it("ger varje panel minst sin minsta bredd i pixlar vid varje andel", () => {
        for (const width of [MIN_TRANSCRIPT_PX + MIN_PROTOCOL_PX, 784, 1000, 1600]) {
            for (let f = -0.5; f <= 1.5; f += 0.05) {
                const s = clampSplit(f, width);
                expect(s * width).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_PX - 1e-9);
                expect((1 - s) * width).toBeGreaterThanOrEqual(MIN_PROTOCOL_PX - 1e-9);
            }
        }
    });

    it("delar i proportion till minimibredderna när behållaren är för smal för båda", () => {
        const s = clampSplit(0.9, 400);
        expect(s).toBeCloseTo(MIN_TRANSCRIPT_PX / (MIN_TRANSCRIPT_PX + MIN_PROTOCOL_PX));
    });

    it("begränsar till ett rimligt intervall när bredden är okänd", () => {
        expect(clampSplit(0.99, 0)).toBe(0.8);
        expect(clampSplit(0.01, Number.NaN)).toBe(0.2);
    });

    it("ersätter en ogiltig andel med standard", () => {
        expect(clampSplit(Number.NaN, 1000)).toBe(DEFAULT_SPLIT);
    });
});

describe("splitFromPointer", () => {
    it("räknar andelen från behållarens vänsterkant", () => {
        expect(splitFromPointer(300 + 500, 300, 1000)).toBe(0.5);
    });

    it("begränsar dragningen förbi kanten", () => {
        expect(splitFromPointer(0, 300, 1000)).toBeCloseTo(MIN_TRANSCRIPT_PX / 1000);
    });
});

describe("splitFromKey", () => {
    const W = 1000;

    it("flyttar ett steg åt vänster och höger", () => {
        expect(splitFromKey("ArrowLeft", 0.5, W)).toBeCloseTo(0.5 - KEYBOARD_STEP_PX / W);
        expect(splitFromKey("ArrowRight", 0.5, W)).toBeCloseTo(0.5 + KEYBOARD_STEP_PX / W);
    });

    it("Home och End går till gränserna", () => {
        expect(splitFromKey("Home", 0.5, W)).toBeCloseTo(MIN_TRANSCRIPT_PX / W);
        expect(splitFromKey("End", 0.5, W)).toBeCloseTo(1 - MIN_PROTOCOL_PX / W);
    });

    it("stannar vid gränsen i stället för att passera den", () => {
        expect(splitFromKey("ArrowLeft", MIN_TRANSCRIPT_PX / W, W)).toBeCloseTo(MIN_TRANSCRIPT_PX / W);
    });

    it("lämnar andra tangenter till anroparen", () => {
        expect(splitFromKey("Enter", 0.5, W)).toBeNull();
        expect(splitFromKey("ArrowUp", 0.5, W)).toBeNull();
    });
});

describe("hopfällning", () => {
    const STATES: Collapsed[] = [null, "transcript", "protocol"];
    const PANELS: Panel[] = ["transcript", "protocol"];
    type Op = (l: PanelLayout, p: Panel) => PanelLayout;
    const OPS: Array<[string, Op]> = [
        ["collapsePanel", collapsePanel],
        ["expandPanel", expandPanel],
    ];

    // Uttömmande: varje operation från varje läge, på varje panel. Minst en panel syns alltid.
    for (const [name, op] of OPS) {
        for (const from of STATES) {
            for (const panel of PANELS) {
                it(`${name}(${panel}) från ${String(from)} lämnar en panel synlig`, () => {
                    const next = op(layout(from), panel);
                    expect(STATES).toContain(next.collapsed);
                    const visible = PANELS.filter((p) => p !== next.collapsed);
                    expect(visible.length).toBeGreaterThanOrEqual(1);
                });
            }
        }
    }

    it("att fälla ihop den ena när den andra är hopfälld öppnar den andra", () => {
        expect(collapsePanel(layout("protocol"), "transcript").collapsed).toBe("transcript");
    });

    it("expandPanel öppnar bara den panel som är hopfälld", () => {
        expect(expandPanel(layout("protocol"), "protocol").collapsed).toBeNull();
        expect(expandPanel(layout("protocol"), "transcript").collapsed).toBe("protocol");
    });

    it("hopfällningen rör inte bredden", () => {
        expect(collapsePanel(layout(null, 0.45), "protocol").split).toBe(0.45);
    });
});

describe("resetSplit", () => {
    it("ger standardbredden och öppnar båda panelerna", () => {
        const r = resetSplit({ split: 0.42, collapsed: "protocol", sidebarWidth: 300, sidebarCollapsed: true });
        expect(r).toEqual({ split: DEFAULT_SPLIT, collapsed: null, sidebarWidth: 300, sidebarCollapsed: true });
    });
});

describe("parsePanelLayout", () => {
    it("ger standard för tomt, trasigt och fel typ", () => {
        for (const raw of [null, "", "{", "null", "42", "\"text\""]) {
            expect(parsePanelLayout(raw)).toEqual(DEFAULT_LAYOUT);
        }
    });

    it("läser en giltig post", () => {
        const raw = JSON.stringify({ split: 0.45, collapsed: "transcript", sidebarWidth: 300, sidebarCollapsed: true });
        expect(parsePanelLayout(raw)).toEqual({ split: 0.45, collapsed: "transcript", sidebarWidth: 300, sidebarCollapsed: true });
    });

    it("ersätter ogiltiga fält ett i taget", () => {
        const raw = JSON.stringify({ split: 7, collapsed: "both", sidebarWidth: "bred", sidebarCollapsed: "yes" });
        expect(parsePanelLayout(raw)).toEqual(DEFAULT_LAYOUT);
    });

    it("kan inte läsa in ett läge där båda panelerna är hopfällda", () => {
        const raw = JSON.stringify({ split: 0.5, collapsed: ["transcript", "protocol"] });
        expect(parsePanelLayout(raw).collapsed).toBeNull();
    });

    it("returnerar en ny kopia, så att standardvärdet inte kan ändras av misstag", () => {
        const a = parsePanelLayout(null);
        a.split = 0.1;
        expect(DEFAULT_LAYOUT.split).toBe(DEFAULT_SPLIT);
    });
});

describe("loadPanelLayout och savePanelLayout", () => {
    it("sparar och läser tillbaka samma layout", () => {
        const s = memoryStorage();
        const l: PanelLayout = { split: 0.52, collapsed: "protocol", sidebarWidth: 312, sidebarCollapsed: true };
        expect(savePanelLayout(() => s, l)).toBe(true);
        expect(s.data.has(PANEL_LAYOUT_KEY)).toBe(true);
        expect(loadPanelLayout(() => s)).toEqual(l);
    });

    it("ger standard när lagringen kastar vid läsning", () => {
        expect(loadPanelLayout(() => throwing)).toEqual(DEFAULT_LAYOUT);
    });

    it("ger standard när själva åtkomsten till lagringen kastar", () => {
        expect(loadPanelLayout(() => { throw new Error("blockerad"); })).toEqual(DEFAULT_LAYOUT);
    });

    it("svarar false i stället för att kasta när lagringen inte går att skriva", () => {
        expect(savePanelLayout(() => throwing, DEFAULT_LAYOUT)).toBe(false);
        expect(savePanelLayout(() => { throw new Error("blockerad"); }, DEFAULT_LAYOUT)).toBe(false);
    });
});

describe("sidomenyns bredd", () => {
    it("släpper igenom en bredd inom gränserna", () => {
        expect(clampSidebarWidth(300)).toBe(300);
    });

    it("begränsar till minsta och största bredd", () => {
        expect(clampSidebarWidth(MIN_SIDEBAR_PX - 1)).toBe(MIN_SIDEBAR_PX);
        expect(clampSidebarWidth(0)).toBe(MIN_SIDEBAR_PX);
        expect(clampSidebarWidth(MAX_SIDEBAR_PX + 1)).toBe(MAX_SIDEBAR_PX);
        expect(clampSidebarWidth(5000)).toBe(MAX_SIDEBAR_PX);
    });

    it("ersätter en ogiltig bredd med standard", () => {
        expect(clampSidebarWidth(Number.NaN)).toBe(DEFAULT_SIDEBAR_PX);
        expect(clampSidebarWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SIDEBAR_PX);
    });

    it("ger hela pixlar, så att en dragning inte sparar decimaler", () => {
        expect(clampSidebarWidth(250.6)).toBe(251);
    });

    it("standardbredden ligger inom gränserna", () => {
        expect(clampSidebarWidth(DEFAULT_SIDEBAR_PX)).toBe(DEFAULT_SIDEBAR_PX);
    });

    it("lämnar plats åt båda panelerna i standardfönstret vid största bredd", () => {
        expect(1040 - MAX_SIDEBAR_PX).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_PX + MIN_PROTOCOL_PX);
    });

    it("pilarna flyttar kanten ett steg, Home och End till gränserna", () => {
        expect(sidebarWidthFromKey("ArrowLeft", 256)).toBe(256 - KEYBOARD_STEP_PX);
        expect(sidebarWidthFromKey("ArrowRight", 256)).toBe(256 + KEYBOARD_STEP_PX);
        expect(sidebarWidthFromKey("Home", 256)).toBe(MIN_SIDEBAR_PX);
        expect(sidebarWidthFromKey("End", 256)).toBe(MAX_SIDEBAR_PX);
    });

    it("pilarna stannar vid gränserna", () => {
        expect(sidebarWidthFromKey("ArrowLeft", MIN_SIDEBAR_PX)).toBe(MIN_SIDEBAR_PX);
        expect(sidebarWidthFromKey("ArrowRight", MAX_SIDEBAR_PX)).toBe(MAX_SIDEBAR_PX);
    });

    it("lämnar andra tangenter till anroparen", () => {
        expect(sidebarWidthFromKey("Enter", 256)).toBeNull();
        expect(sidebarWidthFromKey("ArrowUp", 256)).toBeNull();
    });

    it("återställningen ger standardbredden och rör inget annat", () => {
        const l: PanelLayout = { split: 0.45, collapsed: "protocol", sidebarWidth: 340, sidebarCollapsed: false };
        expect(resetSidebarWidth(l)).toEqual({ ...l, sidebarWidth: DEFAULT_SIDEBAR_PX });
    });

    it("en sparad bredd utanför gränserna begränsas vid läsning", () => {
        expect(parsePanelLayout(JSON.stringify({ sidebarWidth: 40 })).sidebarWidth).toBe(MIN_SIDEBAR_PX);
        expect(parsePanelLayout(JSON.stringify({ sidebarWidth: 9000 })).sidebarWidth).toBe(MAX_SIDEBAR_PX);
    });

    it("en post utan bredd, från en äldre version, ger standardbredden", () => {
        const raw = JSON.stringify({ split: 0.5, collapsed: null, sidebarCollapsed: true });
        expect(parsePanelLayout(raw)).toEqual({ split: 0.5, collapsed: null, sidebarWidth: DEFAULT_SIDEBAR_PX, sidebarCollapsed: true });
    });
});

describe("sameLayout", () => {
    const base: PanelLayout = { split: 0.5, collapsed: null, sidebarWidth: 256, sidebarCollapsed: false };

    it("lika layouter är lika", () => {
        expect(sameLayout(base, { ...base })).toBe(true);
    });

    // Varje fält för sig: en ändring som bara rör ett fält ska ändå sparas.
    const CHANGES: Array<[string, Partial<PanelLayout>]> = [
        ["split", { split: 0.55 }],
        ["collapsed", { collapsed: "protocol" }],
        ["sidebarWidth", { sidebarWidth: 300 }],
        ["sidebarCollapsed", { sidebarCollapsed: true }],
    ];
    for (const [field, change] of CHANGES) {
        it(`ser en ändring av bara ${field}`, () => {
            expect(sameLayout(base, { ...base, ...change })).toBe(false);
        });
    }

    it("täcker varje fält i layouten", () => {
        expect(CHANGES.map(([f]) => f).sort()).toEqual(Object.keys(DEFAULT_LAYOUT).sort());
    });
});

describe("accountButtonPanel", () => {
    it("kontoknappen syns i varje läge, i en panel som inte är hopfälld", () => {
        for (const c of [null, "transcript", "protocol"] as Collapsed[]) {
            expect(accountButtonPanel(c)).not.toBe(c);
        }
    });

    it("står i protokollets rubrik när protokollet syns", () => {
        expect(accountButtonPanel(null)).toBe("protocol");
        expect(accountButtonPanel("transcript")).toBe("protocol");
    });
});
