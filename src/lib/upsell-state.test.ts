import { describe, it, expect } from "vitest";
import {
    FREE_ACCOUNT_CAPTION,
    freeChoice,
    PRO_FOOTNOTE,
    PRO_ROWS,
    quotaLine,
    resetDay,
    upsellHeading,
    selectUpsellView,
    shouldAutoClose,
    shouldCelebrate,
    shouldCloseAfterSignIn,
    upsellForProtocolGate,
    type UpsellFlags,
    type UpsellSource,
    type UpsellView,
} from "./upsell-state";
import { entitlementGate } from "./entitlements";

const flags = (isPro: boolean, paymentAttempted: boolean, isWaiting: boolean): UpsellFlags =>
    ({ isPro, paymentAttempted, isWaiting });

/** Alla åtta flaggkombinationer — uttömmande, så inget fall kan glömmas bort. */
const ALL: Array<[UpsellFlags, UpsellView]> = [
    // isPro=false — kunden har inte Pro
    [flags(false, false, false), 'sales'],                  // orörd modal
    [flags(false, false, true), 'sales'],                   // polling utan betalförsök: kan inte inträffa, men får aldrig ge väntevy
    [flags(false, true, true), 'awaiting-confirmation'],    // betalning öppnad, pollar
    [flags(false, true, false), 'confirmation-stalled'],    // pollingen har gett upp
    // isPro=true — servern har bekräftat Pro
    [flags(true, false, false), 'sales'],                   // återvändande Pro-kund (stängs av shouldAutoClose)
    [flags(true, false, true), 'sales'],
    [flags(true, true, false), 'activated'],                // nyss aktiverad → kvitto, inte prislista
    [flags(true, true, true), 'activated'],
];

describe("selectUpsellView", () => {
    it.each(ALL)("%o → %s", (f, expected) => {
        expect(selectUpsellView(f)).toBe(expected);
    });

    it("väntevy kräver alltid ett påbörjat betalförsök", () => {
        for (const [f, view] of ALL) {
            if (view === 'awaiting-confirmation' || view === 'confirmation-stalled') {
                expect(f.paymentAttempted).toBe(true);
                expect(f.isPro).toBe(false);
            }
        }
    });

    it("isWaiting skiljer pollande från stillastående, aldrig något annat", () => {
        expect(selectUpsellView(flags(false, true, true))).toBe('awaiting-confirmation');
        expect(selectUpsellView(flags(false, true, false))).toBe('confirmation-stalled');
    });
});

describe("aktiveringsvyn", () => {
    // Regression. Före activated-vyn gav den här kombinationen 'sales', medan rubriken hade
    // ett EGET villkor som blev sant — så modalen visade "Pro aktiverat!" med grön bock
    // ovanför prislistan och "Uppgradera nu". Det hände vid varje lyckat köp, under de
    // sekunder modalen stod kvar innan den stängde, och i ett kantfall utan att stänga alls.
    // Rubriken läser nu 'activated' ur samma selectUpsellView som kroppen; konflikten är
    // därmed strukturellt omöjlig och behöver inget eget test.
    it("REGRESSION: bekräftad betalning ger kvitto, aldrig säljsida", () => {
        expect(selectUpsellView(flags(true, true, false))).toBe('activated');
        expect(selectUpsellView(flags(true, true, true))).toBe('activated');
    });

    it("återvändande Pro-kund utan betalförsök får inget kvitto", () => {
        expect(selectUpsellView(flags(true, false, false))).toBe('sales');
    });
});

describe("shouldAutoClose", () => {
    it("stänger för återvändande Pro-kund utan betalförsök", () => {
        expect(shouldAutoClose({ ...flags(true, false, false), isOpen: true })).toBe(true);
    });

    it("stänger inte mitt i ett firande", () => {
        expect(shouldAutoClose({ ...flags(true, true, false), isOpen: true })).toBe(false);
    });

    it("gör ingenting när modalen är stängd", () => {
        expect(shouldAutoClose({ ...flags(true, false, false), isOpen: false })).toBe(false);
    });

    it("stänger aldrig för en kund utan Pro", () => {
        for (const [f] of ALL) {
            if (!f.isPro) expect(shouldAutoClose({ ...f, isOpen: true })).toBe(false);
        }
    });
});

describe("shouldCelebrate", () => {
    it("firar en gång när betalningen bekräftats", () => {
        expect(shouldCelebrate({ ...flags(true, true, false), alreadyCelebrated: false })).toBe(true);
    });

    // Utan spärren fyrar varje omrendering av SplitView en ny toast och skjuter
    // stängningen framför sig, eftersom paymentAttempted inte självslocknar.
    it("firar inte om det redan skett", () => {
        expect(shouldCelebrate({ ...flags(true, true, false), alreadyCelebrated: true })).toBe(false);
    });

    it("firar inte för den som fick Pro utan att betala i appen", () => {
        expect(shouldCelebrate({ ...flags(true, false, false), alreadyCelebrated: false })).toBe(false);
    });

    it("firar inte innan servern bekräftat", () => {
        expect(shouldCelebrate({ ...flags(false, true, true), alreadyCelebrated: false })).toBe(false);
    });
});

