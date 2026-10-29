import { describe, expect, it } from "vitest";
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
import { MATH_FUNCTIONS, loadLanguage } from "../../fixtures/language";
import type { Graph } from "../model/graph";
import { type Value, valueBoolean, valueNumber } from "../model/value";
import type { Loaded } from "../text/language";
import { MATH, mathModule } from "./math-module";
import { MockArora, type MockModule, TIME_KEY } from "./mock-arora";
import * as N from "./natives";
import type { TickReport } from "./runtime";

/** One call the math module received: the function's name and its arguments by parameter name. */
interface Call {
  fn: string;
  args: Record<string, Value>;
}

/** The math module, recording each call into `calls`. */
function recordingMath(calls: Call[]): MockModule {
  const module = mathModule();
  return {
    ...module,
    functions: module.functions.map((fn) => ({
      signature: fn.signature,
      call: (args) => {
        const named = Object.fromEntries(
          [...args].map(([id, value]) => [fn.signature.function.parameters[id]!.name, value]),
        );
        calls.push({ fn: fn.signature.name, args: named });
        return fn.call(args);
      },
    })),
  };
}

const DT = 1000 / 30;

/** `loaded` running on a mock device seeded as `example` is, its calls recorded. */
async function run(example: Example, loaded: Loaded = example.loaded) {
  const calls: Call[] = [];
  const device = new MockArora({ store: example.store, modules: [recordingMath(calls)] });
  await device.start(loaded);
  return {
    device,
    calls,
    /** The graph node id of the node named, or at the path, `name`. */
    id: (name: string) => idOf(loaded, name),
    /** Tick once, and the calls it made. */
    tick: async (): Promise<{ report: TickReport; calls: Call[] }> => {
      calls.length = 0;
      const report = await device.step(DT);
      return { report, calls: [...calls] };
    },
    number: async (key: string) => valueNumber(await device.read(key)),
  };
}

const names = (calls: Call[]) => calls.map((c) => c.fn);

/** The detached activity of the nodes `named`, by name. */
function activity(id: (name: string) => string, report: TickReport, ...named: string[]) {
  return Object.fromEntries(named.map((n) => [n, report.detached?.[id(n)]]));
}

/** The graph of an example the device runs: as written by hand, or as the resolver makes it of the text. */
const SOURCES: [string, (example: Example) => Promise<Loaded>][] = [
  ["written by hand", (example) => Promise.resolve(example.loaded)],
  [
    "resolved from its text",
    async (example) => {
      const language = await loadLanguage();
      return language.resolve(language.parse(example.text).document, MATH_FUNCTIONS);
    },
  ],
];

