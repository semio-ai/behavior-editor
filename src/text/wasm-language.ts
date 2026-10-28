import type { Graph } from "../model/graph";
import type { MethodSignature } from "../model/signature";
import type { TaskHandle } from "../runtime/device-runtime";
import type { BehaviorDocument } from "./ast";
import type { BehaviorText, Loaded, ParseResult } from "./language";

/**
 * The exports of the package's wasm build, `@semio/behavior-editor/wasm`,
 * once initialized: `arora-behavior-tree`'s text module, JSON in and out.
 */
export interface BehaviorTextExports {
  parse(text: string): string;
  format(documentJson: string, functionsJson: string): string;
  resolve(documentJson: string, functionsJson: string): string;
  natives(): string;
  spawnGraphCall(graphJson: string): string;
  taskHandle(callResultJson: string): string;
}

/** The language service over the wasm build, and the run a device's spawn call answers. */
export interface WasmBehaviorText extends BehaviorText {
  /** The run a `spawnGraphCall`'s `CallResult` JSON describes: what `DeviceRuntime` takes. */
  taskHandle(callResultJson: string): TaskHandle;
}

/**
 * The language service over the initialized wasm `exports`:
 *
 * ```ts
 * import initBehaviorText, * as behaviorText from "@semio/behavior-editor/wasm";
 * await initBehaviorText();
 * const language = createBehaviorText(behaviorText);
 * ```
 */
export function createBehaviorText(exports: BehaviorTextExports): WasmBehaviorText {
  let natives: MethodSignature[] | undefined;
  return {
    parse: (text) => JSON.parse(exports.parse(text)) as ParseResult,
    format: (document: BehaviorDocument, functions: MethodSignature[]) =>
      exports.format(JSON.stringify(document), JSON.stringify(functions)),
    resolve: (document: BehaviorDocument, functions: MethodSignature[]) =>
      JSON.parse(exports.resolve(JSON.stringify(document), JSON.stringify(functions))) as Loaded,
    natives: () => (natives ??= JSON.parse(exports.natives()) as MethodSignature[]),
    spawnGraphCall: (graph: Graph) => exports.spawnGraphCall(JSON.stringify(graph)),
    taskHandle: (callResultJson) => JSON.parse(exports.taskHandle(callResultJson)) as TaskHandle,
  };
}
