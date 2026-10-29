import type { Graph } from "../model/graph";
import type { MethodSignature } from "../model/signature";
import { holdsExactly } from "../model/value";
import type { BehaviorDocument } from "./ast";
import type { BehaviorText, Diagnostic, Loaded, ParseResult } from "./language";

/**
 * The exports of the package's wasm build, `@semio/behavior-editor/wasm`,
 * once initialized: `arora-behavior-tree`'s text module, JSON in and out.
 */
export interface BehaviorTextExports {
  parse(text: string): string;
  format(parsedJson: string, functionsJson: string): string;
  resolve(documentJson: string, functionsJson: string): string;
  natives(): string;
  loadCall(graphJson: string): string;
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
export function createBehaviorText(exports: BehaviorTextExports): BehaviorText {
  let natives: MethodSignature[] | undefined;
  return {
    parse: (text) => JSON.parse(exports.parse(text)) as ParseResult,
    format: (parsed: ParseResult, functions: MethodSignature[]) => {
      try {
        return exports.format(JSON.stringify(parsed), JSON.stringify(functions));
      } catch (error) {
        // A refusal's message is the JSON of the diagnostics that refuse it.
        const refusal = error instanceof Error ? error.message : String(error);
        throw new Error(refusedBecause(refusal), { cause: error });
      }
    },
    resolve: (document: BehaviorDocument, functions: MethodSignature[]) =>
      refuseInexact(
        JSON.parse(exports.resolve(JSON.stringify(document), JSON.stringify(functions))) as Loaded,
      ),
    natives: () => (natives ??= JSON.parse(exports.natives()) as MethodSignature[]),
    loadCall: (graph: Graph) => exports.loadCall(JSON.stringify(graph)),
  };
}

/**
 * `loaded`, with an error for each literal holding a 64-bit integer the
 * decoded graph no longer holds exactly: the behavior does not run rather
 * than run on a rounded value. Its text keeps the digits as written.
 */
function refuseInexact(loaded: Loaded): Loaded {
  const spans = new Map(loaded.nodes.map((n) => [n.id, n.span]));
  const inexact = loaded.graph.links.flatMap((link) =>
    "literal" in link.source && !holdsExactly(link.source.literal)
      ? [
          {
            severity: "error" as const,
            message:
              "This 64-bit integer is past ±9007199254740991, which the editor cannot hold exactly",
            span: spans.get(link.target.node) ?? { start: 0, end: 0, line: 1, column: 1 },
          },
        ]
      : [],
  );
  return inexact.length ? { ...loaded, diagnostics: [...loaded.diagnostics, ...inexact] } : loaded;
}

/** What a refusal to format says, from the JSON of its diagnostics. */
function refusedBecause(refusal: string): string {
  try {
    const diagnostics = JSON.parse(refusal) as Diagnostic[];
    return `The document cannot be written: ${diagnostics.map((d) => d.message).join("; ")}`;
  } catch {
    return refusal;
  }
}
