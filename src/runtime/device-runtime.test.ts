import { describe, expect, it } from "vitest";
import { GREET, ORDER } from "../../fixtures/examples";
import type { Graph, GraphDiff } from "../model/graph";
import type { Value } from "../model/value";
import { type AroraDevice, DeviceRuntime } from "./device-runtime";
import { MATH, mathModule } from "./math-module";
import type { TraceReport } from "./trace";

/**
 * A device whose store is a map of device-relative keys, the host's store
 * holding them under its id, `robot`. An update is queued until the next step,
 * and a step runs `onStep`, the device's own behavior.
 */
class FakeDevice implements AroraDevice {
  store = new Map<string, Value>();
  calls: string[] = [];
  pending: Record<string, Value | null>[] = [];
  onStep: (store: Map<string, Value>) => void = () => {};

  describeMethods() {
    return JSON.stringify(mathModule().functions.map((f) => f.signature));
  }
  call(callJson: string) {
    this.calls.push(callJson);
    return JSON.stringify({ ret: { str: `run ${this.calls.length}` }, mutated: [] });
  }
  update(changesJson: string) {
    this.pending.push(JSON.parse(changesJson) as Record<string, Value | null>);
  }
  read(key: string) {
    if (!key.startsWith("robot/")) throw new Error(`read outside the device: ${key}`);
    return JSON.stringify(this.store.get(key.slice("robot/".length)) ?? null);
  }
  /** Each key's meta, as `setMeta` sets it: what opens it to `update`. */
  meta = new Map<string, Record<string, unknown>>();
  listKeys() {
    const keys = [...new Set([...this.store.keys(), ...this.meta.keys()])].sort();
    return JSON.stringify(keys.map((key) => [key, this.meta.get(key) ?? {}]));
  }
  step() {
    for (const changes of this.pending.splice(0)) {
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) this.store.delete(key);
        else this.store.set(key, value);
      }
    }
    this.onStep(this.store);
  }
}

function setup() {
  const device = new FakeDevice();
  const loaded: Graph[] = [];
  const edited: GraphDiff[] = [];
  const runtime = new DeviceRuntime({
    device,
    deviceId: "robot",
    loadCall: (graph) => {
      loaded.push(graph);
      return JSON.stringify({ load: loaded.length });
    },
    editCall: (diff) => {
      edited.push(diff);
      return JSON.stringify({ edit: edited.length });
    },
  });
  return { device, runtime, loaded, edited };
}

