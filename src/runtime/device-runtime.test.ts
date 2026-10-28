import { describe, expect, it } from "vitest";
import { ORDER } from "../../fixtures/examples";
import type { Graph } from "../model/graph";
import type { Value } from "../model/value";
import { type AroraDevice, DeviceRuntime } from "./device-runtime";
import { MATH, mathModule } from "./math-module";
import * as N from "./natives";

const status = (variant: string): Value => ({
  enum: { id: N.STATUS_ENUMERATION, variant_id: variant, value: "unit" },
});

/**
 * A device whose store is a map of device-relative keys, as `StudioAroraWorld`
 * bound to the device `robot` would present it. An update is queued until the
 * next step, and a step runs `onStep`, the device's own behavior.
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
  listKeys() {
    return JSON.stringify([...this.store.keys()].sort().map((key) => [key, {}]));
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
  const spawned: Graph[] = [];
  const runtime = new DeviceRuntime({
    device,
    deviceId: "robot",
    spawnGraphCall: (graph) => {
      spawned.push(graph);
      return JSON.stringify({ module_id: "interpreter", id: "spawn_graph", args: [] });
    },
    taskHandle: (result) => {
      const run = (JSON.parse(result) as { ret: { str: string } }).ret.str;
      return { stop: JSON.stringify({ halt: run }), status: `tasks/${run}/status` };
    },
  });
  return { device, runtime, spawned };
}

describe("DeviceRuntime", () => {
  it("lists the device's functions as it describes them", async () => {
    const { runtime } = setup();
    const names = (await runtime.functions()).map((f) => f.name);
    expect(names).toContain("damp");
    expect((await runtime.functions()).find((f) => f.name === "add")?.id).toBe(MATH.add.id);
  });

  it("starts a behavior through the device's call path", async () => {
    const { device, runtime, spawned } = setup();
    await runtime.start(ORDER.loaded);
    expect(spawned).toEqual([ORDER.loaded.graph]);
    expect(device.calls).toEqual([
      JSON.stringify({ module_id: "interpreter", id: "spawn_graph", args: [] }),
    ]);
  });

  it("reports the run's status and what each step changed", async () => {
    const { device, runtime } = setup();
    device.store.set("v", { f64: 0 });
    device.store.set("gone", { bool: true });
    await runtime.start(ORDER.loaded);
    device.onStep = (store) => {
      store.set("v", { f64: 1 });
      store.delete("gone");
      store.set("tasks/run 1/status", status(N.STATUS_RUNNING));
    };
    const report = await runtime.step(33);
    expect(report.tick).toBe(1);
    expect(report.root).toBe("R");
    expect(report.statuses).toBeUndefined();
    expect(report.changes).toEqual([
      { key: "tasks/run 1/status", value: status(N.STATUS_RUNNING) },
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
    expect(await runtime.keys()).toEqual(["face/smile"]);
  });

  it("stops the run with the call its handle names", async () => {
    const { device, runtime } = setup();
    await runtime.start(ORDER.loaded);
    await runtime.stop();
    expect(device.calls.at(-1)).toBe(JSON.stringify({ halt: "run 1" }));
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
