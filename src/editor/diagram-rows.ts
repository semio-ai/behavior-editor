import { type NodePath, walk } from "../model/edit";
import { orderedParameters } from "../model/signature";
import * as N from "../runtime/natives";
import { nativeWrites } from "../runtime/natives";
import type { BehaviorDocument, SourceNode, Span } from "../text/ast";
import type { LoadedNode } from "../text/language";
import {
  expressionText,
  functionText,
  portsRead,
  variableName,
  variablesRead,
} from "./expression-text";
import {
  type FunctionEntry,
  type FunctionIndex,
  type NodeShape,
  controlGlyph,
  nodeShape,
} from "./functions";

/**
 * An output an argument reads: the producing row, and which of its outputs;
 * `via`, the key it goes through, when the argument reads a key the output is
 * written to rather than the output itself.
 */
export interface DiagramSource {
  key: string;
  output: string;
  via?: string;
}

/** One argument line of a node: the parameter, what it reads, and the outputs it reads. */
export interface DiagramPort {
  name: string;
  text: string;
  /** The outputs of other rows this argument reads. */
  sources: DiagramSource[];
  /** The key the argument is, when it is one whole: `{imu/gyro}`, `{.count}`. */
  key?: string;
}

/**
 * One output of a node: its return value `_ret`, or a parameter the function
 * writes back. `text` is the store key or variable the output is written to,
 * when the node binds one.
 */
export interface DiagramOutput {
  name: string;
  text: string;
  /** The key the output is written to, when it is one. */
  key?: string;
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
  const producers = new Map<string, Producer>();
  for (const { node, path } of nodes) {
    if (node.name) {
      producers.set(node.name.text, {
        key: rowKey(path),
        entry: functions.lookup(node.call.function),
      });
    }
  }
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
  linkKeys([...rows.values()]);
  return [...rows.values()];
}

/**
 * Give each argument reading a key the outputs written to it, as sources
 * through that key: a node reads what another wrote there. A node that both
 * reads and writes a key holds it, as its state: between two holders of one
 * key there is no link, each being the other's source: the key is a state
 * they share, which each names, not a flow from one to the other.
 */
function linkKeys(rows: readonly DiagramRow[]) {
  const writers = new Map<string, DiagramSource[]>();
  for (const row of rows) {
    for (const o of row.outputs) {
      if (o.key === undefined) continue;
      writers.set(o.key, [...(writers.get(o.key) ?? []), { key: row.key, output: o.name }]);
    }
  }
  if (!writers.size) return;
  const reads = new Map(
    rows.map((row) => [row.key, row.ports.map((p) => keysRead(row, p.name))] as const),
  );
  const holds = (row: string, key: string) =>
    reads.get(row)!.some((keys) => keys.includes(key)) &&
    writers.get(key)!.some((w) => w.key === row);
  for (const row of rows) {
    row.ports.forEach((port, i) => {
      for (const key of reads.get(row.key)![i]!) {
        for (const w of writers.get(key) ?? []) {
          if (w.key === row.key || (holds(row.key, key) && holds(w.key, key))) continue;
          port.sources.push({ ...w, via: key });
        }
      }
    });
  }
}

/**
 * The keys a node's argument `name` reads, at any depth: every key it holds,
 * but the one a native only writes, as `set_string` its `variable`.
 */
function keysRead(row: DiagramRow, name: string): string[] {
  const argument = row.node.call.arguments.find((a) => a.name.text === name);
  if (!argument) return [];
  const keys = [...new Set(variablesRead(argument.value))];
  const id = row.entry && parameterId(row.entry, name);
  return id !== undefined && nativeWrites(row.entry!.signature.id, id)
    ? keys.filter((k) => k !== variableName(argument.value))
    : keys;
}

/** The id of `entry`'s parameter `name`. */
const parameterId = (entry: FunctionEntry, name: string) =>
  orderedParameters(entry.signature.function).find((p) => p.parameter.name === name)?.id;

/**
 * One port per argument written: the function's parameters in declared order,
 * then any argument the function does not take. A parameter left out has no
 * port; the inspector lists it.
 */
function ports(
  node: SourceNode,
  entry: FunctionEntry | undefined,
  producers: ReadonlyMap<string, Producer>,
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
    const key = variableName(value);
    return {
      name,
      text: expressionText(value),
      ...(key === undefined ? {} : { key }),
      sources: portsRead(value).flatMap(({ node: n, port }) => {
        const producer = producers.get(n);
        return producer === undefined
          ? []
          : [{ key: producer.key, output: outputName(port, producer.entry) }];
      }),
    };
  });
}

/** The name the language gives a node's return value. */
export const RET = "_ret";

/** A node others read by name: its row, and its function. */
interface Producer {
  key: string;
  entry: FunctionEntry | undefined;
}

/**
 * The name of the output `port` of a node calling `entry`: a reference may
 * name a parameter by its id, and the return value by `_ret`'s.
 */
function outputName(port: string, entry: FunctionEntry | undefined): string {
  if (port === N.RET) return RET;
  return entry?.signature.function.parameters[port]?.name ?? port;
}

/**
 * A node's outputs: `_ret` when the node binds it, can be read by name, or
 * returns a value that is not a status (a status shows as the node's pill),
 * then each parameter the function writes back, or a native writes, in
 * declared order, with the key its argument names.
 */
function outputs(node: SourceNode, entry: FunctionEntry | undefined): DiagramOutput[] {
  const fn = entry?.signature.function;
  const returns = fn?.returnType;
  const returnsData =
    returns !== undefined &&
    !(returns.type === "primitive" && returns.value.kind === "unit") &&
    !(returns.type === "frozenScalar" && returns.value.reference.id === N.STATUS_ENUMERATION);
  const target = node.target ? variableName(node.target) : undefined;
  const ret =
    node.target !== null || node.name !== null || returnsData
      ? [
          {
            name: RET,
            text: node.target ? expressionText(node.target) : "",
            ...(target === undefined ? {} : { key: target }),
          },
        ]
      : [];
  const written = fn
    ? orderedParameters(fn)
        .filter((p) => p.parameter.mutable || nativeWrites(entry!.signature.id, p.id))
        .map((p) => {
          const argument = node.call.arguments.find((a) => a.name.text === p.parameter.name);
          const key = argument && variableName(argument.value);
          return {
            name: p.parameter.name,
            text: key === undefined ? "" : expressionText(argument!.value),
            ...(key === undefined ? {} : { key }),
          };
        })
    : [];
  return [...ret, ...written];
}