describe.each(SOURCES)("MockArora on the spectrum's examples, the graph %s", (_, graphOf) => {
  const start = async (example: Example) => run(example, await graphOf(example));

  describe("Smile mapping: a graph alone", () => {
    it("runs every sink at the first tick and publishes after the tree", async () => {
      const { tick, number } = await start(SMILE);
      const { report, calls } = await tick();
      expect(report.root).toBe("R");
      expect(names(calls).sort()).toEqual(["clamp", "damp", "mul", "remap"]);
      // corner = -0.2 + 0.2 * 1.2; the easing starts from its target.
      expect(await number("rig/mouth_corner")).toBeCloseTo(0.04, 10);
      expect(await number("rig/cheek_raise")).toBeCloseTo(0.12, 10);
      expect(report.changes.map((c) => c.key).sort()).toEqual([
        TIME_KEY,
        "rig/cheek_raise",
        "rig/mouth_corner",
      ]);
    });

    it("makes no call once settled, and only downstream calls on a change", async () => {
      const { device, tick, number, id } = await start(SMILE);
      await tick();
      // The easing's state changed at its first call: a changed input, so it runs once more.
      expect(names((await tick()).calls)).toEqual(["damp"]);
      const settled = await tick();
      expect(settled.calls).toEqual([]);
      expect(activity(id, settled.report, "amount", "corner", "mouth", "cheeks")).toEqual({
        amount: "cached",
        corner: "cached",
        mouth: "cached",
        cheeks: "cached",
      });
      expect(settled.report.changes.map((c) => c.key)).toEqual([TIME_KEY]);
      // A cached node still reports its value: its last call's.
      expect(settled.report.values?.[id("cheeks")]).toEqual({ f64: 0.2 * 0.6 });

      await device.write("face/smile", { f64: 0.8 });
      const moved = await tick();
      expect(names(moved.calls).sort()).toEqual(["clamp", "damp", "mul", "remap"]);
      const corner = -0.2 + 0.8 * 1.2;
      const eased = await number("rig/mouth_corner");
      expect(eased).toBeGreaterThan(0.04);
      expect(eased).toBeLessThan(corner);
      expect(await number("rig/cheek_raise")).toBeCloseTo(0.48, 10);

      // The easing's state changed, so it alone runs until it settles.
      const easing = await tick();
      expect(names(easing.calls)).toEqual(["damp"]);
      let ticks = 0;
      while ((await tick()).calls.length && ticks < 200) ticks++;
      expect(ticks).toBeLessThan(200);
      expect(await number("rig/mouth_corner")).toBe(corner);
    });
  });

  describe("Breathing: driven by the clock", () => {
    it("runs the oscillator's path at every tick and caches the rest", async () => {
      const { tick, number, id } = await start(BREATHING);
      const first = await tick();
      expect(names(first.calls).sort()).toEqual(["add", "mul", "oscillator", "remap", "remap"]);
      const second = await tick();
      expect(names(second.calls)).toEqual(["oscillator", "mul", "add"]);
      expect(
        activity(id, second.report, "wave", "amplitude", "detached.2.a", "chest", "flush"),
      ).toEqual({
        wave: "called",
        amplitude: "cached",
        "detached.2.a": "called",
        chest: "called",
        flush: "cached",
      });
      const t = 2 / 30;
      const amplitude = 0.03 + 0.4 * (0.2 - 0.03);
      const chest = 0.5 + amplitude * Math.sin(2 * Math.PI * 0.3 * t);
      expect(await number("rig/chest")).toBeCloseTo(chest, 10);
      expect(await number("face/flush")).toBeCloseTo(0.15 + 0.4 * 0.7, 10);
    });

    it("reads the clock the device publishes before each tick", async () => {
      const { tick, calls } = await start(BREATHING);
      await tick();
      await tick();
      expect(calls.find((c) => c.fn === "oscillator")?.args.t).toEqual({ f64: 2 / 30 });
    });
  });

  describe("Greet, then rest", () => {
    it("rests while nobody is visible", async () => {
      const { tick, number, id } = await start(GREET);
      const { report, calls } = await tick();
      expect(report.root).toBe("S");
      expect(report.statuses?.[id("root")]).toBe("S");
      expect(report.statuses?.[id("root.0")]).toBe("F");
      expect(report.statuses?.[id("root.0.0")]).toBe("F");
      expect(report.statuses?.[id("root.0.1")]).toBeUndefined();
      expect(report.statuses?.[id("root.1")]).toBe("S");
      expect(names(calls)).toEqual(["truthy", "damp", "damp"]);
      expect(activity(id, report, "fresh", "root.0.2.1.a")).toEqual({
        fresh: "idle",
        "root.0.2.1.a": "idle",
      });
      expect(await number("rig/arm_raise")).toBe(0);
    });

    it("waves until the timer ends, marks the person greeted, then eases to rest", async () => {
      const { device, tick, number, id } = await start(GREET);
      await tick();
      await device.write("person/visible", { bool: true });
      const waving = await tick();
      expect(waving.report.root).toBe("R");
      expect(waving.report.statuses?.[id("root.0.2.2")]).toBe("R");
      expect(await number("rig/arm_raise")).toBeGreaterThan(0);
      expect(Math.abs((await number("rig/arm_wave"))!)).toBeGreaterThan(0);
      // The call in the wave's argument reads the clock: it runs at every tick its reader does.
      expect(waving.report.detached?.[id("root.0.2.1.a")]).toBe("called");

      let ticks = 1;
      let report = waving.report;
      while (report.root === "R" && ticks < 100) {
        report = (await tick()).report;
        ticks++;
      }
      // Two seconds at 30 Hz, from the tick the timer first ticked.
      expect(ticks).toBe(61);
      expect(report.root).toBe("S");
      expect(valueBoolean(await device.read("social/greeted"))).toBe(true);
      expect(await number("rig/arm_raise")).toBeCloseTo(1, 3);

      const resting = await tick();
      expect(resting.report.statuses?.[id("root.0.1")]).toBe("F");
      expect(await number("rig/arm_raise")).toBeLessThan(1);
    });

    it("keeps a branch's easing state while the branch is not ticked", async () => {
      const { device, tick, number } = await start(GREET);
      await device.write("person/visible", { bool: true });
      for (let i = 0; i < 70; i++) await tick();
      expect(valueBoolean(await device.read("social/greeted"))).toBe(true);
      for (let i = 0; i < 90; i++) await tick();
      expect(await number("rig/arm_raise")).toBeLessThan(0.01);
      // Greet again: the raise picks up from the state it held, not from the arm.
      await device.write("social/greeted", { bool: false });
      await tick();
      expect(await number("rig/arm_raise")).toBe(1);
    });
  });

  describe("Three readers of one value", () => {
    it("under a parallel, asks all three and runs the cascade once", async () => {
      const { tick, id } = await start(READERS_PARALLEL);
      const { report, calls } = await tick();
      expect(names(calls)).toEqual([
        "mul",
        "clamp",
        "lt",
        "truthy",
        "lt",
        "truthy",
        "lt",
        "truthy",
      ]);
      expect(calls[1]!.args.x).toEqual({ f64: 20 });
      // 20 cm: not nearer than 10, nearer than 30 and 50.
      expect(["root.0", "root.1", "root.2"].map((p) => report.statuses?.[id(p)])).toEqual([
        "F",
        "S",
        "S",
      ]);
      expect(report.root).toBe("F");
      expect(report.values?.[id("cm")]).toEqual({ f64: 20 });
      expect(names((await tick()).calls)).toEqual(["truthy", "truthy", "truthy"]);
    });

    it("under a fallback, stops at the first that holds and never asks the rest", async () => {
      const { tick, id } = await start(READERS_FALLBACK);
      const { report, calls } = await tick();
      expect(names(calls)).toEqual(["mul", "clamp", "lt", "truthy", "lt", "truthy"]);
      expect(report.root).toBe("S");
      expect(activity(id, report, "raw", "cm", "near", "mid", "far")).toEqual({
        raw: "called",
        cm: "called",
        near: "called",
        mid: "called",
        far: "idle",
      });
      expect(report.statuses?.[id("root.2")]).toBeUndefined();
    });

    it("under a fallback, runs only what a moved input reaches", async () => {
      const { device, tick, id } = await start(READERS_FALLBACK);
      await tick();
      await device.write("sensor/distance", { f64: 0.05 });
      const { report, calls } = await tick();
      expect(names(calls)).toEqual(["mul", "clamp", "lt", "truthy"]);
      expect(report.statuses?.[id("root.0")]).toBe("S");
      expect(activity(id, report, "near", "mid", "far")).toEqual({
        near: "called",
        mid: "idle",
        far: "idle",
      });
    });
  });

  describe("Order within a tick", () => {
    it("brings a node up to date at its first read; later reads reuse it", async () => {
      const { tick, number, id } = await start(ORDER);
      for (let n = 1; n <= 3; n++) {
        const { report, calls } = await tick();
        expect(report.root).toBe("S");
        // The first write sees v as the tick began; the read after it sees that write.
        // The second write reuses inc's cached value, and the second read the cached
        // v × 10: both readings of the tick are 10 n, and v ends the tick at n.
        expect(calls).toEqual([
          { fn: "add", args: { a: { f64: n - 1 }, b: { f64: 1 } } },
          { fn: "identity", args: { x: { f64: n } } },
          { fn: "mul", args: { a: { f64: n }, b: { f64: 10 } } },
          { fn: "lt", args: { a: { f64: 10 * n }, b: { f64: 1e12 } } },
          { fn: "truthy", args: { x: { bool: true } } },
          { fn: "identity", args: { x: { f64: n } } },
          { fn: "truthy", args: { x: { bool: true } } },
        ]);
        expect(activity(id, report, "inc", "scaled", "ok")).toEqual({
          inc: "called",
          scaled: "called",
          ok: "called",
        });
        expect(report.values?.[id("scaled")]).toEqual({ f64: 10 * n });
        expect(await number("v")).toBe(n);
      }
    });
  });

  describe("Return values", () => {
    it("reads one node's return value in another, and writes a return value to a key", async () => {
      const { device, tick, number, id } = await start(RETURN_VALUES);
      let { report } = await tick();
      // 0.3 m is near: the sequence holds, and face/look takes level's return value.
      expect(report.root).toBe("S");
      expect(report.values?.[id("cm")]).toEqual({ f64: 30 });
      expect(await number("face/level")).toBe(31);
      expect(await number("face/look")).toBe(31);

      await device.write("sensor/distance", { f64: 0.8 });
      ({ report } = await tick());
      // 0.8 m is not near: the fallback's second branch writes 0; level still publishes.
      expect(report.root).toBe("S");
      expect(await number("face/level")).toBe(51);
      expect(await number("face/look")).toBe(0);
    });
  });
});

