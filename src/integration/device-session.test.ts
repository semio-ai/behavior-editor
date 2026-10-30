import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import initDataflowDevice, { DataflowDevice } from "../../device/pkg/dataflow_device.js";
import { DATAFLOW } from "../../fixtures/examples";
import { loadLanguage } from "../../fixtures/language";
import { type Value, valueNumber } from "../model/value";
import { type BehaviorChange, DeviceSession, type SessionTick } from "../session/device-session";
import { PageBridge } from "../local-arora/page-bridge";
import type { BehaviorText, Loaded } from "../text/language";

/**
 * A session over a real Arora runtime: `device/`'s arora-web device in the
 * page, running itself every 20 ms behind a `PageBridge`, the language from
 * the editor's wasm build: the session reads the behavior the device runs
 * and its revision, runs, edits and follows it, tells another client's
 * change, and leaves it running.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const NAMESPACE = "P";

let language: BehaviorText;
let text: string;
beforeAll(async () => {
  await initDataflowDevice({
    module_or_path: await readFile(join(root, "device", "pkg", "dataflow_device_bg.wasm")),
  });
  language = await loadLanguage();
  text = DATAFLOW.text;
});

let device: DataflowDevice;
let session: DeviceSession;
afterEach(async () => {
  await session.close();
  device.free();
});

/** The file, resolved against the device's functions. */
async function resolved(): Promise<Loaded> {
  return language.resolve(language.parse(text).document, await session.functions());
}

async function until(check: () => boolean, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function connect() {
  device = new DataflowDevice(NAMESPACE, JSON.stringify(DATAFLOW.inputs));
  device.update(JSON.stringify(DATAFLOW.values));
  session = new DeviceSession(new PageBridge(device, { namespace: NAMESPACE, periodMs: 20 }), {
    language,
    rate: 50,
  });
  const ticks: SessionTick[] = [];
  const changes: BehaviorChange[] = [];
  session.on("tick", (tick) => ticks.push(tick));
  session.on("behaviorChanged", (change) => changes.push(change));
  return { ticks, changes };
}

describe("a device session on an Arora device in the page", () => {
  it("runs the file, follows the device's nodes and tick, and leaves it running as it closes", async () => {
    const { ticks, changes } = connect();
    await until(() => session.state.status === "connected");
    expect(await session.deviceBehavior()).toEqual({ graph: {}, revision: 0 });
    const loaded = await resolved();
    await session.run(loaded);
    const read = (await session.deviceBehavior())!;
    expect(read.revision).toBe(1);
    expect(language.diff(read.graph, loaded.graph)).toEqual({});
    await until(() => ticks.at(-1)?.report.root === "R");
    const last = ticks.at(-1)!;
    expect(last.status.rate).toBeCloseTo(50, 0);
    const tick = last.status.tick!;
    await until(() => ticks.at(-1)!.status.tick! > tick + 2);
    /** Whether the level the session last saw is `n`, as an f32 holds it. */
    const level = (n: number) =>
      Math.abs(
        (valueNumber(
        ticks
          .flatMap((t) => t.report.changes)
          .filter((c) => c.key === "face/level")
          .at(-1)?.value,
        ) ?? NaN) - n,
      ) < 1e-3;
    await until(() => level(31));

    // An edit reaches the behavior running.
    const edited = language.resolve(
      language.parse(text.replace("operand_1: 1f32)", "operand_1: 2f32)")).document,
      await session.functions(),
    );
    await session.edit(language.diff(loaded.graph, edited.graph), edited);
    await until(() => level(32));

    // A key the device keeps closed to clients is refused, as the device checks it.
    await expect(session.write("face/level", { f32: 1 })).rejects.toThrow();
    await session.write("sensor/distance", { f32: 0.2 });

    await until(() => ticks.at(-1)?.status.revision === 2);
    expect(changes.every((c) => !c.external)).toBe(true);

    // Another client loads the empty behavior: the session tells it was not its own.
    device.call(language.loadCall({}));
    await until(() => changes.some((c) => c.external));
    expect(changes.at(-1)).toEqual({ revision: 3, external: true });
    await session.run(edited);

    await session.close();
    // Closed, the device runs the behavior still: a step moves its level with its input.
    device.update(JSON.stringify({ "sensor/distance": { f32: 0.1 } }));
    device.step(20);
    device.step(20);
    expect(valueNumber(JSON.parse(device.read(`${NAMESPACE}/face/level`)) as Value)).toBeCloseTo(12, 3);
  });
});
