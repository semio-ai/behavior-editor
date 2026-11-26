import { afterEach, describe, expect, it } from "vitest";
import { FAKE_CALLS, FakeDevice } from "../../fixtures/fake-device";
import { loadedOf } from "../../fixtures/local-arora";
import { ORDER } from "../../fixtures/examples";
import type { Value } from "../model/value";
import { RET } from "../runtime/natives";
import type { TraceReport } from "../runtime/trace";
import { advanceReplay, historyReport, replayFrom } from "../editor/use-timeline";
import { DeviceHistory, REVISION_KEY } from "./device-history";
import { DeviceSession } from "./device-session";

const FEEDBACK = "arora/tasks/m/trace/1/feedback";
const report = (r: TraceReport): Value => ({ str: JSON.stringify(r) });
const decode = (key: string, value: Value) =>
  key.endsWith("/feedback") ? (JSON.parse((value as { str: string }).str) as TraceReport) : null;
const time = (ms: number): Value => ({ u64: ms * 1e6 });

/** A history fed a trace over five steps of 10 ms. */
function fed() {
  const history = new DeviceHistory({ base: new Map([["k", { f64: 0 }]]), report: decode });
  history.record({ "arora/time": time(0), k: { f64: 1 }, [FEEDBACK]: report({ tick: 7, status: [["a", "running"], ["b", "running"]] }) });
  history.record({ "arora/time": time(10), k: { f64: 2 } });
  history.record({ "arora/time": time(20), [FEEDBACK]: report({ tick: 9, since: 7, status: [["b", "success"], ["c", "running"]] }) });
  history.record({ "arora/time": time(30), k: { f64: 2 }, s: { str: "x" } });
  history.record({ "arora/time": time(40), [FEEDBACK]: report({ tick: 11, since: 9, status: [["c", "not_reached"]] }) });
  return history;
}

