import { type NodePath, walk } from "../model/edit";
import { orderedParameters } from "../model/signature";
import type { BehaviorDocument, SourceNode, Span } from "../text/ast";
import type { LoadedNode } from "../text/language";
import { expressionText, functionText, nodesRead } from "./expression-text";
import {
  type FunctionEntry,
  type FunctionIndex,
  type NodeShape,
  controlGlyph,
  nodeShape,
} from "./functions";

/** One argument line of a node: the parameter, what it reads, and the nodes that produce it. */
export interface DiagramPort {
  name: string;
  text: string;
  /** The keys of the rows whose output this argument reads. */
  sources: string[];
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
  /** Whether other nodes can read it: it has a name. */
  produces: boolean;
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
      produces: node.name !== null,
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
      sources: [...new Set(nodesRead(value))].flatMap((n) => {
        const key = producers.get(n);
        return key === undefined ? [] : [key];
      }),
    };
  });
}
