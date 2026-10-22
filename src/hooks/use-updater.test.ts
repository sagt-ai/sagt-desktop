import { describe, it, expect, vi, beforeEach } from "vitest"

const toast = vi.hoisted(() => ({ warning: vi.fn(), loading: vi.fn(), error: vi.fn() }))
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), toast) }))
vi.mock("@/lib/session-busy-app", () => ({ appSessionBusy: vi.fn(async () => false) }))
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn(async () => {}) }))

import { runUpdate } from "./use-updater"
import type { Update } from "@tauri-apps/plugin-updater"

const fakeUpdate = () => {
    const downloadAndInstall = vi.fn(async () => {})
    return { update: { version: "9.9.9", downloadAndInstall } as unknown as Update, downloadAndInstall }
}

describe("runUpdate (uppdaterarens spärr)", () => {
    beforeEach(() => vi.clearAllMocks())

    it("installerar inte medan en inspelning sparas eller transkriberas", async () => {
        const { update, downloadAndInstall } = fakeUpdate()
        await runUpdate(update, async () => true)
        expect(downloadAndInstall).not.toHaveBeenCalled()
        expect(toast.warning).toHaveBeenCalledTimes(1)
    })

    it("installerar när inget är på väg, och spärren släpper efter ett nej", async () => {
        const { update, downloadAndInstall } = fakeUpdate()
        await runUpdate(update, async () => true)
        await runUpdate(update, async () => false)
        expect(downloadAndInstall).toHaveBeenCalledTimes(1)
    })
})
