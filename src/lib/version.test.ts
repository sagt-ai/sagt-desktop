import { describe, expect, it } from "vitest"
import { buildChannel } from "./version"

describe("byggkanalen", () => {
    it("CI:s värden går igenom", () => {
        expect(buildChannel(false, "release")).toBe("release")
        expect(buildChannel(false, "test")).toBe("test")
    })
    it("lokalt produktionsbygge utan variabel räknas som dev", () => {
        expect(buildChannel(false, undefined)).toBe("dev")
    })
    it("okända värden räknas som dev, aldrig som release", () => {
        expect(buildChannel(false, "Release")).toBe("dev")
        expect(buildChannel(false, "")).toBe("dev")
    })
    it("dev-servern är alltid dev", () => {
        expect(buildChannel(true, "release")).toBe("dev")
    })
})
