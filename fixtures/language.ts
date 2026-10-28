/**
 * The language service over the package's wasm build, for tests in Node: the
 * build is read from `wasm/pkg` (`npm run build:wasm`), and a missing build
 * fails here rather than skipping.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mathModule } from "../src/runtime/math-module";
import { type WasmBehaviorText, createBehaviorText } from "../src/text/wasm-language";
import initBehaviorText, * as behaviorText from "../wasm/pkg/behavior_text.js";

const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "wasm", "pkg");

let loading: Promise<WasmBehaviorText> | undefined;

/** The language service, its wasm initialized once. */
export function loadLanguage(): Promise<WasmBehaviorText> {
  loading ??= readFile(join(pkg, "behavior_text_bg.wasm")).then(async (wasm) => {
    await initBehaviorText({ module_or_path: wasm });
    return createBehaviorText(behaviorText);
  });
  return loading;
}

/** The mock device's functions, as its `functions()` lists them. */
export const MATH_FUNCTIONS = mathModule().functions.map((f) => f.signature);
