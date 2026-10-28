import type { MethodSignature } from "../model/signature";
import * as N from "../runtime/natives";
import { functionName } from "../model/edit";
import type { FunctionName } from "../text/ast";

/** A function the palette offers and a node may call. */
export interface FunctionEntry {
  signature: MethodSignature;
  native: boolean;
  /** The group the palette lists it under. */
  group: string;
  /**
   * How a node names it: bare, or `<module id>::name` when a native or
   * another module has the name too.
   */
  name: FunctionName;
}

/** The functions a behavior may call: the natives, then each module's. */
export interface FunctionIndex {
  entries: FunctionEntry[];
  /** The function a node's name refers to, as the resolver finds it. */
  lookup(name: FunctionName): FunctionEntry | undefined;
}

const NATIVE_GROUP = "Behavior tree";

/**
 * The index of `natives` and `functions`, the modules' listed under the
 * names `moduleNames` gives their ids. A name is a native's when a native has
 * it; otherwise a module function's, told apart by its module's id when two
 * modules have it.
 */
export function functionIndex(
  natives: readonly MethodSignature[],
  functions: readonly MethodSignature[],
  moduleNames: Readonly<Record<string, string>> = {},
): FunctionIndex {
  const count = new Map<string, number>();
  for (const signature of [...natives, ...functions]) {
    count.set(signature.name, (count.get(signature.name) ?? 0) + 1);
  }
  const entries: FunctionEntry[] = [
    ...natives.map((signature) => ({
      signature,
      native: true,
      group: NATIVE_GROUP,
      name: functionName(signature.name),
    })),
    ...functions.map((signature) => {
      const name = functionName(signature.name);
      return {
        signature,
        native: false,
        group: moduleNames[signature.module_id] ?? signature.module_id,
        name:
          count.get(signature.name)! > 1
            ? { ...name, module: { span: name.span, text: signature.module_id } }
            : name,
      };
    }),
  ];
  return {
    entries,
    lookup(name) {
      const named = entries.filter((e) => e.signature.name === name.name.text);
      if (name.module === null) {
        return named.find((e) => e.native) ?? (named.length === 1 ? named[0] : undefined);
      }
      return named.find((e) => !e.native && e.signature.module_id === name.module!.text);
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
