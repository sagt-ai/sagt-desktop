import { describe, expect, it, vi } from "vitest";
import { settleRemovedRecording } from "./recording-removed";

function deps(isRecording: boolean) {
    return {
        isRecording,
        markSaved: vi.fn(),
        setIsProcessing: vi.fn(),
        setUploadStatus: vi.fn(),
    };
}

describe("inspelning raderad medan den transkriberades", () => {
    it("släpper bearbetningsläget och markören", () => {
        const d = deps(false);
        settleRemovedRecording("C:/rec/session_1.wav", d);
        expect(d.markSaved).toHaveBeenCalledWith("C:/rec/session_1.wav");
        expect(d.setIsProcessing).toHaveBeenCalledWith(false);
        expect(d.setUploadStatus).toHaveBeenCalledWith("idle");
    });

    it("rör inte en ny inspelning som redan startat", () => {
        const d = deps(true);
        settleRemovedRecording("C:/rec/session_1.wav", d);
        expect(d.markSaved).toHaveBeenCalledWith("C:/rec/session_1.wav");
        expect(d.setIsProcessing).not.toHaveBeenCalled();
        expect(d.setUploadStatus).not.toHaveBeenCalled();
    });
});
