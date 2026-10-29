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
import type { GraphNode, Source } from "../model/graph";
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
  /** A graph of the given nodes, the first its root. */
  const loaded = (...nodes: GraphNode[]): Loaded => ({
    graph: { root: nodes[0]!.id, nodes },
    nodes: [],
    diagnostics: [],
  });
  const node = (
    id: string,
    fn: string,
    bind: Record<string, Source> = {},
    children?: string[],
  ): GraphNode => ({
    id,
    function: fn,
    ...(Object.keys(bind).length ? { bind } : {}),
    ...(children ? { children } : {}),
  });
  const value = (v: Value): Source => ({ value: v });
  const key = (k: string): Source => ({ key: k });
  const from = (n: string, port: string = N.RET): Source => ({ port: { node: n, port } });

  it("publishes sinks in id order, the later winning a shared key", async () => {
    const device = new MockArora();
    await device.start(
      loaded(
        node("r", N.SUCCEED),
        node("b", MATH.identity.id, { [MATH.identity.x]: value({ f64: 2 }), [N.RET]: key("out") }),
        node("a", MATH.identity.id, { [MATH.identity.x]: value({ f64: 1 }), [N.RET]: key("out") }),
      ),
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
    const add = (id: string, input: string, output: string) =>
      node(id, MATH.add.id, {
        [MATH.add.a]: key(input),
        [MATH.add.b]: value({ f64: 1 }),
        [N.RET]: key(output),
      });
    await device.start(loaded(node("r", N.SUCCEED), add("s1", "y", "x"), add("s2", "x", "y")));
    await device.step(DT);
    expect([await device.read("x"), await device.read("y")]).toEqual([{ f64: 1 }, { f64: 1 }]);
    await device.step(DT);
    expect([await device.read("x"), await device.read("y")]).toEqual([{ f64: 2 }, { f64: 2 }]);
  });

  it("feeds a detached node through a tree-local variable its return is bound to", async () => {
    const device = new MockArora({ store: { in: { f64: 3 } } });
    await device.start(
      loaded(
        node("r", MATH.identity.id, { [MATH.identity.x]: key(".x"), [N.RET]: key("out") }),
        node("d", MATH.mul.id, {
          [MATH.mul.a]: key("in"),
          [MATH.mul.b]: value({ f64: 2 }),
          [N.RET]: key(".x"),
        }),
      ),
    );
    const report = await device.step(DT);
    expect(report.detached).toEqual({ d: "called" });
    expect(await device.read("out")).toEqual({ f64: 6 });
  });

  it("ticks sequence_star past the children that succeeded", async () => {
    const device = new MockArora({ store: { now: { f64: 0 } } });
    await device.start(
      loaded(
        node("r", N.SEQUENCE_STAR, {}, ["a", "w", "b"]),
        node("a", MATH.identity.id, { [MATH.identity.x]: value({ f64: 1 }) }),
        node("w", MATH.wait.id, {
          [MATH.wait.seconds]: value({ f64: 0.03 }),
          [MATH.wait.now]: key(TIME_KEY),
          [MATH.wait.since]: value({ option: null }),
        }),
        node("b", N.SUCCEED),
      ),
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
    await device.start(
      loaded(
        node("r", N.SEQUENCE, {}, ["m", "s", "c", "u"]),
        node("m", N.REGEX_MATCH, {
          [N.REGEX_MATCH_VALUE]: key("said"),
          [N.REGEX_MATCH_MATCHER]: value({ str: "h\\w+" }),
          [N.REGEX_MATCH_FIRST_MATCH]: key(".word"),
        }),
        node("s", N.SET_STRING, {
          [N.SET_STRING_VARIABLE]: key("copy"),
          [N.SET_STRING_VALUE]: key(".word"),
        }),
        node("c", N.IS_STRING_SET, { [N.IS_STRING_SET_VALUE]: key("copy") }),
        node("u", N.UNSET_STRING, { [N.UNSET_STRING_VARIABLE]: key("said") }),
      ),
    );
    const report = await device.step(DT);
    expect(report.root).toBe("S");
    expect(await device.read("copy")).toEqual({ str: "hello" });
    expect(await device.read("said")).toBeNull();
  });

  it("unpacks an array onto the ports it binds", async () => {
    const device = new MockArora({ store: { pose: { f64s: [0.1, 0.2, 0.3] } } });
    await device.start(
      loaded(
        node("r", N.UNPACK, {
          [N.UNPACK_VALUES]: key("pose"),
          [N.unpackOut(0)]: key("head/x"),
          [N.unpackOut(2)]: key("head/z"),
        }),
      ),
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
      loaded(
        node("r", N.SCATTER, {
          [N.SCATTER_KEYS]: key("names"),
          [N.SCATTER_VALUES]: key("values"),
          [N.SCATTER_WITHIN]: value({ str: within }),
        }),
      );
    await device.start(graph("face"));
    expect((await device.step(DT)).root).toBe("S");
    expect(await device.read("face/b")).toEqual({ f64: 2 });
    await device.start(graph("rig"));
    await expect(device.step(DT)).rejects.toThrow(/cannot write key face\/a/);
  });

  it("fails a tick whose module leaf calls a function no module has", async () => {
    const device = new MockArora();
    await device.start(loaded(node("r", "00000000-0000-4000-8000-0000000000ff")));
    await expect(device.step(DT)).rejects.toThrow(/which no module has/);
  });

  it("refuses detached nodes that read each other in a cycle", async () => {
    const device = new MockArora();
    await expect(
      device.start(
        loaded(
          node("r", N.SUCCEED),
          node("a", MATH.identity.id, { [MATH.identity.x]: from("b") }),
          node("b", MATH.identity.id, { [MATH.identity.x]: from("a") }),
        ),
      ),
    ).rejects.toThrow(/cycle/);
  });

  it("starts every node afresh, as a load does", async () => {
    const { device, tick, number } = await run(SMILE);
    await tick();
    await device.write("face/smile", { f64: 0.8 });
    await tick();
    const target = -0.2 + 0.8 * 1.2;
    expect(await number("rig/mouth_corner")).toBeLessThan(target - 0.1);
    await device.start(SMILE.loaded);
    expect((await device.step(DT)).tick).toBe(1);
    // The easing starts again from its target.
    expect(await number("rig/mouth_corner")).toBeCloseTo(target, 10);
  });

  describe("an edit", () => {
    /** `text` resolved against the math module, and the diff to it from `from`. */
    const resolved = async (text: string) => {
      const language = await loadLanguage();
      const next = language.resolve(language.parse(text).document, MATH_FUNCTIONS);
      expect(next.diagnostics).toEqual([]);
      return { loaded: next, diff: (base: Loaded) => language.diff(base.graph, next.graph) };
    };

    it("keeps a damp's state when it edits another node, and restarts the damp it binds", async () => {
      const smile = await resolved(SMILE.text);
      const { device, tick, number, id } = await run(SMILE, smile.loaded);
      await tick();
      await device.write("face/smile", { f64: 0.8 });
      await tick();
      const halfway = (await number("rig/mouth_corner"))!;
      const target = -0.2 + 0.8 * 1.2;
      expect(halfway).toBeLessThan(target - 0.1);

      const cheeks = await resolved(SMILE.text.replace("b: 0.6", "b: 0.7"));
      const elsewhere = cheeks.diff(smile.loaded);
      expect(elsewhere).toEqual({
        bind: [{ node: id("cheeks"), port: MATH.mul.b, source: { value: { f64: 0.7 } } }],
      });
      await device.edit(elsewhere);
      expect((await device.step(DT)).tick).toBe(3);
      expect(await number("rig/cheek_raise")).toBeCloseTo(0.8 * 0.7, 10);
      // The easing goes on from where it was: past halfway, short of its target.
      const after = (await number("rig/mouth_corner"))!;
      expect(after).toBeGreaterThan(halfway);
      expect(after).toBeLessThan(target - 0.05);

      const mouth = await resolved(
        SMILE.text.replace("b: 0.6", "b: 0.7").replace("half_life: 0.12", "half_life: 0.5"),
      );
      await device.edit(mouth.diff(cheeks.loaded));
      await device.step(DT);
      // Bound anew, the easing restarts from its target.
      expect(await number("rig/mouth_corner")).toBeCloseTo(target, 10);
    });

    it("keeps a sequence_star's place when it edits another node, and restarts it when it sets it", async () => {
      const text = (extra: string, last: string) =>
        [
          "sequence_star",
          "  wait(seconds: 0.05, now: {arora/time}, since: none)",
          "  {phase} = identity(x: 1f64)",
          "  wait(seconds: 10, now: {arora/time}, since: none)",
          last,
          "",
          `other: {other} = identity(x: ${extra}f64)`,
          "",
        ].join("\n");
      const first = await resolved(text("1", "  {phase} = identity(x: 2f64)"));
      const { tick, number, id, device } = await run(SMILE, first.loaded);
      for (let i = 0; i < 4; i++) await tick();
      // Past the first wait and the first write, the sequence waits on its third child.
      expect(await number("phase")).toBe(1);
      const waiting = ["root", "root.2"].map(id).sort();
      expect(Object.keys((await tick()).report.statuses!).sort()).toEqual(waiting);

      const other = await resolved(text("2", "  {phase} = identity(x: 2f64)"));
      const elsewhere = other.diff(first.loaded);
      expect(elsewhere.set).toBeUndefined();
      expect(elsewhere.bind?.map((b) => b.node)).toEqual([id("other")]);
      await device.edit(elsewhere);
      const resumed = (await tick()).report;
      expect(Object.keys(resumed.statuses!).sort()).toEqual(waiting);
      expect(await number("other")).toBe(2);

      const grown = await resolved(text("2", "  {phase} = identity(x: 2f64)\n  succeed"));
      const restart = grown.diff(other.loaded);
      expect(restart.set?.map((n) => n.id)).toContain(id("root"));
      await device.edit(restart);
      // Set anew, the sequence starts again at its first child.
      const restarted = (await tick()).report;
      expect(restarted.statuses?.[id("root.0")]).toBeDefined();
    });

    it("keeps the place of a sequence_star whose place no binding holds", async () => {
      const device = new MockArora({ store: { now: { f64: 0 } } });
      await device.start(
        loaded(
          node("r", N.SEQUENCE_STAR, {}, ["a", "w", "b"]),
          node("a", MATH.identity.id, { [MATH.identity.x]: value({ f64: 1 }) }),
          node("w", MATH.wait.id, {
            [MATH.wait.seconds]: value({ f64: 0.03 }),
            [MATH.wait.now]: key(TIME_KEY),
            [MATH.wait.since]: value({ option: null }),
          }),
          node("b", N.SUCCEED),
        ),
      );
      expect((await device.step(DT)).statuses).toEqual({ r: "R", a: "S", w: "R" });
      await device.edit({});
      // On from the wait: the first child does not run again.
      expect((await device.step(DT)).statuses).toEqual({ r: "S", w: "S", b: "S" });
    });

    it("calls a detached node again only when its arguments change", async () => {
      const device = new MockArora({ store: { in: { f64: 3 } } });
      const graph = (b: number) =>
        loaded(
          node("r", MATH.identity.id, { [MATH.identity.x]: key(".x"), [N.RET]: key("out") }),
          node("d", MATH.mul.id, {
            [MATH.mul.a]: key("in"),
            [MATH.mul.b]: value({ f64: 2 }),
            [N.RET]: key(".x"),
          }),
          node("e", MATH.mul.id, {
            [MATH.mul.a]: key("in"),
            [MATH.mul.b]: value({ f64: b }),
            [N.RET]: key("other"),
          }),
        );
      await device.start(graph(1));
      expect((await device.step(DT)).detached).toEqual({ d: "called", e: "called" });
      await device.edit({ bind: [{ node: "e", port: MATH.mul.b, source: { value: { f64: 5 } } }] });
      const report = await device.step(DT);
      expect(report.detached).toEqual({ d: "cached", e: "called" });
      expect(await device.read("out")).toEqual({ f64: 6 });
      expect(await device.read("other")).toEqual({ f64: 15 });
    });

    it("is refused when no behavior runs", async () => {
      await expect(new MockArora().edit({})).rejects.toThrow(/no behavior runs/);
    });
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
