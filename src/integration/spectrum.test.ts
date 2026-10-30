import { afterEach, describe, expect, it } from "vitest";
import {
  BREATHING,
  type Example,
  GREET,
  ORDER,
  READERS_FALLBACK,
  READERS_PARALLEL,
  RETURN_VALUES,
  SMILE,
  idOf,
} from "../../fixtures/examples";
import { localArora, loadedOf, stepped } from "../../fixtures/local-arora";
import { type Value, valueBoolean, valueNumber } from "../model/value";
import type { TickReport } from "../runtime/runtime";
import type { DeviceSession } from "../session/device-session";

/**
 * The NGBT spectrum's examples on the local Arora, a real Arora device in the
 * page carrying `@arora/dataflow`, through the session the editor works
 * with: what each example shows of the interpreter's semantics, read off the
 * trace (each node's status, each detached node's activity and value) and
 * the device's store. The same texts run on any device carrying
 * `@arora/dataflow`.
 */

const sessions: DeviceSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
});

/** `example` running on a local Arora seeded as it says, stepped by the test 50 times a second. */
async function run(example: Example) {
  const session = await localArora(example, { rate: 50 });
  sessions.push(session);
  const loaded = await loadedOf(example);
  await session.run(loaded);
  const id = (name: string) => idOf(loaded, name);
  return {
    session,
    id,
    tick: async () => (await stepped(session)).report,
    write: (key: string, value: Value) => session.write(key, value),
    number: async (key: string) => valueNumber(await session.read(key))!,
    /** The detached activity of the nodes `named`, by name. */
    activity: (report: TickReport, ...named: string[]) =>
      Object.fromEntries(named.map((n) => [n, report.detached?.[id(n)]])),
    /** The statuses of the nodes at `paths`, in order. */
    statuses: (report: TickReport, ...paths: string[]) =>
      paths.map((p) => report.statuses?.[id(p)]),
  };
}

