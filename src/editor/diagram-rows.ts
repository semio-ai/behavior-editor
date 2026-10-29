import { type NodePath, walk } from "../model/edit";
import { orderedParameters } from "../model/signature";
import * as N from "../runtime/natives";
import type { BehaviorDocument, SourceNode, Span } from "../text/ast";
import type { LoadedNode } from "../text/language";
import { expressionText, functionText, portsRead } from "./expression-text";
import {
  type FunctionEntry,
  type FunctionIndex,
  type NodeShape,
  controlGlyph,
  nodeShape,
} from "./functions";

/** An output an argument reads: the producing row, and which of its outputs. */
export interface DiagramSource {
  key: string;
  output: string;
}

/** One argument line of a node: the parameter, what it reads, and the outputs it reads. */
export interface DiagramPort {
  name: string;
  text: string;
  /** The outputs of other rows this argument reads. */
  sources: DiagramSource[];
}

/**
 * One output of a node: its return value `_ret`, or a parameter the function
 * writes back. `text` is the store key or variable the output is written to,
 * when the node binds one.
 */
export interface DiagramOutput {
  name: string;
  text: string;
}

/** A node of the document as the diagram draws it. */
export interface DiagramRow {
  /** The node's path, joined by dots: stable while the tree is. */
  key: string;
  path: NodePath;
  node: SourceNode;
  entry: FunctionEntry | undefined;
  /** Its depth under the root; a detached node's is 0. */
  depth: number;
  parentKey: string | null;
  childKeys: string[];
  /** Every row under it, at any depth. */
  descendantKeys: string[];
  shape: NodeShape;
  glyph: string;
  title: string;
  ports: DiagramPort[];
  outputs: DiagramOutput[];
  /** Its graph node, when the document resolved. */
  graphId: string | null;
  /** Whether no node holds it: a top-level node after the root. */
  detached: boolean;
}

export const rowKey = (path: NodePath) => path.join(".");

const sameSpan = (a: Span, b: Span) => a.start === b.start && a.end === b.end;

/**
 * The rows of `document`, in file order: the tree from its root, then the
 * detached nodes. `loaded` gives each row its graph node, matched by span.
 */
export function diagramRows(
  document: BehaviorDocument,
  functions: FunctionIndex,
  loaded: readonly LoadedNode[],
): DiagramRow[] {
  const nodes = walk(document);
  const producers = new Map<string, string>();
  for (const { node, path } of nodes) if (node.name) producers.set(node.name.text, rowKey(path));
  const rows = new Map<string, DiagramRow>();
  for (const { node, path } of nodes) {
    const key = rowKey(path);
    const detached = path[0]! > 0;
    const entry = functions.lookup(node.call.function);
    const shape = nodeShape(entry, node.children.length > 0, !detached);
    const parentKey = path.length > 1 ? rowKey(path.slice(0, -1)) : null;
    const name = node.name ? `${node.name.text}: ` : "";
    const target = node.target ? `${expressionText(node.target)} = ` : "";
    rows.set(key, {
      key,
      path,
      node,
      entry,
      depth: path.length - 1,
      parentKey,
      childKeys: node.children.map((_, i) => rowKey([...path, i])),
      descendantKeys: [],
      shape,
      glyph: shape === "control" ? controlGlyph(entry) : "",
      title: `${name}${target}${functionText(node.call.function)}`,
      ports: ports(node, entry, producers),
      outputs: outputs(node, entry),
      graphId:
        loaded.find((l) => sameSpan(l.span, node.span) && l.name === (node.name?.text ?? null))
          ?.id ?? null,
      detached,
    });
  }
  for (const row of rows.values()) {
    for (let parent = row.parentKey; parent !== null; parent = rows.get(parent)!.parentKey) {
      rows.get(parent)!.descendantKeys.push(row.key);
    }
  }
  return [...rows.values()];
}

/**
 * One port per argument written: the function's parameters in declared order,
 * then any argument the function does not take. A parameter left out has no
 * port; the inspector lists it.
 */
function ports(
  node: SourceNode,
  entry: FunctionEntry | undefined,
  producers: ReadonlyMap<string, string>,
): DiagramPort[] {
  const params = entry
    ? orderedParameters(entry.signature.function).map((p) => p.parameter.name)
    : [];
  const written = node.call.arguments.map((a) => a.name.text);
  const names = [
    ...params.filter((n) => written.includes(n)),
    ...written.filter((n) => !params.includes(n)),
  ];
  return names.map((name) => {
    const { value } = node.call.arguments.find((a) => a.name.text === name)!;
    return {
      name,
      text: expressionText(value),
      sources: portsRead(value).flatMap(({ node: n, port }) => {
        const key = producers.get(n);
        return key === undefined ? [] : [{ key, output: port }];
      }),
    };
  });
}

/** The name the language gives a node's return value. */
export const RET = "_ret";

/**
 * A node's outputs: `_ret` when the node binds it, can be read by name, or
 * returns a value that is not a status (a status shows as the node's pill),
 * then each parameter the function writes back, in declared order.
 */
function outputs(node: SourceNode, entry: FunctionEntry | undefined): DiagramOutput[] {
  const fn = entry?.signature.function;
  const returns = fn?.returnType;
  const returnsData =
    returns !== undefined &&
    !(returns.type === "primitive" && returns.value.kind === "unit") &&
    !(returns.type === "frozenScalar" && returns.value.reference.id === N.STATUS_ENUMERATION);
  const ret =
    node.target !== null || node.name !== null || returnsData
      ? [{ name: RET, text: node.target ? expressionText(node.target) : "" }]
      : [];
  const written = fn
    ? orderedParameters(fn)
        .filter((p) => p.parameter.mutable)
        .map((p) => ({ name: p.parameter.name, text: "" }))
    : [];
  return [...ret, ...written];
}
