import { describe, it, expect } from "vitest";
import { LevelStats, MIC_RECOVERED_LEVEL, MIC_SILENT_AFTER_MS, MIC_SILENT_LEVEL, MicSilenceDetector } from "./mic-silence";

/** Matar detektorn med 20 värden i sekunden från t=0 till `ms`. Returnerar händelserna. */
function feed(d: MicSilenceDetector, ms: number, mic: (t: number) => number, sys = 0.2, from = 0) {
    const events: { t: number; e: string }[] = [];
    for (let t = from; t <= ms; t += 50) {
        const e = d.sample(mic(t), sys, t);
        if (e) events.push({ t, e });
    }
    return events;
}

describe("varningen för en mikrofon som inget hör", () => {
    it("varnar en gång efter 60 s när mikrofonen är så gott som tyst", () => {
        const d = new MicSilenceDetector(0);
        const events = feed(d, 120_000, () => 0.0002);
        expect(events).toEqual([{ t: MIC_SILENT_AFTER_MS, e: "warn" }]);
    });

    it("varnar när mikrofonen inte ger något alls (behörighet saknas)", () => {
        const d = new MicSilenceDetector(0);
        expect(feed(d, 70_000, () => 0)).toEqual([{ t: MIC_SILENT_AFTER_MS, e: "warn" }]);
    });

    it("en tyst lyssnare med brusspärr varnas inte efter 45 s (varnades före 2026-10-14)", () => {
        const d = new MicSilenceDetector(0);
        expect(feed(d, 45_000, () => 0)).toEqual([]);
    });

    it("varnar inte före 60 s", () => {
        const d = new MicSilenceDetector(0);
        expect(feed(d, MIC_SILENT_AFTER_MS - 50, () => 0)).toEqual([]);
    });

    it("en tyst lyssnare i ett tyst rum varnas inte: ett enda litet ljud räcker", () => {
        // Användaren säger inget, men mikrofonen fångar en stol eller en andning.
        const d = new MicSilenceDetector(0);
        expect(feed(d, 120_000, t => (t === 12_000 ? 0.003 : 0.0004))).toEqual([]);
    });

    it("en vanlig mikrofon med tal varnas aldrig", () => {
        const d = new MicSilenceDetector(0);
        expect(feed(d, 120_000, t => (t % 4000 < 2000 ? 0.3 : 0.002))).toEqual([]);
    });

    it("gränsen: precis under varnar, på gränsen varnar inte", () => {
        const under = new MicSilenceDetector(0);
        expect(feed(under, 61_000, () => MIC_SILENT_LEVEL * 0.99).map(e => e.e)).toEqual(["warn"]);
        const at = new MicSilenceDetector(0);
        expect(feed(at, 61_000, () => MIC_SILENT_LEVEL)).toEqual([]);
    });

    it("släcks en gång när mikrofonen börjar höras", () => {
        const d = new MicSilenceDetector(0);
        const events = feed(d, 90_000, t => (t >= 75_000 ? 0.05 : 0.0001));
        expect(events).toEqual([{ t: MIC_SILENT_AFTER_MS, e: "warn" }, { t: 75_000, e: "recovered" }]);
    });

    it("en nivå strax över varningsgränsen släcker inte (hysteres)", () => {
        const d = new MicSilenceDetector(0);
        const events = feed(d, 90_000, t => (t >= 75_000 ? MIC_RECOVERED_LEVEL : 0.0001));
        expect(events.map(e => e.e)).toEqual(["warn"]);
    });

    it("sammanfattningen bär nivåerna per kanal och om varningen visades", () => {
        const d = new MicSilenceDetector(0);
        feed(d, 70_000, () => 0.0002, 0.3);
        const s = d.summary(70_000);
        expect(s.seconds).toBe(70);
        expect(s.samples).toBe(1401);
        expect(s.mic_silent_warned).toBe(true);
        expect(s.mic_recovered).toBe(false);
        expect(s.mic_max).toBeCloseTo(0.0002, 6);
        expect(s.sys_max).toBeCloseTo(0.3, 6);
        // Percentilen är facket ovanför värdet: nära, aldrig över maximum.
        expect(s.mic_p50).toBeLessThanOrEqual(s.mic_max);
        expect(s.mic_p50).toBeGreaterThan(0.00015);
    });
});

describe("nivåfördelningen", () => {
    it("percentilerna hamnar i rätt storleksordning", () => {
        const st = new LevelStats();
        for (let i = 0; i < 90; i++) st.add(0.001);
        for (let i = 0; i < 10; i++) st.add(0.3);
        expect(st.quantile(0.5)).toBeGreaterThan(0.0009);
        expect(st.quantile(0.5)).toBeLessThan(0.0013);
        expect(st.quantile(0.95)).toBeGreaterThan(0.25);
        expect(st.quantile(0.95)).toBeLessThanOrEqual(0.3);
    });

    it("tom fördelning, noll och ogiltiga värden", () => {
        const st = new LevelStats();
        expect(st.quantile(0.5)).toBe(0);
        st.add(0);
        st.add(Number.NaN);
        st.add(-1);
        expect(st.count).toBe(1);
        expect(st.quantile(0.5)).toBe(0);
    });
});