// ─── Gratiskvoterna: kvotraden och vägen till ett gratiskonto ─────────────────────

const ALL_SOURCES: UpsellSource[] = [
    'slow_hint', 'locked_panel', 'mode_pill', 'analysis', 'analysis_402', 'retranscribe',
    'identify_speakers', 'identify_speakers_402', 'export',
    'quota_protocol', 'quota_template', 'free_account', 'quota_export',
];
/** Källorna med ett gratisval: kvotraderna och "konto först" (protokoll och export). */
const FREE_PATH = (s: UpsellSource) => s.startsWith('quota_') || s === 'free_account' || s === 'export';

describe("fönstrets val med kvotrad", () => {
    // Vy och rad tillsammans, för gratiskontot. Tabellen är det fönstret faktiskt visar.
    const CASES: Array<[string, UpsellSource, { used: number; limit: number } | null, UpsellView, string | null]> = [
        ["kvoten slut", 'quota_protocol', { used: 3, limit: 3 }, 'sales',
            "Du har använt 3 av 3 AI-protokoll den här månaden. Pro ger obegränsat."],
        ["kvoten slut, räknaren okänd", 'quota_protocol', null, 'sales',
            "Du har använt månadens AI-protokoll. Pro ger obegränsat."],
        ["mall utöver standard", 'quota_template', null, 'sales',
            "Protokollmallar utöver standardmallen ingår i Pro."],
        ["utloggad vill skapa protokoll", 'free_account', null, 'sales',
            "AI-protokoll kräver ett konto. Med ett gratiskonto får du 3 i månaden."],
        ["utloggad vill exportera", 'export', null, 'sales',
            "Export kräver ett konto. Med ett gratiskonto får du 10 exporter i månaden."],
        ["exporterna slut", 'quota_export', { used: 10, limit: 10 }, 'sales',
            "Du har använt 10 av 10 exporter den här månaden. Pro ger obegränsat."],
        ["exporterna slut, räknaren okänd", 'quota_export', null, 'sales',
            "Du har använt månadens exporter. Pro ger obegränsat."],
        ["låst panel", 'locked_panel', null, 'sales', null],
    ];
    it.each(CASES)("%s", (_, source, quota, view, line) => {
        expect(selectUpsellView(flags(false, false, false))).toBe(view);
        expect(quotaLine({ source, isPro: false, quota })).toBe(line);
    });

    it("Pro ser aldrig kvotraden, från någon källa", () => {
        for (const source of ALL_SOURCES) {
            expect(quotaLine({ source, isPro: true, quota: { used: 3, limit: 3 } })).toBeNull();
        }
    });
});

describe("klick på Skapa protokoll", () => {
    const click = (isSignedIn: boolean, isPro: boolean, remaining: number | null) =>
        upsellForProtocolGate(entitlementGate("protocol", {
            isSignedIn, isPro,
            counter: remaining === null ? null : { limit: 3, used: 3 - remaining, remaining },
        }));

    it("gratis med protokoll kvar öppnar inte fönstret", () => {
        expect(click(true, false, 3)).toBeNull();
        expect(click(true, false, 1)).toBeNull();
        expect(click(true, false, null)).toBeNull();
    });

    it("Pro öppnar aldrig fönstret", () => {
        for (const r of [null, 0, 1, 3]) expect(click(true, true, r)).toBeNull();
    });

    it("gratis på noll → kvotraden", () => {
        expect(click(true, false, 0)).toBe('quota_protocol');
    });

    it("utloggad → konto först, oavsett gammal räknare", () => {
        expect(click(false, false, null)).toBe('free_account');
        expect(click(false, false, 2)).toBe('free_account');
    });
});

describe("shouldCloseAfterSignIn", () => {
    const base = { isOpen: true, signedInAtOpen: false, isSignedIn: true, pendingUpgrade: false };

    it("stänger efter inloggning utan köp från gratiskontots källor", () => {
        for (const source of ['free_account', 'quota_protocol', 'quota_template', 'export', 'quota_export'] as UpsellSource[]) {
            expect(shouldCloseAfterSignIn({ ...base, source })).toBe(true);
        }
    });

    it("stänger inte när köpet valts — betalningen ska fortsätta", () => {
        expect(shouldCloseAfterSignIn({ ...base, source: 'free_account', pendingUpgrade: true })).toBe(false);
    });

    it("stänger inte för den som redan var inloggad, eller innan inloggningen landat", () => {
        expect(shouldCloseAfterSignIn({ ...base, source: 'quota_protocol', signedInAtOpen: true })).toBe(false);
        expect(shouldCloseAfterSignIn({ ...base, source: 'free_account', isSignedIn: false })).toBe(false);
        expect(shouldCloseAfterSignIn({ ...base, source: 'free_account', isOpen: false })).toBe(false);
    });

    it("stänger inte från Pro-källorna (där är köpet hela poängen)", () => {
        for (const source of ALL_SOURCES.filter(s => !FREE_PATH(s))) {
            expect(shouldCloseAfterSignIn({ ...base, source })).toBe(false);
        }
    });
});

