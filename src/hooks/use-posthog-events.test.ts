import { describe, it, expect, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
vi.mock("posthog-js", () => ({ default: { capture: vi.fn() } }));
vi.mock("@/lib/feedback-runtime", () => ({ markErrorSeen: vi.fn() }));

import { toast } from "sonner";
import { showError } from "./use-posthog-events";

describe("showError", () => {
    it("visar felet utan serverns felkod", () => {
        showError("unavailable", "Talaridentifiering misslyckades: Talaridentifieringen är tillfälligt otillgänglig. (llm_upstream)");

        expect(toast.error).toHaveBeenCalledWith(
            "Talaridentifiering misslyckades: Talaridentifieringen är tillfälligt otillgänglig.",
            undefined,
        );
    });
});