describe("DeviceHistory", () => {
  it("rebuilds the store and the nodes at every step from their changes", () => {
    const history = fed();
    expect(history.length).toBe(5);
    expect(history.at(0)).toMatchObject({ time: 0, tick: 7, statuses: { a: "R", b: "R" } });
    expect(history.at(0).store.get("k")).toEqual({ f64: 1 });
    expect(history.at(1).store.get("k")).toEqual({ f64: 2 });
    expect(history.at(1).tick).toBe(8);
    expect(history.at(2).statuses).toEqual({ a: "R", b: "S", c: "R" });
    expect(history.at(3).store.get("s")).toEqual({ str: "x" });
    expect(history.at(2).store.has("s")).toBe(false);
    expect(history.at(4).statuses).toEqual({ a: "R", b: "S" });
    // The past stays as it was while the history grows.
    history.record({ "arora/time": time(50), k: { f64: 5 } });
    expect(history.at(1).store.get("k")).toEqual({ f64: 2 });
    expect(history.at(5).store.get("k")).toEqual({ f64: 5 });
  });

  it("keeps the store as it was before any push", () => {
    const history = new DeviceHistory({ base: new Map([["k", { f64: 0 }]]) });
    history.record({ "arora/time": time(0) });
    expect(history.at(0).store.get("k")).toEqual({ f64: 0 });
  });

  it("reads a clock past 2^53 ns that a bridge hands over as its digits", () => {
    const history = new DeviceHistory();
    const late = { rawJSON: "9007199254740993000" } as unknown as number;
    history.record({ "arora/time": { u64: late } });
    expect(history.time(0)).toBeCloseTo(9007199254.740993, 3);
  });

  it("folds no delta onto a report it missed, until a full report states the nodes again", () => {
    const history = fed();
    // The report of tick 13 was lost: 15's delta since it is not folded.
    history.record({ "arora/time": time(50), [FEEDBACK]: report({ tick: 15, since: 13, status: [["a", "failure"]] }) });
    expect(history.at(5).statuses).toEqual({ a: "R", b: "S" });
    history.record({ "arora/time": time(60), [FEEDBACK]: report({ tick: 17, status: [["a", "success"]] }) });
    expect(history.at(6).statuses).toEqual({ a: "S" });
  });

  it("keeps only changes: an unchanged value adds nothing", () => {
    const a = new DeviceHistory();
    const b = new DeviceHistory();
    for (let i = 0; i < 1000; i++) {
      a.record({ "arora/time": time(i * 10), k: { f64: 1 } });
      b.record({ "arora/time": time(i * 10), k: { f64: i } });
    }
    expect(a.bytes()).toBeLessThan(b.bytes());
    expect(a.at(999).store.get("k")).toEqual({ f64: 1 });
    expect(b.at(500).store.get("k")).toEqual({ f64: 500 });
  });

  it("starts the nodes anew at a trace's first report, and ignores another trace's reports", () => {
    const history = fed();
    const second = "arora/tasks/m/trace/2/feedback";
    history.record({ "arora/time": time(50), [second]: report({ tick: 20, status: [["d", "running"]] }) });
    expect(history.at(5).statuses).toEqual({ d: "R" });
    history.record({ "arora/time": time(60), [FEEDBACK]: report({ tick: 13, since: 11, status: [["a", "failure"]] }) });
    expect(history.at(6).statuses).toEqual({ d: "R" });
    expect(history.at(4).statuses).toEqual({ a: "R", b: "S" });
  });

  it("keeps the nodes' activity and return values, a restart or a full report clearing them from then on only", () => {
    const history = new DeviceHistory({ report: decode });
    const ret = (node: string, value: Value) => ({ node, port: RET, value });
    history.record({
      "arora/time": time(0),
      [FEEDBACK]: report({ tick: 1, activity: [["a", "called"], ["b", "cached"]], values: [ret("a", { f64: 1 }), ret("b", { f64: 2 })] }),
    });
    history.record({
      "arora/time": time(10),
      [FEEDBACK]: report({ tick: 2, since: 1, activity: [["a", "idle"]], values: [ret("a", { f64: 3 })] }),
    });
    // An edit restarts b; a unit return clears a's.
    history.record({
      "arora/time": time(20),
      [FEEDBACK]: report({ tick: 3, since: 2, restarted: ["b"], values: [ret("a", "unit" as unknown as Value)] }),
    });
    // A full report states only c: a and b leave the view.
    history.record({ "arora/time": time(30), [FEEDBACK]: report({ tick: 4, activity: [["c", "called"]], values: [ret("c", { f64: 9 })] }) });
    expect(history.at(0)).toMatchObject({ detached: { a: "called", b: "cached" }, values: { a: { f64: 1 }, b: { f64: 2 } } });
    expect(history.at(1)).toMatchObject({ detached: { a: "idle", b: "cached" }, values: { a: { f64: 3 }, b: { f64: 2 } } });
    expect(history.at(2).detached).toEqual({ a: "idle" });
    expect(history.at(2).values).toEqual({});
    expect(history.at(3).detached).toEqual({ c: "called" });
    expect(history.at(3).values).toEqual({ c: { f64: 9 } });
    // A node of any id, `__proto__` too, is an entry of its own.
    history.record({ "arora/time": time(40), [FEEDBACK]: report({ tick: 5, since: 4, status: [["__proto__", "running"]] }) });
    expect(Object.keys(history.at(4).statuses)).toContain("__proto__");
    // The earlier steps stay as they were.
    expect(history.at(1).values).toEqual({ a: { f64: 3 }, b: { f64: 2 } });
  });

  it("puts what a push without the clock carries in the step before it", () => {
    const history = new DeviceHistory({ report: decode });
    history.record({ "arora/time": time(0) });
    history.record({ [FEEDBACK]: report({ tick: 3, status: [["a", "success"]] }) });
    history.record({ "arora/time": time(10) });
    expect(history.length).toBe(2);
    expect(history.at(0).statuses).toEqual({ a: "S" });
  });

  it("finds a step by the device's clock", () => {
    const history = fed();
    expect(history.indexAt(0.025)).toBe(2);
    expect(history.indexAt(-1)).toBe(0);
    expect(history.indexAt(9)).toBe(4);
  });

  it("gives a key's numbers over the steps up to one, for a plot of the past", () => {
    const history = fed();
    expect(history.series("k", 3, 3)).toEqual([2, 2, 2]);
    expect(history.series("k", 1, 5)).toEqual([1, 2]);
    expect(history.series("s", 3, 2)).toEqual([null, null]);
    history.record({ "arora/time": time(50), on: { bool: true } });
    history.record({ "arora/time": time(60), on: { bool: false } });
    expect(history.series("on", 6, 2)).toEqual([1, 0]);
    // An integer a bridge kept as its digits plots rounded.
    history.record({ "arora/time": time(70), big: { u64: { rawJSON: "9007199254740993" } as unknown as number } });
    expect(history.series("big", 7, 1)).toEqual([9007199254740992]);
  });

  it("finds a time after a first step that had no clock", () => {
    const history = new DeviceHistory();
    history.record({ k: { f64: 1 } });
    history.record({ "arora/time": time(10) });
    expect(history.indexAt(5)).toBe(1);
    expect(history.indexAt(0.005)).toBe(0);
  });
});

