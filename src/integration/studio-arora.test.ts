import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import initStudioArora, { StudioAroraWorld } from "@semio/studio-arora";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadLanguage } from "../../fixtures/language";
import type { MethodSignature } from "../model/signature";
import { type Value, valueNumber, valueString } from "../model/value";
import { type AroraDevice, DeviceRuntime } from "../runtime/device-runtime";
import type { BehaviorText, Loaded } from "../text/language";

/**
 * The editor's behavior on a real Arora runtime: an emulated device of
 * `@semio/studio-arora`'s World, which carries `@arora/dataflow`, driven
 * through `DeviceRuntime` with the language from the editor's wasm build. Both
 * wasm builds are read from disk (`npm run build -w @semio/studio-arora`,
 * `npm run build:wasm` here); a missing build fails here rather than skipping.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repository = join(here, "..", "..", "..", "..");
const FILE = join(here, "..", "..", "fixtures", "devices", "dataflow.bt");
const DEVICE = "D";
const DT_MS = 20;

let language: BehaviorText;
let text: string;

beforeAll(async () => {
  await initStudioArora({
    module_or_path: await readFile(
      join(repository, "packages", "studio-arora", "pkg", "studio_arora_bg.wasm"),
    ),
  });
  language = await loadLanguage();
  text = await readFile(FILE, "utf8");
});

let world: StudioAroraWorld;
let runtime: DeviceRuntime;

/** The World's methods bound to the device `DEVICE`, as `DeviceRuntime` takes a device. */
function bound(target: StudioAroraWorld): AroraDevice {
  return {
    describeMethods: (prefix) => target.describeMethods(DEVICE, prefix),
    call: (callJson) => target.call(DEVICE, callJson),
    update: (changesJson) => target.update(DEVICE, changesJson),
    read: (key) => target.read(key),
    listKeys: (prefix) => target.listKeys(DEVICE, prefix),
    step: (dtMs) => target.step(dtMs),
  };
}

beforeEach(() => {
  world = new StudioAroraWorld();
  world.spawnEntity("E", "[]");
  world.attachEmulated("E", DEVICE);
  // A key written from outside the device is one its meta opens, of its type.
  for (const key of ["sensor/distance", "face/smile_target"]) {
    world.setMeta(DEVICE, key, JSON.stringify({ ty: "f32", editable: true }));
  }
  runtime = new DeviceRuntime({
    device: bound(world),
    deviceId: DEVICE,
    loadCall: (graph) => language.loadCall(graph),
  });
});

afterEach(() => {
  world.dispose();
  world.free();
});

/** The file resolved against the device's functions. */
async function resolved(): Promise<{ loaded: Loaded; functions: MethodSignature[] }> {
  const functions = await runtime.functions();
  const parsed = language.parse(text);
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

describe("a behavior file on an emulated studio-arora device", () => {
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
    expect(language.format(language.parse(text).document, functions)).toBe(text);
  });

  it("runs on the device: conditions, a cascade, the clock and a stateful node", async () => {
    const { loaded } = await resolved();
    await runtime.start(loaded);

    // Near: the condition holds, and the cascade gives clamp(100 d, 0, 50) + 1.
    await step({ "sensor/distance": f32(0.3), "face/smile_target": f32(1) });
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
});
