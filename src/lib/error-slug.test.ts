import { describe, it, expect } from "vitest";
import { errorSlug, withoutErrorCode } from "./error-slug";
import { analyzeErrorFrom } from "./entitlements";

describe("errorSlug", () => {
    it("402 med code quota_exhausted → quota_exhausted, inte not_pro", () => {
        const e = analyzeErrorFrom(402, null, JSON.stringify({
            detail: "Du har använt 3 av 3 AI-protokoll den här månaden.",
            code: "quota_exhausted", kind: "protocol", limit: 3, used: 3, resets_at: "2026-11-01",
        }));
        expect(errorSlug(e)).toBe("quota_exhausted");
        // Samma text utan felobjektet faller inte in i kvotslugen av misstag.
        expect(errorSlug(new Error(e.message))).toBe("not_pro");
    });

    it("mappar 401-prefix → unauthorized", () => {
        expect(errorSlug(new Error("Unauthorized: token invalid"))).toBe("unauthorized");
        expect(errorSlug(new Error("Din session är inte längre giltig."))).toBe("unauthorized");
    });

    it("mappar 402-innehåll → not_pro", () => {
        expect(errorSlug(new Error("Payment Required: Denna funktion kräver Pro."))).toBe("not_pro");
        expect(errorSlug(new Error("Molntranskribering kräver aktiv Pro-prenumeration."))).toBe("not_pro");
    });

    it("mappar 413-prefix → file_too_large", () => {
        expect(errorSlug(new Error("För stort: filen överskrider gränsen"))).toBe("file_too_large");
    });

    // KRITISKT: uploadJob kastar timspärrens 429 som generisk sträng UTAN prefix — måste ändå
    // klassas via innehållet (annars missas exakt det fel Daniel fick vid omtranskribering).
    it("mappar timspärr (Hastighetsgräns) → rate_limited", () => {
        expect(errorSlug(new Error("Kunde inte ladda upp: Hastighetsgräns nådd: max 10 uppladdningar per timme."))).toBe("rate_limited");
    });

    // Månadskvot är en annan situation (uppgradera, inte vänta) → egen slug.
    it("mappar månadskvot (Quota/Månadsgräns) → quota_exceeded", () => {
        expect(errorSlug(new Error("Quota: månadsgränsen nådd"))).toBe("quota_exceeded");
        expect(errorSlug(new Error("Månadsgränsen för molntranskribering är nådd."))).toBe("quota_exceeded");
    });

    it("mappar 503-prefix → unavailable", () => {
        expect(errorSlug(new Error("Otillgänglig: tjänsten är nere"))).toBe("unavailable");
    });

    it("mappar offline/nätverk → offline", () => {
        expect(errorSlug(new Error("Denna funktion kräver internetanslutning."))).toBe("offline");
    });

    it("mappar raderad ljudfil → audio_deleted", () => {
        expect(errorSlug(new Error("Ljudfilen är raderad — molnsynk kräver ljudet."))).toBe("audio_deleted");
    });

    it("okänt fel → unknown", () => {
        expect(errorSlug(new Error("Något helt oväntat inträffade"))).toBe("unknown");
        expect(errorSlug(undefined)).toBe("unknown");
        expect(errorSlug("en naken sträng")).toBe("unknown");
    });
});

describe("withoutErrorCode", () => {
    it("tar bort serverns felkod sist i texten", () => {
        expect(withoutErrorCode("Talaridentifiering misslyckades: Talaridentifieringen är tillfälligt otillgänglig. (llm_upstream)"))
            .toBe("Talaridentifiering misslyckades: Talaridentifieringen är tillfälligt otillgänglig.");
        expect(withoutErrorCode("AI-analysen är tillfälligt otillgänglig. Försök igen om en stund. (llm_invalid_response)"))
            .toBe("AI-analysen är tillfälligt otillgänglig. Försök igen om en stund.");
    });

    it("lämnar vanliga parenteser och text utan kod orörda", () => {
        expect(withoutErrorCode("Uppladdning misslyckades (försök igen)")).toBe("Uppladdning misslyckades (försök igen)");
        expect(withoutErrorCode("Filen är för stor (max 500 MB)")).toBe("Filen är för stor (max 500 MB)");
        expect(withoutErrorCode("Okänt fel")).toBe("Okänt fel");
    });
});
