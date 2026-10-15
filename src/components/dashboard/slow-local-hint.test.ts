import { describe, expect, it } from "vitest";
import { elapsedText, meetingLengthText } from "./slow-local-hint";

describe("tidstexterna i långsamhetskortet", () => {
    it("mötets längd i minuter, under en minut i sekunder", () => {
        expect(meetingLengthText(3761)).toBe("63 minuter");
        expect(meetingLengthText(60)).toBe("1 minut");
        expect(meetingLengthText(89)).toBe("1 minut");
        expect(meetingLengthText(90)).toBe("2 minuter");
        expect(meetingLengthText(45)).toBe("45 sekunder");
        expect(meetingLengthText(1)).toBe("1 sekund");
    });
    it("tiden sedan Stopp i minuter och sekunder", () => {
        expect(elapsedText(130)).toBe("2 min 10 s");
        expect(elapsedText(120)).toBe("2 min");
        expect(elapsedText(45)).toBe("45 s");
        expect(elapsedText(0)).toBe("0 s");
    });
});
