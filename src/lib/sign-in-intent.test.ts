import { describe, it, expect } from "vitest";
import { clearSignInIntent, consumeSignInIntent, setSignInIntent, SIGN_IN_INTENT_TTL_MS } from "./sign-in-intent";

describe("sign-in-intent", () => {
    it("läses en gång", () => {
        setSignInIntent("free", "free_account", 1000);
        expect(consumeSignInIntent(2000)).toEqual({ intent: "free", source: "free_account" });
        expect(consumeSignInIntent(2000)).toBeNull();
    });

    it("en gammal avsikt räknas inte på en senare inloggning", () => {
        setSignInIntent("upgrade", "quota_protocol", 0);
        expect(consumeSignInIntent(SIGN_IN_INTENT_TTL_MS + 1)).toBeNull();
    });

    it("töms när inloggningen inte hade någon avsikt", () => {
        setSignInIntent("upgrade", "export", 0);
        clearSignInIntent();
        expect(consumeSignInIntent(1)).toBeNull();
    });
});
