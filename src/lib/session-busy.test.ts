import { describe, it, expect, vi } from "vitest"
import { allowLeave, blockContextMenu, blockReload, isReloadShortcut, sessionBusy, uiBusy } from "./session-busy"

const idle = { isRecording: false, isProcessing: false }

describe("sessionBusy", () => {
    it("upptagen medan gränssnittet spelar in eller slutför", async () => {
        const engine = vi.fn(async () => false)
        expect(await sessionBusy({ isRecording: true, isProcessing: false }, engine)).toBe(true)
        expect(await sessionBusy({ isRecording: false, isProcessing: true }, engine)).toBe(true)
        expect(engine).not.toHaveBeenCalled()
    })

    it("upptagen när bara ljudmotorn vet om inspelningen (efter en omladdning, eller mellan Stopp och sparandet)", async () => {
        // Det fall gränssnittets tillstånd ensamt släpper igenom.
        expect(uiBusy(idle)).toBe(false)
        expect(await sessionBusy(idle, async () => true)).toBe(true)
    })

    it("upptagen när ljudmotorn inte svarar", async () => {
        expect(await sessionBusy(idle, async () => { throw new Error("ingen motor") })).toBe(true)
    })

    it("ledig bara när båda säger ledig", async () => {
        expect(await sessionBusy(idle, async () => false)).toBe(false)
    })
})

describe("allowLeave (stängvakten)", () => {
    it("frågar inte när inget är på väg", async () => {
        const confirm = vi.fn(async () => false)
        expect(await allowLeave(async () => false, confirm)).toBe(true)
        expect(confirm).not.toHaveBeenCalled()
    })

    it("stänger inte när användaren väljer att fortsätta", async () => {
        expect(await allowLeave(async () => true, async () => false)).toBe(false)
    })

    it("stänger när användaren bekräftar", async () => {
        expect(await allowLeave(async () => true, async () => true)).toBe(true)
    })

    it("stänger om dialogen inte går att visa, hellre än att låsa fönstret", async () => {
        expect(await allowLeave(async () => true, async () => { throw new Error("ingen dialog") })).toBe(true)
    })
})

describe("blockReload (omladdningsspärren)", () => {
    const key = (k: string, mods: { ctrlKey?: boolean; metaKey?: boolean } = {}) => ({
        key: k,
        ctrlKey: !!mods.ctrlKey,
        metaKey: !!mods.metaKey,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
    })

    it.each([
        ["F5", {}],
        ["r", { ctrlKey: true }],
        ["R", { ctrlKey: true }],
        ["r", { metaKey: true }],
    ])("spärrar %s %o", (k, mods) => {
        const e = key(k, mods)
        expect(blockReload(e, false)).toBe(true)
        expect(e.preventDefault).toHaveBeenCalled()
    })

    it("släpper andra tangenter, också r utan modifierare", () => {
        for (const e of [key("r"), key("F4"), key("c", { ctrlKey: true }), key("Enter")]) {
            expect(blockReload(e, false)).toBe(false)
            expect(e.preventDefault).not.toHaveBeenCalled()
        }
        expect(isReloadShortcut({ key: "r", ctrlKey: false, metaKey: false })).toBe(false)
    })

    it("släpper omladdning under utveckling", () => {
        const e = key("F5")
        expect(blockReload(e, true)).toBe(false)
        expect(e.preventDefault).not.toHaveBeenCalled()
    })
})

describe("blockContextMenu (högerklickets Uppdatera)", () => {
    const ev = () => ({ preventDefault: vi.fn() })

    it("spärrar menyn på sidan i övrigt", () => {
        const e = ev()
        expect(blockContextMenu(e, { editable: false }, false, false)).toBe(true)
        expect(e.preventDefault).toHaveBeenCalled()
    })

    it("släpper menyn i textfält, på markerad text och under utveckling", () => {
        for (const [editable, sel, dev] of [[true, false, false], [false, true, false], [false, false, true]] as const) {
            const e = ev()
            expect(blockContextMenu(e, { editable }, sel, dev)).toBe(false)
            expect(e.preventDefault).not.toHaveBeenCalled()
        }
    })
})
