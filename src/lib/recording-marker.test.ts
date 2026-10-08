import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/hooks/use-posthog-events", () => ({ captureEvent: vi.fn() }));

import { createRecordingMarker, startTimeFromPath, MARKER_KEY, HEARTBEAT_MS } from "./recording-marker";

function memoryStorage() {
    const data = new Map<string, string>();
    return {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => { data.set(k, v); },
        removeItem: (k: string) => { data.delete(k); },
        data,
    };
}

const throwingStorage = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("blocked"); },
    removeItem: () => { throw new Error("blocked"); },
};

let clock = 0;
let storage = memoryStorage();
let capture = vi.fn();

/** En körning av appen. En ny körning över samma lagring motsvarar en omstart. */
function run(runId: string, version = "1.0.0") {
    return createRecordingMarker({
        storage: () => storage,
        now: () => clock,
        capture,
        version,
        runId,
    });
}

/** Filen appen skriver för en inspelning som startade vid `ms`, som i en sparad inspelning. */
function sessionFile(ms: number, offsetMs = 85) {
    return `C:\\Users\\anna\\AppData\\Roaming\\com.sagt.ai\\recordings\\session_${(ms + offsetMs) * 1000 + 417}.wav`;
}

/** Startar en inspelning och returnerar filen den sparas i. */
function begin(m: ReturnType<typeof run>) {
    m.started();
    return sessionFile(clock);
}

beforeEach(() => {
    clock = 1_000_000;
    storage = memoryStorage();
    capture = vi.fn();
});