describe("MockArora", () => {
  /** A graph of one root and the given links and variables. */
  const loaded = (graph: Partial<Graph> & Pick<Graph, "nodes">): Loaded => ({
    graph: { root: Object.keys(graph.nodes)[0], links: [], variables: {}, ...graph },
    nodes: [],
    diagnostics: [],
  });
  const node = (id: string, fn: string, children: string[] | null = null) => ({
    id,
    function: fn,
    inputs: [],
    outputs: [],
    children,
  });

  it("publishes sinks in id order, the later winning a shared key", async () => {
    const device = new MockArora();
    await device.start(
      loaded({
        nodes: {
          r: node("r", N.SUCCEED),
          b: node("b", MATH.identity.id),
          a: node("a", MATH.identity.id),
        },
        links: [
          { target: { node: "a", port: MATH.identity.x }, source: { literal: { f64: 1 } } },
          { target: { node: "a", port: N.RET }, source: { variable: "k" } },
          { target: { node: "b", port: MATH.identity.x }, source: { literal: { f64: 2 } } },
          { target: { node: "b", port: N.RET }, source: { variable: "k" } },
        ],
        variables: { k: "out" },
      }),
    );
    await device.step(DT);
    expect(await device.read("out")).toEqual({ f64: 2 });
  });

  it("publishes two sinks of one key as lowering lists them: by id, not as the text does", async () => {
    const language = await loadLanguage();
    const text = (first: string, second: string) =>
      `running\n\n${first}: {out} = identity(x: 1f64)\n${second}: {out} = identity(x: 2f64)\n`;
    for (const [first, second] of [
      ["alpha", "beta"],
      ["beta", "alpha"],
    ] as const) {
      const sinks = language.resolve(language.parse(text(first, second)).document, MATH_FUNCTIONS);
      const device = new MockArora();
      await device.start(sinks);
      await device.step(DT);
      // The sink of the greater id is listed later, and wins.
      const later = [idOf(sinks, first), idOf(sinks, second)].sort()[1];
      expect(await device.read("out")).toEqual({ f64: later === idOf(sinks, first) ? 1 : 2 });
    }
  });

  it("brings every sink up to date before any publishes", async () => {
    const device = new MockArora({ store: { x: { f64: 0 }, y: { f64: 0 } } });
    const add = (id: string, from: string, to: string) => [
      { target: { node: id, port: MATH.add.a }, source: { variable: from } },
      { target: { node: id, port: MATH.add.b }, source: { literal: { f64: 1 } } },
      { target: { node: id, port: N.RET }, source: { variable: to } },
    ];
    await device.start(
      loaded({
        nodes: {
          r: node("r", N.SUCCEED),
          s1: node("s1", MATH.add.id),
          s2: node("s2", MATH.add.id),
        },
        links: [...add("s1", "vy", "vx"), ...add("s2", "vx", "vy")],
        variables: { vx: "x", vy: "y" },
      }),
    );
    await device.step(DT);
    expect([await device.read("x"), await device.read("y")]).toEqual([{ f64: 1 }, { f64: 1 }]);
    await device.step(DT);
    expect([await device.read("x"), await device.read("y")]).toEqual([{ f64: 2 }, { f64: 2 }]);
  });

  it("feeds a detached node through a tree-local variable its return is bound to", async () => {
    const device = new MockArora({ store: { in: { f64: 3 } } });
    await device.start(
      loaded({
        nodes: { r: node("r", MATH.identity.id), d: node("d", MATH.mul.id) },
        links: [
          { target: { node: "d", port: MATH.mul.a }, source: { variable: "vin" } },
          { target: { node: "d", port: MATH.mul.b }, source: { literal: { f64: 2 } } },
          { target: { node: "d", port: N.RET }, source: { variable: "local" } },
          { target: { node: "r", port: MATH.identity.x }, source: { variable: "local" } },
          { target: { node: "r", port: N.RET }, source: { variable: "vout" } },
        ],
        variables: { vin: "in", local: ".x", vout: "out" },
      }),
    );
    const report = await device.step(DT);
    expect(report.detached).toEqual({ d: "called" });
    expect(await device.read("out")).toEqual({ f64: 6 });
  });

  it("ticks sequence_star past the children that succeeded", async () => {
    const device = new MockArora({ store: { now: { f64: 0 } } });
    await device.start(
      loaded({
        nodes: {
          r: node("r", N.SEQUENCE_STAR, ["a", "w", "b"]),
          a: node("a", MATH.identity.id),
          w: node("w", MATH.wait.id),
          b: node("b", N.SUCCEED),
        },
        links: [
          { target: { node: "a", port: MATH.identity.x }, source: { literal: { f64: 1 } } },
          { target: { node: "w", port: MATH.wait.seconds }, source: { literal: { f64: 0.03 } } },
          { target: { node: "w", port: MATH.wait.now }, source: { variable: "t" } },
          { target: { node: "w", port: MATH.wait.since }, source: { literal: { option: null } } },
        ],
        variables: { t: TIME_KEY },
      }),
    );
    const first = await device.step(DT);
    expect(first.statuses).toEqual({ r: "R", a: "S", w: "R" });
    const second = await device.step(DT);
    expect(second.statuses).toEqual({ r: "S", w: "S", b: "S" });
    const third = await device.step(DT);
    expect(Object.keys(third.statuses!).sort()).toEqual(["a", "r", "w"]);
  });

  it("ticks the string natives over their cells", async () => {
    const device = new MockArora({ store: { said: { str: "hello there" } } });
    const n = node;
    await device.start(
      loaded({
        nodes: {
          r: n("r", N.SEQUENCE, ["m", "s", "c", "u"]),
          m: n("m", N.REGEX_MATCH),
          s: n("s", N.SET_STRING),
          c: n("c", N.IS_STRING_SET),
          u: n("u", N.UNSET_STRING),
        },
        links: [
          { target: { node: "m", port: N.REGEX_MATCH_VALUE }, source: { variable: "said" } },
          {
            target: { node: "m", port: N.REGEX_MATCH_MATCHER },
            source: { literal: { str: "h\\w+" } },
          },
          { target: { node: "m", port: N.REGEX_MATCH_FIRST_MATCH }, source: { variable: "word" } },
          { target: { node: "s", port: N.SET_STRING_VARIABLE }, source: { variable: "copy" } },
          { target: { node: "s", port: N.SET_STRING_VALUE }, source: { variable: "word" } },
          { target: { node: "c", port: N.IS_STRING_SET_VALUE }, source: { variable: "copy" } },
          { target: { node: "u", port: N.UNSET_STRING_VARIABLE }, source: { variable: "said" } },
        ],
        variables: { said: "said", word: ".word", copy: "copy" },
      }),
    );
    const report = await device.step(DT);
    expect(report.root).toBe("S");
    expect(await device.read("copy")).toEqual({ str: "hello" });
    expect(await device.read("said")).toBeNull();
  });

  it("unpacks an array onto the ports it binds", async () => {
    const device = new MockArora({ store: { pose: { f64s: [0.1, 0.2, 0.3] } } });
    await device.start(
      loaded({
        nodes: { r: node("r", N.UNPACK) },
        links: [
          { target: { node: "r", port: N.UNPACK_VALUES }, source: { variable: "pose" } },
          { target: { node: "r", port: N.unpackOut(0) }, source: { variable: "x" } },
          { target: { node: "r", port: N.unpackOut(2) }, source: { variable: "z" } },
        ],
        variables: { pose: "pose", x: "head/x", z: "head/z" },
      }),
    );
    expect((await device.step(DT)).root).toBe("S");
    expect(await device.read("head/x")).toEqual({ f64: 0.1 });
    expect(await device.read("head/z")).toEqual({ f64: 0.3 });
  });

  it("scatters values onto keys within its prefix, and refuses one outside", async () => {
    const device = new MockArora({
      store: { names: { strs: ["face/a", "face/b"] }, values: { f64s: [1, 2] } },
    });
    const graph = (within: string) =>
      loaded({
        nodes: { r: node("r", N.SCATTER) },
        links: [
          { target: { node: "r", port: N.SCATTER_KEYS }, source: { variable: "names" } },
          { target: { node: "r", port: N.SCATTER_VALUES }, source: { variable: "values" } },
          { target: { node: "r", port: N.SCATTER_WITHIN }, source: { literal: { str: within } } },
        ],
        variables: { names: "names", values: "values" },
      });
    await device.start(graph("face"));
    expect((await device.step(DT)).root).toBe("S");
    expect(await device.read("face/b")).toEqual({ f64: 2 });
    await device.start(graph("rig"));
    await expect(device.step(DT)).rejects.toThrow(/cannot write key face\/a/);
  });

  it("fails a tick whose module leaf calls a function no module has", async () => {
    const device = new MockArora();
    await device.start(loaded({ nodes: { r: node("r", "00000000-0000-4000-8000-0000000000ff") } }));
    await expect(device.step(DT)).rejects.toThrow(/which no module has/);
  });

  it("refuses detached nodes that read each other in a cycle", async () => {
    const device = new MockArora();
    await expect(
      device.start(
        loaded({
          nodes: {
            r: node("r", N.SUCCEED),
            a: node("a", MATH.identity.id),
            b: node("b", MATH.identity.id),
          },
          links: [
            {
              target: { node: "a", port: MATH.identity.x },
              source: { port: { node: "b", port: N.RET } },
            },
            {
              target: { node: "b", port: MATH.identity.x },
              source: { port: { node: "a", port: N.RET } },
            },
          ],
        }),
      ),
    ).rejects.toThrow(/cycle/);
  });

  it("keeps the state of the nodes a new graph left as they were", async () => {
    const { device, tick, number } = await run(SMILE);
    await tick();
    await device.write("face/smile", { f64: 0.8 });
    await tick();
    const halfway = await number("rig/mouth_corner");
    // Restarting the same graph keeps the easing where it was.
    await device.start(SMILE.loaded);
    expect((await device.step(DT)).tick).toBe(1);
    expect(await number("rig/mouth_corner")).toBeGreaterThan(halfway!);
    // A changed node starts afresh: its easing jumps to its target.
    const changed = structuredClone(SMILE.loaded);
    const ease = idOf(SMILE.loaded, "mouth");
    const halfLife = changed.graph.links.find(
      (l) => l.target.node === ease && l.target.port === MATH.damp.half_life,
    )!;
    halfLife.source = { literal: { f64: 0.5 } };
    await device.start(changed);
    await device.step(DT);
    expect(await number("rig/mouth_corner")).toBeCloseTo(-0.2 + 0.8 * 1.2, 10);
  });

  it("lists the keys a behavior reads, set or not, as inputs, and keeps its own clock and outputs closed", async () => {
    const { device } = await run(SMILE, SMILE.loaded);
    await device.step(DT);
    const keys = Object.fromEntries((await device.keys()).map((k) => [k.key, k]));
    expect(keys["face/smile"]).toEqual({ key: "face/smile", editable: true, ty: "f64" });
    expect(keys[TIME_KEY]?.editable).toBe(false);
    expect(keys["rig/mouth_corner"]?.editable).toBe(false);
    const fresh = new MockArora();
    await fresh.start(SMILE.loaded);
    // Unset, it is listed all the same, typed by the parameter it feeds.
    expect(await fresh.keys()).toContainEqual({ key: "face/smile", editable: true, ty: "f64" });
    // A key a person writes is an input from then on.
    await fresh.write("rig/cheek_raise", { f64: 1 });
    expect((await fresh.keys()).find((k) => k.key === "rig/cheek_raise")?.editable).toBe(true);
  });

  it("steps its clock without a behavior, and keeps its store once stopped", async () => {
    const device = new MockArora({ store: { k: { bool: true } } });
    const report = await device.step(500);
    expect(report).toEqual({ tick: 0, changes: [{ key: TIME_KEY, value: { f64: 0.5 } }] });
    await device.start(SMILE.loaded);
    await device.stop();
    expect(await device.keys()).toEqual([
      { key: TIME_KEY, editable: false, ty: "f64" },
      { key: "k", editable: true, ty: "bool" },
    ]);
    await device.write("k", null);
    expect(await device.read("k")).toBeNull();
    expect((await device.functions()).map((f) => f.name)).toContain("damp");
  });
});
