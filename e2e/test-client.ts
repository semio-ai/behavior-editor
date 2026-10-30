import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Value } from "../src/model/value";
import { REVISION_KEY, type DeviceSession } from "../src/session/device-session";
import type { BehaviorText, Loaded } from "../src/text/language";
import { createBehaviorText } from "../src/text/wasm-language";
import { connectWebSocket } from "../src/websocket";
import initBehaviorText, * as behaviorText from "./behavior-text.mjs";

let loading: Promise<BehaviorText> | undefined;

/** The language service over the package's wasm build (`npm run build:wasm`), initialized once. */
function loadLanguage(): Promise<BehaviorText> {
  loading ??= readFile(join(__dirname, "..", "wasm", "pkg", "behavior_text_bg.wasm")).then(
    async (wasm) => {
      await initBehaviorText({ module_or_path: wasm });
      return createBehaviorText(behaviorText);
    },
  );
  return loading;
}

/**
 * The test's own client of the native device, on the bridge the editor does
 * not use: to set the device up, to change it as another client would, and
 * to read what it runs and holds.
 */
export interface TestClient {
  session: DeviceSession;
  language: BehaviorText;
  /** `text` resolved against the device's functions; it must resolve. */
  resolve(text: string): Promise<Loaded>;
  /** The device's behavior revision. */
  revision(): Promise<number>;
  /** The number `key` holds. */
  number(key: string): Promise<number>;
  close(): Promise<void>;
}

/** The number a value holds, whatever its width. */
function numberOf(value: Value | null, key: string): number {
  if (value && typeof value === "object") {
    for (const n of Object.values(value)) {
      if (typeof n === "number") return n;
      if (typeof n === "string" && /^-?\d+$/.test(n)) return Number(n);
    }
  }
  throw new Error(`${key} holds no number: ${JSON.stringify(value)}`);
}

/** Connect to the device's second bridge, as another client of the editor's device. */
export async function testClient(): Promise<TestClient> {
  const url = process.env.E2E_TEST_URL;
  if (!url) throw new Error("E2E_TEST_URL is unset: the global setup starts the device");
  const language = await loadLanguage();
  const session = connectWebSocket(url, { language, reconnect: false });
  await new Promise<void>((resolve, reject) => {
    const settle = () => {
      const { state } = session;
      if (state.status === "connected") resolve();
      else if (state.status === "closed") reject(new Error(`the test client did not connect: ${state.reason}`));
    };
    session.on("state", settle);
    settle();
  });
  return {
    session,
    language,
    async resolve(text) {
      const loaded = language.resolve(language.parse(text).document, await session.functions());
      const errors = loaded.diagnostics.filter((d) => d.severity === "error");
      if (errors.length) throw new Error(errors.map((d) => d.message).join("; "));
      return loaded;
    },
    revision: async () => numberOf(await session.read(REVISION_KEY), REVISION_KEY),
    number: async (key) => numberOf(await session.read(key), key),
    close: () => session.close(),
  };
}