describe("DeviceRuntime", () => {
  it("lists the device's functions as it describes them", async () => {
    const { runtime } = setup();
    const names = (await runtime.functions()).map((f) => f.name);
    expect(names).toContain("damp");
    expect((await runtime.functions()).find((f) => f.name === "add")?.id).toBe(MATH.add.id);
  });

  it("starts a behavior through the device's call path", async () => {
    const { device, runtime, loaded } = setup();
    await runtime.start(ORDER.loaded);
    expect(loaded).toEqual([ORDER.loaded.graph]);
    expect(device.calls).toEqual([JSON.stringify({ load: 1 })]);
  });

  it("reports a step's changes from the store an edit left", async () => {
    const { device, runtime } = setup();
    device.store.set("k", { f64: 1 });
    await runtime.start(ORDER.loaded);
    // As a device applying the call with a step at zero dt.
    const call = device.call.bind(device);
    device.call = (json: string) => {
      device.store.set("k", { f64: 2 });
      return call(json);
    };
    await runtime.edit({ remove: ["n"] });
    device.onStep = (store) => store.set("k", { f64: 1 });
    expect((await runtime.step(10)).changes).toEqual([{ key: "k", value: { f64: 1 } }]);
  });

  it("edits the behavior running through the device's call path, and refuses with none", async () => {
    const { device, runtime, edited } = setup();
    const diff: GraphDiff = { remove: ["n"] };
    await expect(runtime.edit(diff)).rejects.toThrow(/no behavior runs/);
    await runtime.start(ORDER.loaded);
    await runtime.edit(diff);
    expect(edited).toEqual([diff]);
    expect(device.calls).toEqual([JSON.stringify({ load: 1 }), JSON.stringify({ edit: 1 })]);
    await runtime.stop();
    await expect(runtime.edit(diff)).rejects.toThrow(/no behavior runs/);
  });

  it("reports what each step changed", async () => {
    const { device, runtime } = setup();
    device.store.set("v", { f64: 0 });
    device.store.set("gone", { bool: true });
    await runtime.start(ORDER.loaded);
    device.onStep = (store) => {
      store.set("v", { f64: 1 });
      store.delete("gone");
    };
    // The first step after a start states the whole store: what a read of it
    // in between saw may be gone already.
    let report = await runtime.step(33);
    expect(report.tick).toBe(1);
    expect(report.root).toBeUndefined();
    expect(report.statuses).toBeUndefined();
    expect(report).toMatchObject({ whole: true, changes: [{ key: "v", value: { f64: 1 } }] });
    device.onStep = (store) => {
      store.set("v", { f64: 2 });
      store.set("gone", { bool: true });
    };
    report = await runtime.step(33);
    expect(report.whole).toBeUndefined();
    expect(report.changes).toEqual([
      { key: "gone", value: { bool: true } },
      { key: "v", value: { f64: 2 } },
    ]);
    device.onStep = (store) => store.delete("gone");
    expect((await runtime.step(33)).changes).toEqual([{ key: "gone", value: null }]);
    device.onStep = () => {};
    expect((await runtime.step(33)).changes).toEqual([]);
  });

  it("writes keys device-relative, applied at the next step", async () => {
    const { device, runtime } = setup();
    await runtime.write("face/smile", { f64: 0.5 });
    await runtime.write("face/old", null);
    expect(device.pending).toEqual([{ "face/smile": { f64: 0.5 } }, { "face/old": null }]);
    expect(await runtime.read("face/smile")).toBeNull();
    await runtime.step(33);
    expect(await runtime.read("face/smile")).toEqual({ f64: 0.5 });
    expect(await runtime.keys()).toEqual([{ key: "face/smile", editable: false }]);
  });

  it("lists each key as the device's meta says, with or without a value", async () => {
    const { device, runtime } = setup();
    device.meta.set("sensor/distance", { ty: "f32", editable: true, min: 0, max: 2 });
    device.meta.set("animation/players", { editable: false });
    device.store.set("k.position", { f64: 0.1 });
    expect(await runtime.keys()).toEqual([
      { key: "animation/players", editable: false },
      { key: "k.position", editable: false },
      { key: "sensor/distance", editable: true, ty: "f32", min: 0, max: 2 },
    ]);
  });

  it("stops the behavior by loading the empty graph", async () => {
    const { device, runtime, loaded } = setup();
    await runtime.start(ORDER.loaded);
    await runtime.stop();
    expect(loaded.at(-1)).toEqual({});
    expect(device.calls.at(-1)).toBe(JSON.stringify({ load: 2 }));
    expect((await runtime.step(33)).tick).toBe(0);
  });

  it("rejects with what the device refused", async () => {
    const { device, runtime } = setup();
    device.call = () => {
      throw new Error("unknown module");
    };
    await expect(runtime.start(ORDER.loaded)).rejects.toThrow("unknown module");
  });

  describe("with a trace", () => {
    /**
     * The runtime over the fake device, tracing: a TRACE call answers the
     * trace's number, its reports sit at `t<n>/feedback` as the device writes
     * them, and HALT is a call naming it.
     */
    function traced(refuse = false) {
      const { device, runtime: _, ...rest } = setup();
      let traces = 0;
      const call = device.call.bind(device);
      device.call = (json: string) => {
        const parsed = JSON.parse(json) as { trace?: { values: string[] } };
        if (!parsed.trace) return call(json);
        if (refuse) throw new Error("this interpreter does not trace");
        call(json);
        traces += 1;
        return JSON.stringify({ ret: { u64: traces }, mutated: [] });
      };
      const runtime = new DeviceRuntime({
        device,
        deviceId: "robot",
        loadCall: () => JSON.stringify({ load: true }),
        editCall: () => JSON.stringify({ edit: true }),
        trace: {
          traceCall: (options) => JSON.stringify({ trace: options }),
          traceHandle: (result) => {
            const n = (JSON.parse(result) as { ret: { u64: number } }).ret.u64;
            return {
              id: `t${n}`,
              stop: { halt: n },
              status: `t${n}/status`,
              feedback: [`t${n}/feedback`],
            };
          },
          traceReport: (json) => JSON.parse(json) as TraceReport,
        },
      });
      /** The device writes `report` as trace `n`'s latest. */
      const write = (n: number, report: TraceReport) =>
        device.store.set(`t${n}/feedback`, report as unknown as Value);
      const traceCalls = () =>
        device.calls
          .map((c) => JSON.parse(c) as Record<string, unknown>)
          .filter((c) => "trace" in c);
      const halts = () => device.calls.filter((c) => c.includes('"halt"'));
      return { device, runtime, write, traceCalls, halts, ...rest };
    }

    const root = ORDER.loaded.graph.root!;

    it("reports each node as the trace's reports leave it, watching the named and detached nodes", async () => {
      const { runtime, write, traceCalls } = traced();
      await runtime.start(ORDER.loaded);
      expect(traceCalls()).toEqual([
        {
          trace: {
            values: ORDER.loaded.nodes
              .filter((n) => n.name !== null || !n.attached)
              .map((n) => n.id),
          },
        },
      ]);
      write(1, { tick: 1, status: [[root, "running"]] });
      expect(await runtime.step(10)).toMatchObject({ root: "R", statuses: { [root]: "R" } });
      write(1, { tick: 2, since: 1, status: [[root, "success"]] });
      expect((await runtime.step(10)).root).toBe("S");
      // No new report: nothing changed.
      expect((await runtime.step(10)).root).toBe("S");
    });

    it("starts the trace over past a report it did not read", async () => {
      const { runtime, write, traceCalls, halts } = traced();
      await runtime.start(ORDER.loaded);
      write(1, { tick: 1, status: [[root, "running"]] });
      await runtime.step(10);
      write(1, { tick: 4, since: 3, status: [[root, "failure"]] });
      expect((await runtime.step(10)).root).toBe("R");
      expect(traceCalls()).toHaveLength(2);
      expect(halts()).toEqual([JSON.stringify({ halt: 1 })]);
      write(2, { tick: 5, status: [[root, "failure"]] });
      expect((await runtime.step(10)).root).toBe("F");
    });

    it("starts the trace over when an edit changes the nodes it watches", async () => {
      const { runtime, traceCalls } = traced();
      await runtime.start(ORDER.loaded);
      await runtime.edit({ remove: ["n"] }, ORDER.loaded);
      expect(traceCalls()).toHaveLength(1);
      await runtime.edit({ remove: ["n"] }, GREET.loaded);
      expect(traceCalls()).toHaveLength(2);
    });

    it("follows the root and the nodes a diff sets when it is given no behavior", async () => {
      const { runtime, write } = traced();
      await runtime.start(ORDER.loaded);
      await runtime.edit({
        set: [{ id: "added", function: "f" }],
        root: "added",
      });
      write(1, {
        tick: 1,
        status: [
          ["added", "failure"],
          [root, "running"],
        ],
      });
      const report = await runtime.step(10);
      expect(report.root).toBe("F");
      expect(report.statuses).toMatchObject({ added: "F", [root]: "R" });
      await runtime.edit({ remove: ["added"] });
      write(1, { tick: 2, since: 1 });
      expect((await runtime.step(10)).root).toBeUndefined();
    });

    it("watches the nodes an empty diff names anew, sending the device no edit", async () => {
      const { device, runtime, traceCalls } = traced();
      await runtime.start(ORDER.loaded);
      const calls = device.calls.length;
      const renamed = {
        ...ORDER.loaded,
        nodes: ORDER.loaded.nodes.map((n) =>
          n.attached ? { ...n, name: n.name ?? `n${n.path}` } : n,
        ),
      };
      await runtime.edit({}, renamed);
      expect(traceCalls()).toHaveLength(2);
      expect(device.calls.slice(calls).some((c) => c.includes('"edit"'))).toBe(false);
    });

    it("halts the trace when the behavior stops", async () => {
      const { device, runtime } = traced();
      await runtime.start(ORDER.loaded);
      await runtime.stop();
      expect(device.calls.slice(-2)).toEqual([
        JSON.stringify({ halt: 1 }),
        JSON.stringify({ load: true }),
      ]);
    });

    it("reports the store alone where the device does not trace", async () => {
      const { runtime } = traced(true);
      await runtime.start(ORDER.loaded);
      const report = await runtime.step(10);
      expect(report.tick).toBe(1);
      expect(report.statuses).toBeUndefined();
    });
  });
});