describe("gratisvalet bredvid Pro", () => {
    const q = { used: 3, limit: 3, resets_at: "2026-11-01" };

    it("utloggad: konto först, och meningen säger att det inte kostar något", () => {
        expect(freeChoice({ source: 'free_account', isPro: false, isSignedIn: false, quota: null }))
            .toEqual({ label: "Skapa gratiskonto / logga in", caption: FREE_ACCOUNT_CAPTION, action: 'sign_in' });
        expect(FREE_ACCOUNT_CAPTION).toMatch(/kostar ingenting/);
        expect(FREE_ACCOUNT_CAPTION).toMatch(/inget betalkort/);
    });

    it("kvoten slut: fortsätt gratis, med dagen då nya protokoll kommer", () => {
        expect(freeChoice({ source: 'quota_protocol', isPro: false, isSignedIn: true, quota: q }))
            .toEqual({ label: "Fortsätt med gratiskontot", caption: "Nya AI-protokoll den 1 november. Gratiskontot kostar ingenting.", action: 'close' });
    });

    it("exporterna slut: fortsätt gratis, med dagen då nya exporter kommer", () => {
        expect(freeChoice({ source: 'quota_export', isPro: false, isSignedIn: true, quota: { used: 10, limit: 10, resets_at: "2026-11-01" } }))
            .toEqual({ label: "Fortsätt med gratiskontot", caption: "Nya exporter den 1 november. Gratiskontot kostar ingenting.", action: 'close' });
    });

    it("utloggad export: konto först", () => {
        expect(freeChoice({ source: 'export', isPro: false, isSignedIn: false, quota: null }))
            .toEqual({ label: "Skapa gratiskonto / logga in", caption: FREE_ACCOUNT_CAPTION, action: 'sign_in' });
    });

    it("Pro och Pro-källorna får inget gratisval", () => {
        expect(freeChoice({ source: 'quota_protocol', isPro: true, isSignedIn: true, quota: q })).toBeNull();
        for (const source of ALL_SOURCES.filter(s => !FREE_PATH(s))) {
            expect(freeChoice({ source, isPro: false, isSignedIn: false, quota: null })).toBeNull();
        }
    });

    it("fönstret säger inte längre att inspelning saknar konto (det står på webben)", () => {
        for (const source of ALL_SOURCES) {
            const line = quotaLine({ source, isPro: false, quota: q }) ?? "";
            expect(line).not.toMatch(/kräver aldrig konto/);
        }
    });

    it("resetDay", () => {
        expect(resetDay("2026-11-01")).toBe("1 november");
        expect(resetDay("2027-01-01")).toBe("1 januari");
        expect(resetDay(null)).toBeNull();
        expect(resetDay("nonsens")).toBeNull();
    });
});

describe("Pro-listan i fönstret", () => {
    const all = [...PRO_ROWS, PRO_FOOTNOTE].join("\n");

    it("inga påståenden som inte går att belägga", () => {
        expect(all).not.toMatch(/marknadens bästa/i);          // superlativ utan mätning
        expect(all).not.toMatch(/EU-servrar i Sverige/);         // driften ligger i Finland
        expect(all).toMatch(/Word, Markdown, text och PDF/);       // exportformaten som finns
    });

    it("molnmodellen beskrivs som ett val", () => {
        expect(PRO_ROWS[0]).toMatch(/när du vill/);
    });
});

describe("rubriken och mallens gratisval", () => {
    it("gratisvalens källor får neutrala rubriker, Pro-källorna säljrubriken", () => {
        expect(upsellHeading({ source: 'free_account', isSignedIn: false })).toBe("Skapa protokoll med ett konto");
        expect(upsellHeading({ source: 'quota_protocol', isSignedIn: true })).not.toMatch(/Uppgradera/);
        expect(upsellHeading({ source: 'quota_template', isSignedIn: true })).not.toMatch(/Uppgradera/);
        expect(upsellHeading({ source: 'export', isSignedIn: true })).toBe("Uppgradera till Sagt Pro");
        expect(upsellHeading({ source: 'export', isSignedIn: false })).toBe("Exportera med ett konto");
        expect(upsellHeading({ source: 'quota_export', isSignedIn: true })).toBe("Månadens exporter är använda");
    });

    it("mallen: fortsätt gratis med standardmallen", () => {
        expect(freeChoice({ source: 'quota_template', isPro: false, isSignedIn: true, quota: null }))
            .toEqual({ label: "Fortsätt med gratiskontot", caption: "Standardmallen ingår i gratiskontot och kostar ingenting.", action: 'close' });
    });

    it("resetDay avvisar omöjliga dagar", () => {
        expect(resetDay("2026-11-00")).toBeNull();
        expect(resetDay("2026-11-45")).toBeNull();
    });
});
