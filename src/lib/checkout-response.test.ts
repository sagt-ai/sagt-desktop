import { describe, expect, it } from "vitest";
import { interpretCheckoutResponse } from "./checkout-response";

describe("interpretCheckoutResponse", () => {
    it("öppnar en https-URL från ett lyckat svar", () => {
        const url = "https://checkout.stripe.com/c/pay/cs_test_1#fid%2Fabc";
        expect(interpretCheckoutResponse(200, { url })).toEqual({ ok: true, url });
    });

    it("gör ett lyckat svar utan giltig URL till ett synligt fel", () => {
        for (const body of [{}, null, { url: 42 }, { url: "" }, { url: "javascript:alert(1)" }, { url: "http://checkout.stripe.com" }]) {
            const outcome = interpretCheckoutResponse(200, body);
            expect(outcome.ok, JSON.stringify(body)).toBe(false);
        }
    });

    it("visar serverns förklaring — 409 betyder att köpet redan finns", () => {
        const detail = "Du har redan en prenumeration.";
        expect(interpretCheckoutResponse(409, { detail })).toEqual({ ok: false, code: "unknown", message: detail });
    });

    it("visar aldrig en detail-lista som [object Object]", () => {
        const outcome = interpretCheckoutResponse(422, { detail: [{ loc: ["body"], msg: "fel" }] });
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.message).not.toContain("object");
    });

    it("ersätter backendens engelska 401-text med en svensk uppmaning", () => {
        const outcome = interpretCheckoutResponse(401, { detail: "Token has expired" });
        expect(outcome).toMatchObject({ ok: false, code: "unauthorized" });
        if (!outcome.ok) expect(outcome.message).not.toContain("Token");
    });

    it("visar inte FastAPI:s engelska 404 när backenden saknar endpointen", () => {
        const outcome = interpretCheckoutResponse(404, { detail: "Not Found" });
        expect(outcome.ok).toBe(false);
        if (!outcome.ok) expect(outcome.message).not.toContain("Not Found");
    });

    it("skiljer ej konfigurerad (503) från serverfel och tomt svar", () => {
        expect(interpretCheckoutResponse(503, { detail: "Betalningen är inte tillgänglig." })).toMatchObject({ code: "unavailable" });
        expect(interpretCheckoutResponse(502, null)).toMatchObject({ code: "server_error" });
    });
});