describe("the timeline's replay", () => {
  it("moves on with the device's clock at a speed, and goes live at the newest step", () => {
    const history = fed();
    let at = replayFrom(history, 0);
    at = advanceReplay(history, at, 0.01, 1)!;
    expect(at.cursor).toBe(1);
    at = advanceReplay(history, at, 0.004, 0.5)!;
    expect(at.cursor).toBe(1);
    at = advanceReplay(history, at, 0.02, 0.5)!;
    expect(at.cursor).toBe(2);
    expect(advanceReplay(history, at, 1, 1)).toBeNull();
  });

  it("replays steps without a clock slower at a lower speed, and takes up the clock where it starts", () => {
    const history = new DeviceHistory();
    // A first push without the clock is a step of its own; the next ones carry it.
    history.record({ k: { f64: 0 } });
    history.record({ "arora/time": time(0) });
    history.record({ "arora/time": time(10) });
    history.record({ "arora/time": time(1000) });
    // A step every 1/30 s at 1×: at 0.5×, it takes two callbacks of 1/30 s.
    let at = replayFrom(history, 0);
    expect(at.time).toBeNull();
    at = advanceReplay(history, at, 1 / 30, 0.5)!;
    expect(at.cursor).toBe(0);
    at = advanceReplay(history, at, 1 / 30, 0.5)!;
    expect(at).toMatchObject({ cursor: 1, time: 0 });
    // On the clock from there: 10 ms reaches the next step, not the one a second on.
    at = advanceReplay(history, at, 0.01, 1)!;
    expect(at.cursor).toBe(2);
  });

  it("goes on the clock from its first step at a high speed, rather than skipping past it", () => {
    const history = new DeviceHistory();
    history.record({ k: { f64: 0 } });
    history.record({ "arora/time": time(0) });
    history.record({ "arora/time": time(10) });
    history.record({ "arora/time": time(1000) });
    // 33 ms at 4× is about 0.13 s of the device's: past its 10 ms step, short of the one a second on.
    const at = advanceReplay(history, replayFrom(history, 0), 0.033, 4);
    expect(at).toMatchObject({ cursor: 2 });
    expect(at!.time).toBeCloseTo(0.0987, 3);
  });

  it("reports the nodes only while the device runs the file", () => {
    const state = fed().at(2);
    expect(historyReport(state, "a", true)).toMatchObject({ tick: 9, root: "R", statuses: { c: "R" } });
    expect(historyReport(state, "a", false)).toEqual({ tick: 9, changes: [] });
  });
});

describe("a session's history", () => {
  const sessions: DeviceSession[] = [];
  afterEach(async () => {
    for (const session of sessions.splice(0)) await session.close();
  });

  it("keeps every step the device pushed, past what the session followed", async () => {
    const loaded = await loadedOf(ORDER);
    const device = new FakeDevice({ graph: loaded.graph, revision: 4 });
    const root = loaded.graph.root!;
    device.statuses = { [root]: "running" };
    const session = new DeviceSession(() => device.connect(), { language: FAKE_CALLS, rate: 100 });
    sessions.push(session);
    await new Promise<void>((resolve) => session.on("state", (s) => s.status === "connected" && resolve()));
    await session.follow(loaded);
    const history = session.history!;
    expect(history).not.toBeNull();
    // A thousand steps at once, more than a trace's feedback keeps between two reads.
    for (let i = 0; i < 1000; i++) {
      device.statuses = { [root]: i % 2 ? "success" : "running" };
      device.step({ "sensor/distance": { f32: i } });
    }
    expect(history.length).toBeGreaterThanOrEqual(1000);
    const last = history.length - 1;
    expect(history.at(last).statuses[root]).toBe("S");
    expect(history.at(last - 1).statuses[root]).toBe("R");
    expect(history.at(last).store.get("sensor/distance")).toEqual({ f32: 999 });
    expect(history.at(last - 500).store.get("sensor/distance")).toEqual({ f32: 499 });
    const times = Array.from({ length: history.length }, (_, i) => history.time(i) ?? -1);
    expect(times.every((t, i) => i === 0 || t >= times[i - 1]!)).toBe(true);
  });

  it("shows at each step the behavior of the revision the device ran then", () => {
    const one = { root: "a", nodes: [] };
    const two = { root: "b", nodes: [] };
    const history = new DeviceHistory({ base: new Map([[REVISION_KEY, { u64: 1 }]]) });
    history.record({ "arora/time": time(0) });
    history.record({ "arora/time": time(10), [REVISION_KEY]: { u64: 2 } });
    history.record({ "arora/time": time(20), [REVISION_KEY]: { u64: 3 } });
    history.recordBehavior(1, one);
    history.recordBehavior(2, two);
    expect(history.at(0)).toMatchObject({ revision: 1, behavior: one });
    expect(history.at(1)).toMatchObject({ revision: 2, behavior: two });
    // A revision whose behavior was not recorded shows none.
    expect(history.at(2)).toMatchObject({ revision: 3, behavior: null });
    // A device keeping no revision shows none either.
    expect(new DeviceHistory().at(0)).toMatchObject({ revision: null, behavior: null });
  });
});
