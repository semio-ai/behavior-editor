import type { MethodSignature } from "../model/signature";
import * as N from "../runtime/natives";
import type { FunctionName } from "../text/ast";

/** A function the palette offers and a node may call. */
export interface FunctionEntry {
  signature: MethodSignature;
  native: boolean;
  /** The group the palette lists it under. */
  group: string;
  /** How a node names it: bare, or `module::name` when another module has the name too. */
  name: FunctionName;
}

/** The functions a behavior may call: the natives, then each module's. */
export interface FunctionIndex {
  entries: FunctionEntry[];
  /** The function a node's name refers to, when exactly one has it. */
  lookup(name: FunctionName): FunctionEntry | undefined;
}

const NATIVE_GROUP = "Behavior tree";

/**
 * The index of `natives` and `functions`, the modules' named after
 * `moduleNames` where it names them.
 */
export function functionIndex(
  natives: readonly MethodSignature[],
  functions: readonly MethodSignature[],
  moduleNames: Readonly<Record<string, string>> = {},
): FunctionIndex {
  const moduleName = (id: string) => moduleNames[id] ?? id;
  const all = [
    ...natives.map((signature) => ({ signature, native: true })),
    ...functions.map((signature) => ({ signature, native: false })),
  ];
  const count = new Map<string, number>();
  for (const { signature } of all) count.set(signature.name, (count.get(signature.name) ?? 0) + 1);
  const entries: FunctionEntry[] = all.map(({ signature, native }) => ({
    signature,
    native,
    group: native ? NATIVE_GROUP : moduleName(signature.module_id),
    name: {
      module: count.get(signature.name)! > 1 ? moduleName(signature.module_id) : null,
      name: signature.name,
      span: { start: 0, end: 0, line: 0, column: 0 },
    },
  }));
  return {
    entries,
    lookup(name) {
      const found = entries.filter(
        (e) =>
          e.signature.name === name.name &&
          (name.module === null ||
            name.module === e.signature.module_id ||
            name.module === moduleNames[e.signature.module_id]),
      );
      return found.length === 1 ? found[0] : undefined;
    },
  };
}

/** How the diagram draws a node: what it does decides its shape. */
export type NodeShape = "control" | "condition" | "action" | "data";

const CONDITIONS = new Set([N.EQUAL, N.IS_STRING_SET, N.WAIT_STRING_SET, N.REGEX_MATCH]);

/** The shape of a node calling `entry`: a detached node is data. */
export function nodeShape(
  entry: FunctionEntry | undefined,
  hasChildren: boolean,
  attached: boolean,
): NodeShape {
  if (hasChildren || (entry && N.CONTROL_NODES.has(entry.signature.id))) return "control";
  if (!attached) return "data";
  return entry && CONDITIONS.has(entry.signature.id) ? "condition" : "action";
}

/** The glyph of a control node, as behavior-tree diagrams draw it. */
export function controlGlyph(entry: FunctionEntry | undefined): string {
  switch (entry?.signature.id) {
    case N.SEQUENCE:
      return "→";
    case N.SEQUENCE_STAR:
      return "→*";
    case N.FALLBACK:
      return "?";
    case N.PARALLEL:
      return "⇉";
    default:
      return "◇";
  }
}

/** Whether a node calling `entry` holds children. */
export function holdsChildren(entry: FunctionEntry | undefined): boolean {
  return !!entry && N.CONTROL_NODES.has(entry.signature.id);
}
