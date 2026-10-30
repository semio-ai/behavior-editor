import { describe, expect, it } from "vitest";
import { ORDER } from "../../fixtures/examples";
import type { Graph, GraphDiff } from "../model/graph";
import type { Value } from "../model/value";
import { type AroraDevice, DeviceRuntime } from "./device-runtime";
import { MATH, mathModule } from "./math-module";

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
    const report = await runtime.step(33);
    expect(report.tick).toBe(1);
    expect(report.root).toBeUndefined();
    expect(report.statuses).toBeUndefined();
    expect(report.changes).toEqual([
      { key: "v", value: { f64: 1 } },
      { key: "gone", value: null },
    ]);
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
});
