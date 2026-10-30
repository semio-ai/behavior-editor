/**
 * The local Arora for tests in Node: its device's wasm build read from
 * `device/pkg` (`npm run build:device`), and the language's from `wasm/pkg`.
 * A missing build fails here rather than skipping.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import initDevice, * as deviceModule from "../device/pkg/dataflow_device.js";
import type { MethodSignature } from "../src/model/signature";
import {
  type DeviceModule,
  type LocalAroraOptions,
  createLocalArora,
} from "../src/local-arora/local-arora";
import type { DeviceSession, SessionTick } from "../src/session/device-session";
import type { Loaded } from "../src/text/language";
import type { Example } from "./examples";
import { loadLanguage } from "./language";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "device", "pkg");

let loading: Promise<DeviceModule> | undefined;

/** The local Arora's device module, its wasm initialized once. */
export function loadDevice(): Promise<DeviceModule> {
  loading ??= readFile(join(pkg, "dataflow_device_bg.wasm")).then(async (wasm) => {
    await initDevice({ module_or_path: wasm });
    return deviceModule;
  });
  return loading;
}

/**
 * A local Arora seeded as `example` is, or as `options` say, once its session
 * is connected; paused unless `options.playing` says otherwise, so a test
 * steps it.
 */
export async function localArora(
  example?: Example | LocalAroraOptions,
  options: LocalAroraOptions = {},
): Promise<DeviceSession> {
  const [device, language] = await Promise.all([loadDevice(), loadLanguage()]);
  const seeded =
    example && "text" in example ? { inputs: example.inputs, values: example.values } : example;
  const session = createLocalArora(device, language, { playing: false, ...seeded, ...options });
  await new Promise<void>((resolve, reject) => {
    const settle = () => {
      const { state } = session;
      if (state.status === "connected") resolve();
      else if (state.status === "closed") reject(new Error(`the local Arora did not connect: ${state.reason}`));
    };
    session.on("state", settle);
    settle();
  });
  return session;
}

/** Step a local Arora once, and what the session followed of the step. */
export async function stepped(session: DeviceSession): Promise<SessionTick> {
  let ticked: SessionTick | undefined;
  const stop = session.on("tick", (tick) => (ticked = tick));
  try {
    await session.step();
  } finally {
    stop();
  }
  if (!ticked) throw new Error("the step told no tick");
  return ticked;
}

/** The functions of the local Arora's device: `@arora/dataflow`'s. */
async function dataflowFunctions(): Promise<MethodSignature[]> {
  const device = await loadDevice();
  const made = new device.DataflowDevice("functions", "{}");
  try {
    return JSON.parse(made.describeMethods()) as MethodSignature[];
  } finally {
    made.free();
  }
}

/** `@arora/dataflow`'s functions, as the local Arora and any dataflow device list them. */
export const DATAFLOW_FUNCTIONS = await dataflowFunctions();

/** `text`, or an example's, resolved against `@arora/dataflow`'s functions; it must resolve. */
export async function loadedOf(text: string | Example): Promise<Loaded> {
  const language = await loadLanguage();
  const source = typeof text === "string" ? text : text.text;
  const loaded = language.resolve(language.parse(source).document, DATAFLOW_FUNCTIONS);
  const errors = loaded.diagnostics.filter((d) => d.severity === "error");
  if (errors.length) throw new Error(errors.map((d) => d.message).join("; "));
  return loaded;
}
