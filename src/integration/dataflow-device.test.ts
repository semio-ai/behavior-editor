import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import initDataflowDevice, { DataflowDevice } from "../../device/pkg/dataflow_device.js";
import { DATAFLOW_INPUTS } from "../../fixtures/devices/dataflow";
import { loadLanguage } from "../../fixtures/language";
import type { MethodSignature } from "../model/signature";
import { type Value, valueNumber, valueString } from "../model/value";
import { DeviceRuntime } from "../runtime/device-runtime";
import type { BehaviorText, Loaded } from "../text/language";

/**
 * The editor's behavior on a real Arora runtime: `DataflowDevice`, arora-web's
 * browser device over arora's runtime with `@arora/dataflow` as a host module,
 * built from crates.io by `device/`, driven through `DeviceRuntime` with the
 * language from the editor's wasm build. Both wasm builds are read from disk
 * (`npm run build:device`, `npm run build:wasm`); a missing build fails here
 * rather than skipping.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const FILE = join(root, "fixtures", "devices", "dataflow.bt");
const NAMESPACE = "D";
const DT_MS = 20;

let language: BehaviorText;
let text: string;

beforeAll(async () => {
  await initDataflowDevice({
    module_or_path: await readFile(join(root, "device", "pkg", "dataflow_device_bg.wasm")),
  });
  language = await loadLanguage();
  text = await readFile(FILE, "utf8");
});

let device: DataflowDevice;
let runtime: DeviceRuntime;

beforeEach(() => {
  device = new DataflowDevice(NAMESPACE, JSON.stringify(DATAFLOW_INPUTS));
  runtime = new DeviceRuntime({
    device,
    deviceId: NAMESPACE,
    loadCall: (graph) => language.loadCall(graph),
    editCall: (diff) => language.editCall(diff),
  });
});

afterEach(() => {
  device.free();
});

/** The file, or `edited`, resolved against the device's functions. */
async function resolved(
  edited: string = text,
): Promise<{ loaded: Loaded; functions: MethodSignature[] }> {
  const functions = await runtime.functions();
  const parsed = language.parse(edited);
  expect(parsed.diagnostics).toEqual([]);
  return { loaded: language.resolve(parsed.document, functions), functions };
}

const number = async (key: string) => valueNumber(await runtime.read(key));
const f32 = (n: number): Value => ({ f32: n });

/** Write `changes`, then step: a write reaches the device at its next step. */
async function step(changes: Record<string, Value> = {}) {
  for (const [key, value] of Object.entries(changes)) await runtime.write(key, value);
  return runtime.step(DT_MS);
}