describe("markören för en pågående inspelning", () => {
    it("sparad inspelning: inget event, och inget vid nästa start", () => {
        const m = run("a");
        const file = begin(m);
        clock += 5 * 60_000;
        m.stopped();
        m.saved(file);
        m.reportLeftover();
        run("b").reportLeftover();

        expect(capture).not.toHaveBeenCalled();
        expect(storage.data.has(MARKER_KEY)).toBe(false);
    });

    it("avbruten inspelning: bara recording_cancelled, med längden fram till Stopp", () => {
        const m = run("a");
        m.started();
        clock += 90_000;
        m.stopped();
        clock += 30_000; // väntan på transkriberingen innan Avbryt
        m.cancelled();
        run("b").reportLeftover();

        expect(capture).toHaveBeenCalledTimes(1);
        expect(capture).toHaveBeenCalledWith("recording_cancelled", { duration_seconds: 90 });
    });

    it("Avbryt två gånger skickar ett event", () => {
        const m = run("a");
        m.started();
        clock += 60_000;
        m.stopped();
        m.cancelled();
        m.cancelled();

        expect(capture).toHaveBeenCalledTimes(1);
    });

    it("inspelning som sparas trots Avbryt: recording_saved_after_cancel, och inget vid nästa start", () => {
        const m = run("a");
        const file = begin(m);
        clock += 60_000;
        m.stopped();
        m.cancelled();
        m.saved(file);
        run("b").reportLeftover();

        expect(capture.mock.calls).toEqual([
            ["recording_cancelled", { duration_seconds: 60 }],
            ["recording_saved_after_cancel", { duration_seconds: 60 }],
        ]);
    });

    it("Avbryt efter att inspelningen sparats räknas inte som avbruten", () => {
        const m = run("a");
        const file = begin(m);
        clock += 60_000;
        m.stopped();
        m.saved(file);
        m.cancelled();

        expect(capture).not.toHaveBeenCalled();
    });

    it("app stängd mitt i inspelningen: recording_unsaved en gång, längd till senaste hjärtslaget", () => {
        const m = run("a", "0.9.0");
        m.started();
        for (let i = 0; i < 45; i++) {
            clock += HEARTBEAT_MS;
            m.heartbeat();
        }
        clock += 40_000; // stängd mellan två hjärtslag

        clock += 120 * 60_000; // appen startas två timmar senare
        const next = run("b", "1.0.0");
        next.reportLeftover();
        next.reportLeftover();
        next.started();

        expect(capture).toHaveBeenCalledTimes(1);
        expect(capture).toHaveBeenCalledWith("recording_unsaved", {
            duration_seconds: 45 * 60,
            minutes_since: 121,
            app_version_at_start: "0.9.0",
            previous_run: true,
        });
    });

    it("app stängd efter Stopp men innan inspelningen sparats: recording_unsaved med längden fram till Stopp", () => {
        const m = run("a");
        m.started();
        clock += 30 * 60_000;
        m.heartbeat();
        clock += 20_000;
        m.stopped();
        clock += 5 * 60_000; // transkriberingen pågår när appen stängs

        run("b").reportLeftover();

        expect(capture).toHaveBeenCalledTimes(1);
        expect(capture).toHaveBeenCalledWith("recording_unsaved", expect.objectContaining({
            duration_seconds: 30 * 60 + 20,
            minutes_since: 5,
        }));
    });

    it("ny start skickar eventet för en kvarlämnad markör innan den skrivs över", () => {
        const m = run("a");
        m.started();
        clock += 2 * 60_000;
        m.heartbeat();

        const next = run("b");
        const file = begin(next); // posthogs start-rapport har inte hunnit köras
        clock += 60_000;
        next.stopped();
        next.saved(file);

        expect(capture).toHaveBeenCalledTimes(1);
        expect(capture).toHaveBeenCalledWith("recording_unsaved", expect.objectContaining({
            duration_seconds: 120,
            previous_run: true,
        }));
    });

    it("start innan förra inspelningen hunnit sparas i samma körning märks previous_run: false", () => {
        const m = run("a");
        m.started();
        clock += 60_000;
        m.stopped();
        m.started();

        expect(capture).toHaveBeenCalledWith("recording_unsaved", expect.objectContaining({
            duration_seconds: 60,
            previous_run: false,
        }));
    });

    it("lagring som kastar: inget kastas vidare och inget event skickas", () => {
        const m = createRecordingMarker({
            storage: () => throwingStorage,
            now: () => clock,
            capture,
            version: "1.0.0",
            runId: "a",
        });
        expect(() => {
            m.reportLeftover();
            m.started();
            m.heartbeat();
            m.stopped();
            m.cancelled();
            m.saved(sessionFile(clock));
        }).not.toThrow();
        expect(capture).not.toHaveBeenCalled();
    });

    it("lagring som inte går att nå alls: inget kastas vidare och inget event skickas", () => {
        const m = createRecordingMarker({
            storage: () => { throw new Error("no storage"); },
            now: () => clock,
            capture,
            version: "1.0.0",
            runId: "a",
        });
        expect(() => { m.reportLeftover(); m.started(); m.stopped(); m.cancelled(); }).not.toThrow();
        expect(capture).not.toHaveBeenCalled();
    });

    it("markör som går att läsa men inte ta bort rapporteras inte vid varje start", () => {
        run("a").started();
        clock += 60_000;
        const stuck = { ...storage, removeItem: () => { throw new Error("blocked"); } };
        for (const id of ["b", "c"]) {
            createRecordingMarker({ storage: () => stuck, now: () => clock, capture, version: "1.0.0", runId: id })
                .reportLeftover();
        }
        expect(capture).not.toHaveBeenCalled();
    });

    it("sen sparning av en äldre inspelning tar inte bort den nyas markör", () => {
        const m = run("a");
        const fileA = begin(m);
        clock += 3_000;
        m.stopped();
        clock += 4_000; // B startas innan A hunnit sparas
        m.started();
        clock += 60_000;
        m.stopped();
        m.saved(fileA); // A sparas efter att B stoppats
        capture.mockClear();

        run("b").reportLeftover(); // B sparades aldrig

        expect(capture).toHaveBeenCalledTimes(1);
        expect(capture).toHaveBeenCalledWith("recording_unsaved", expect.objectContaining({
            duration_seconds: 60,
            previous_run: true,
        }));
    });

    it("okänt filnamn tar inte bort markören", () => {
        const m = run("a");
        m.started();
        m.stopped();
        m.saved("C:\\recordings\\recording.wav");
        run("b").reportLeftover();
        expect(capture).toHaveBeenCalledWith("recording_unsaved", expect.anything());
    });

    it("läser starttiden ur filnamnet på Windows och macOS", () => {
        expect(startTimeFromPath("C:\\x\\recordings\\session_1790564995198261.wav")).toBe(1790564995198.261);
        expect(startTimeFromPath("/Users/a/Library/Application Support/com.sagt.ai/recordings/session_1790564995198261.wav"))
            .toBe(1790564995198.261);
        expect(startTimeFromPath("/tmp/meeting_1790564995198261.wav")).toBeNull();
        expect(startTimeFromPath("")).toBeNull();
    });

    it("trasig markör i lagringen skickar inget", () => {
        storage.setItem(MARKER_KEY, "{inte json");
        run("b").reportLeftover();
        expect(capture).not.toHaveBeenCalled();
    });
});
