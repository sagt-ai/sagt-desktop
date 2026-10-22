import { describe, expect, it } from "vitest";
import { createChunkGate } from "./chunk-gate";

describe("spärren för lokal text efter Avbryt", () => {
    it("släpper igenom allt innan Avbryt", () => {
        const gate = createChunkGate();
        expect(gate.accept(0)).toBe(true);
        expect(gate.accept(3)).toBe(true);
    });

    it("kastar varje rad mellan klicket och svaret", () => {
        const gate = createChunkGate();
        gate.beginCancel();
        expect(gate.accept(3)).toBe(false);
        expect(gate.accept(undefined)).toBe(false);
    });

    it("kastar rader från den avbrutna generationen även efter svaret", () => {
        const gate = createChunkGate();
        gate.beginCancel();
        gate.finishCancel(4);
        expect(gate.accept(3)).toBe(false);
    });

    it("släpper igenom den nya inspelningens rader", () => {
        const gate = createChunkGate();
        gate.beginCancel();
        gate.finishCancel(4);
        expect(gate.accept(4)).toBe(true);
        expect(gate.accept(5)).toBe(true);
    });

    it("ett misslyckat Avbryt släpper inte igenom den avbrutna körningen", () => {
        const gate = createChunkGate();
        expect(gate.accept(3)).toBe(true);
        gate.beginCancel();
        gate.finishCancel(undefined);
        expect(gate.accept(3)).toBe(false);
    });

    it("ett misslyckat Avbryt låser inte spärren för nästa inspelning", () => {
        const gate = createChunkGate();
        gate.accept(3);
        gate.beginCancel();
        gate.finishCancel(undefined);
        expect(gate.accept(4)).toBe(true);
    });

    it("ett senare Avbryt med lägre svar sänker inte golvet", () => {
        const gate = createChunkGate();
        gate.finishCancel(6);
        gate.finishCancel(2);
        expect(gate.accept(5)).toBe(false);
    });
});