describe("a behavior file on an Arora device carrying @arora/dataflow", () => {
  it("resolves against the device's own functions and the natives", async () => {
    const { loaded, functions } = await resolved();
    expect(loaded.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    for (const name of ["lessthan", "multiply", "clamp", "add", "oscillator", "damp"]) {
      expect(
        functions.some((f) => f.name === name),
        name,
      ).toBe(true);
    }
    expect(loaded.nodes.map((n) => n.name).filter(Boolean)).toEqual([
      "near",
      "raw",
      "cm",
      "level",
      "sway",
      "smile",
    ]);
  });

  it("formats as written: opened and saved again, the file is the same", async () => {
    const { functions } = await resolved();
    expect(language.format(language.parse(text), functions)).toBe(text);
  });

  it("runs on the device: conditions, a cascade, the clock and a stateful node", async () => {
    const { loaded } = await resolved();
    // The inputs hold their first values as the behavior starts: the step at a
    // zero dt that applies the load applies the writes before it, then ticks
    // the behavior once, so the smile starts at its target.
    await runtime.write("sensor/distance", f32(0.3));
    await runtime.write("face/smile_target", f32(1));
    await runtime.start(loaded);

    // Near: the condition holds, and the cascade gives clamp(100 d, 0, 50) + 1.
    await step();
    await step();
    expect(valueString(await runtime.read("face/mood"))).toBe("near");
    expect(await number("face/level")).toBeCloseTo(31, 4);

    // Far: the fallback's second branch, and the clamp's upper bound.
    await step({ "sensor/distance": f32(0.8) });
    await step();
    expect(valueString(await runtime.read("face/mood"))).toBe("far");
    expect(await number("face/level")).toBeCloseTo(51, 4);

    // Back near: the mood follows the distance across 0.5 both ways.
    await step({ "sensor/distance": f32(0.45) });
    await step();
    expect(valueString(await runtime.read("face/mood"))).toBe("near");
    expect(await number("face/level")).toBeCloseTo(46, 4);

    // The smile has met its first target; given another, it eases toward it
    // without passing it, while over a second and a half the 1 Hz wave of
    // amplitude 0.5 swings both ways.
    expect(await number("face/smile")).toBeCloseTo(1, 3);
    await runtime.write("face/smile_target", f32(0.2));
    const sway: number[] = [];
    const smile: number[] = [];
    for (let i = 0; i < 75; i++) {
      await step();
      sway.push((await number("rig/sway"))!);
      smile.push((await number("face/smile"))!);
    }
    expect(Math.max(...sway)).toBeGreaterThan(0.4);
    expect(Math.min(...sway)).toBeLessThan(-0.4);
    expect(Math.max(...sway.map(Math.abs))).toBeLessThanOrEqual(0.5 + 1e-6);
    for (let i = 1; i < smile.length; i++) {
      expect(smile[i]!).toBeLessThanOrEqual(smile[i - 1]!);
    }
    expect(smile[0]!).toBeLessThan(1);
    expect(smile[0]!).toBeGreaterThan(0.2);
    expect(smile.at(-1)!).toBeGreaterThanOrEqual(0.2);
    expect(smile.at(-1)!).toBeCloseTo(0.2, 2);
  });

  it("stops: once the empty graph is loaded, nothing writes the keys", async () => {
    const { loaded } = await resolved();
    await runtime.start(loaded);
    await step({ "sensor/distance": f32(0.3) });
    await step();
    expect(await number("face/level")).toBeCloseTo(31, 4);
    await runtime.stop();
    await step({ "sensor/distance": f32(0.8) });
    await step();
    expect(await number("face/level")).toBeCloseTo(31, 4);
    expect(valueString(await runtime.read("face/mood"))).toBe("near");
  });

  it("edits the behavior running: a damp keeps its state across an edit elsewhere, and restarts when the edit binds it", async () => {
    const { loaded } = await resolved();
    await runtime.write("sensor/distance", f32(0.3));
    await runtime.write("face/smile_target", f32(1));
    await runtime.start(loaded);
    await step();
    await step({ "face/smile_target": f32(0.2) });
    for (let i = 0; i < 4; i++) await step();
    const easing = (await number("face/smile"))!;
    expect(easing).toBeLessThan(0.9);
    expect(easing).toBeGreaterThan(0.3);

    // Another node's binding: only `level` restarts, and the smile eases on.
    const level = text.replace("operand_1: 1f32)", "operand_1: 2f32)");
    const elsewhere = language.diff(loaded.graph, (await resolved(level)).loaded.graph);
    expect(elsewhere.set).toBeUndefined();
    expect(elsewhere.bind?.length).toBe(1);
    await runtime.edit(elsewhere);
    await step();
    expect(await number("face/level")).toBeCloseTo(32, 4);
    const eased = (await number("face/smile"))!;
    expect(eased).toBeLessThan(easing);
    expect(eased).toBeGreaterThan(0.25);

    // The damp's own binding: it restarts, from its target.
    const halfLife = level.replace("param.half_life: 0.05f32", "param.half_life: 0.5f32");
    const smile = language.diff(
      (await resolved(level)).loaded.graph,
      (await resolved(halfLife)).loaded.graph,
    );
    expect(smile.bind?.map((b) => b.node)).toEqual([
      loaded.nodes.find((n) => n.name === "smile")!.id,
    ]);
    await runtime.edit(smile);
    await step();
    expect(await number("face/smile")).toBeCloseTo(0.2, 3);
  });

  it("shows its nodes through a trace: statuses, detached activity and the named nodes' values", async () => {
    const traced = new DeviceRuntime({
      device,
      deviceId: NAMESPACE,
      loadCall: (graph) => language.loadCall(graph),
      editCall: (diff) => language.editCall(diff),
      trace: language,
    });
    const { loaded } = await resolved();
    const id = (name: string) => loaded.nodes.find((n) => n.name === name)!.id;
    const path = (at: string) => loaded.nodes.find((n) => n.path === at)!.id;
    await traced.write("sensor/distance", f32(0.3));
    await traced.write("face/smile_target", f32(1));
    await traced.start(loaded);

    // Near: the sequence's branch holds, and the root runs on. The clock's
    // readers are called at each tick; the distance's, unchanged since the
    // load, answer from their cache.
    let report = await traced.step(DT_MS);
    expect(report.root).toBe("R");
    expect(report.statuses).toEqual({
      [path("root")]: "R",
      [path("root.0")]: "S",
      [path("root.0.0")]: "S",
      [path("root.0.0.0")]: "S",
      [path("root.0.0.1")]: "S",
      [path("root.1")]: "R",
    });
    expect(report.detached).toMatchObject({
      [id("sway")]: "called",
      [id("smile")]: "called",
      [id("near")]: "cached",
      [id("level")]: "cached",
    });
    expect(valueNumber(report.values?.[id("level")])).toBeCloseTo(31, 4);
    expect(report.values?.[id("near")]).toEqual({ bool: true });

    // Far: the sequence fails, the fallback's second branch succeeds, and the
    // distance's readers are called again.
    await traced.write("sensor/distance", f32(0.8));
    report = await traced.step(DT_MS);
    expect(report.statuses).toMatchObject({
      [path("root.0")]: "S",
      [path("root.0.0")]: "F",
      [path("root.0.0.0")]: "F",
      [path("root.0.1")]: "S",
    });
    expect(report.statuses).not.toHaveProperty(path("root.0.0.1"));
    expect(report.detached?.[id("near")]).toBe("called");
    expect(report.values?.[id("near")]).toEqual({ bool: false });
    expect(valueNumber(report.values?.[id("level")])).toBeCloseTo(51, 4);
    report = await traced.step(DT_MS);
    expect(report.detached?.[id("level")]).toBe("cached");

    // An edit of `level` restarts it, and the trace states it anew: the step
    // applying the edit called it, and the next answers from its cache.
    const edited = (await resolved(text.replace("operand_1: 1f32)", "operand_1: 2f32)"))).loaded;
    await traced.edit(language.diff(loaded.graph, edited.graph), edited);
    report = await traced.step(DT_MS);
    expect(valueNumber(report.values?.[id("level")])).toBeCloseTo(52, 4);
    expect(report.detached?.[id("level")]).toBe("cached");

    // Stopping halts the trace: its status leaves Running at the next tick,
    // and changes no more.
    const statusKeys = await runtime
      .keys()
      .then((keys) => keys.map((k) => k.key).filter((k) => k.endsWith("/status")));
    expect((await traced.keys()).filter((k) => k.key.startsWith("arora/tasks/"))).toEqual([]);
    expect(statusKeys).toHaveLength(1);
    const running = await traced.read(statusKeys[0]!);
    await traced.stop();
    await traced.step(DT_MS);
    const ended = await traced.read(statusKeys[0]!);
    expect(ended).not.toEqual(running);
    await traced.step(DT_MS);
    expect(await traced.read(statusKeys[0]!)).toEqual(ended);
  });
});