describe("the spectrum's examples on the local Arora", () => {
  describe("Smile mapping: a graph alone", () => {
    it("publishes every sink, and calls a node again only when its arguments change", async () => {
      const { tick, write, number, activity, id } = await run(SMILE);
      let report = await tick();
      expect(report.root).toBe("R");
      // corner = -0.2 + 0.2 × 1.2; the easing starts from its target.
      expect(await number("rig/mouth_corner")).toBeCloseTo(0.04, 5);
      expect(await number("rig/cheek_raise")).toBeCloseTo(0.12, 5);

      // Settled: every node answers from its cache, its value its last call's.
      report = await tick();
      expect(activity(report, "amount", "corner", "mouth", "cheeks")).toEqual({
        amount: "cached",
        corner: "cached",
        mouth: "cached",
        cheeks: "cached",
      });
      expect(valueNumber(report.values?.[id("cheeks")])).toBeCloseTo(0.12, 5);

      // A moved input calls what it reaches; the easing goes on alone until it settles.
      await write("face/smile", { f32: 0.8 });
      report = await tick();
      expect(activity(report, "amount", "corner", "mouth", "cheeks")).toEqual({
        amount: "called",
        corner: "called",
        mouth: "called",
        cheeks: "called",
      });
      const corner = -0.2 + 0.8 * 1.2;
      const eased = await number("rig/mouth_corner");
      expect(eased).toBeGreaterThan(0.04);
      expect(eased).toBeLessThan(corner);
      expect(await number("rig/cheek_raise")).toBeCloseTo(0.48, 5);
      report = await tick();
      expect(activity(report, "amount", "mouth")).toEqual({ amount: "cached", mouth: "called" });
      let ticks = 0;
      while (report.detached?.[id("mouth")] === "called" && ticks < 500) {
        report = await tick();
        ticks++;
      }
      expect(ticks).toBeLessThan(500);
      expect(await number("rig/mouth_corner")).toBeCloseTo(corner, 5);
    });
  });

  describe("Breathing: driven by the clock", () => {
    it("calls the oscillator's path at every tick and answers the rest from its cache", async () => {
      const { tick, number, activity } = await run(BREATHING);
      await tick();
      const report = await tick();
      expect(activity(report, "wave", "amplitude", "detached.2.operand_0", "chest", "flush")).toEqual(
        {
          wave: "called",
          amplitude: "cached",
          "detached.2.operand_0": "called",
          chest: "called",
          flush: "cached",
        },
      );
      const t = (await number("arora/time")) / 1e9;
      const amplitude = 0.03 + 0.4 * (0.2 - 0.03);
      expect(await number("rig/chest")).toBeCloseTo(0.5 + amplitude * Math.sin(2 * Math.PI * 0.3 * t), 4);
      expect(await number("face/flush")).toBeCloseTo(0.15 + 0.4 * 0.7, 5);
    });
  });

  describe("Greet, then rest", () => {
    it("rests while nobody is visible", async () => {
      const { tick, number, statuses, activity } = await run(GREET);
      const report = await tick();
      expect(report.root).toBe("S");
      expect(statuses(report, "root", "root.0", "root.0.0", "root.0.1", "root.1")).toEqual([
        "S",
        "F",
        "F",
        undefined,
        "S",
      ]);
      // Nothing read whether the person was greeted.
      expect(activity(report, "fresh")).toEqual({ fresh: undefined });
      expect(await number("rig/arm_raise")).toBe(0);
    });

    it("waves for two seconds, marks the person greeted, then eases the arm back from where it is", async () => {
      const { session, tick, write, number, statuses, activity, id } = await run(GREET);
      await tick();
      await write("person/visible", { bool: true });
      let report = await tick();
      expect(report.root).toBe("R");
      expect(statuses(report, "root.0.2", "root.0.2.2")).toEqual(["R", "R"]);
      expect(await number("rig/arm_raise")).toBeGreaterThan(0);
      expect(Math.abs(await number("rig/arm_wave"))).toBeGreaterThan(0);
      // The wave's oscillator reads the clock: it is called at every tick its reader is.
      expect(activity(report, "root.0.2.1.operand_0", "waved")).toEqual({
        "root.0.2.1.operand_0": "called",
        waved: "called",
      });

      // Two seconds after the last rest: a hundred ticks of 20 ms.
      let ticks = 1;
      while (report.root === "R" && ticks < 200) {
        report = await tick();
        ticks++;
      }
      expect(ticks).toBeGreaterThanOrEqual(100);
      expect(ticks).toBeLessThanOrEqual(102);
      expect(report.root).toBe("S");
      expect(report.values?.[id("waved")]).toEqual({ bool: true });
      expect(valueBoolean(await session.read("social/greeted"))).toBe(true);
      const raised = await number("rig/arm_raise");
      expect(raised).toBeCloseTo(1, 3);

      // Greeted, it rests: the arm eases from where it is, its damp's state being the arm's key.
      report = await tick();
      expect(statuses(report, "root.0.1", "root.1")).toEqual(["F", "S"]);
      const resting = await number("rig/arm_raise");
      expect(resting).toBeLessThan(raised);
      expect(resting).toBeGreaterThan(0.5);

      // Greeted again, it waves two seconds again, timed from its last rest.
      await write("social/greeted", { bool: false });
      report = await tick();
      expect(report.root).toBe("R");
      ticks = 1;
      while (report.root === "R" && ticks < 200) {
        report = await tick();
        ticks++;
      }
      expect(ticks).toBeGreaterThanOrEqual(100);
      expect(ticks).toBeLessThanOrEqual(102);
    });
  });

  describe("Three readers of one value", () => {
    it("under a parallel, asks all three, and a moved input calls the cascade once for them", async () => {
      const { tick, write, statuses, activity, id } = await run(READERS_PARALLEL);
      let report = await tick();
      // 20 cm: not nearer than 10, nearer than 30 and 50.
      expect(statuses(report, "root.0", "root.1", "root.2")).toEqual(["F", "S", "S"]);
      expect(report.root).toBe("F");
      expect(valueNumber(report.values?.[id("cm")])).toBeCloseTo(20, 4);

      await write("sensor/distance", { f32: 0.05 });
      report = await tick();
      expect(activity(report, "raw", "cm", "near", "mid", "far")).toEqual({
        raw: "called",
        cm: "called",
        near: "called",
        mid: "called",
        far: "called",
      });
      expect(report.root).toBe("S");
    });

    it("under a fallback, stops at the first that holds and never asks the rest", async () => {
      const { tick, write, statuses, activity } = await run(READERS_FALLBACK);
      let report = await tick();
      expect(report.root).toBe("S");
      expect(statuses(report, "root.0", "root.1", "root.2")).toEqual(["F", "S", undefined]);
      expect(activity(report, "far")).toEqual({ far: undefined });

      // Nearer: the first reader holds, and only what the moved input reaches is called.
      await write("sensor/distance", { f32: 0.05 });
      report = await tick();
      expect(statuses(report, "root.0", "root.1")).toEqual(["S", undefined]);
      expect(activity(report, "raw", "cm", "near", "mid")).toEqual({
        raw: "called",
        cm: "called",
        near: "called",
        mid: "idle",
      });
    });
  });

  describe("Order within a tick", () => {
    it("brings a node up to date at its first read; later reads of the tick reuse it", async () => {
      const { tick, number, activity, id } = await run(ORDER);
      let previous = await number("v");
      for (let i = 0; i < 3; i++) {
        const report = await tick();
        expect(report.root).toBe("S");
        // Both writes of a tick write inc's one value: v moves on by one a tick,
        // and the second read of the tick reuses the first's v × 10.
        const v = await number("v");
        expect(v).toBe(previous + 1);
        expect(activity(report, "inc", "scaled", "ok")).toEqual({
          inc: "called",
          scaled: "called",
          ok: "called",
        });
        expect(valueNumber(report.values?.[id("inc")])).toBe(v);
        expect(valueNumber(report.values?.[id("scaled")])).toBe(10 * v);
        previous = v;
      }
    });
  });

  describe("Return values", () => {
    it("reads one node's return value in another, and writes a return value to a key", async () => {
      const { tick, write, number, id } = await run(RETURN_VALUES);
      let report = await tick();
      // 0.3 m is near: the sequence holds, and face/look takes level's return value.
      expect(report.root).toBe("S");
      expect(valueNumber(report.values?.[id("cm")])).toBeCloseTo(30, 4);
      expect(await number("face/level")).toBeCloseTo(31, 4);
      expect(await number("face/look")).toBeCloseTo(31, 4);

      // 0.8 m is not near: the fallback's second branch writes 0; level still publishes.
      await write("sensor/distance", { f32: 0.8 });
      report = await tick();
      expect(report.root).toBe("S");
      expect(await number("face/level")).toBeCloseTo(51, 4);
      expect(await number("face/look")).toBe(0);
    });
  });
});
