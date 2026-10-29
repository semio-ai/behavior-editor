import type { Value } from "./value";

/**
 * The shared behavior graph, `arora_behavior::graph::Graph` (graph format
 * behavior-tree 2.0), in its serde JSON form: what resolving a behavior's text
 * produces and what an interpreter loads as its behavior. Its references are
 * ids. The order of its nodes means nothing to an interpreter: it is the
 * order they serialize in.
 */
export interface Graph {
  /** The tree's root; absent for a graph with no tree. */
  root?: string;
  /** The nodes, each id once. Absent when there is none. */
  nodes?: GraphNode[];
}

/** A node bound to a function, native or a module's, with its bindings. */
export interface GraphNode {
  id: string;
  function: string;
  /**
   * Each bound port, by id, and its source: what feeds a port the function
   * reads, or where a port it writes is written. The return value is the
   * port `_ret`'s id. Absent when no port is bound.
   */
  bind?: Record<string, Source>;
  /** The children, in order, of a node the tree holds others under; absent for a leaf. */
  children?: string[];
}

/** One port of one node: a parameter of its function, or its return value. */
export interface Port {
  node: string;
  port: string;
}

/**
 * What a port is bound to: a value, a store key (a key starting with `.` is
 * the tree's own), another node's port, or a path into another source's
 * value.
 */
export type Source =
  | { value: Value }
  | { key: string }
  | { port: Port }
  | { select: { source: Source; path: string } };

/** The graph of no behavior. */
export const EMPTY_GRAPH: Graph = {};

/** The node `id` of `graph`. */
export function graphNode(graph: Graph, id: string): GraphNode | undefined {
  return graph.nodes?.find((node) => node.id === id);
}

/** A port's binding, as a diff sets it. */
export interface Binding {
  node: string;
  port: string;
  source: Source;
}

/**
 * An edit to a graph, `arora_behavior::graph::GraphDiff`: the nodes removed,
 * then the nodes set whole, then single ports unbound and bound, then the
 * root. Every field is absent when empty, so the diff of a graph to itself is
 * `{}`.
 */
export interface GraphDiff {
  /** Nodes to remove; the bindings reading them go with them, and so does the root. */
  remove?: string[];
  /** Nodes to set whole: each replaces the node of its id, in its place, or goes last. */
  set?: GraphNode[];
  /** Ports to unbind. */
  unbind?: Port[];
  /** Ports to bind, each replacing what its port was bound to; of several for one port, the last stands. */
  bind?: Binding[];
  /** The root, when the diff sets it. */
  root?: string;
}

/** Whether `diff` changes nothing. */
export function isEmptyDiff(diff: GraphDiff): boolean {
  return (
    !diff.remove?.length &&
    !diff.set?.length &&
    !diff.unbind?.length &&
    !diff.bind?.length &&
    diff.root === undefined
  );
}

/**
 * The nodes `diff` restarts: those it sets, and those it binds or unbinds a
 * port of, as `arora-behavior-tree`'s interpreter counts them. Every other
 * node it leaves in place keeps its state.
 */
export function changedNodes(diff: GraphDiff): Set<string> {
  return new Set([
    ...(diff.set ?? []).map((node) => node.id),
    ...(diff.unbind ?? []).map((port) => port.node),
    ...(diff.bind ?? []).map((binding) => binding.node),
  ]);
}

/** The port `source` reads, through any selection; `undefined` for a value or a key. */
export function sourcePort(source: Source): Port | undefined {
  if ("port" in source) return source.port;
  if ("select" in source) return sourcePort(source.select.source);
  return undefined;
}

/**
 * `graph` with `diff` applied, as `Graph::apply` applies it; `graph` is left
 * as it is. A diff binding a port on a node the graph will not have is
 * refused whole: it throws.
 */
export function applyDiff(graph: Graph, diff: GraphDiff): Graph {
  const removed = new Set(diff.remove ?? []);
  const present = new Set([
    ...(graph.nodes ?? []).map((node) => node.id).filter((id) => !removed.has(id)),
    ...(diff.set ?? []).map((node) => node.id),
  ]);
  const stray = diff.bind?.find((binding) => !present.has(binding.node));
  if (stray) throw new Error(`a binding targets node ${stray.node}, which is not in the graph`);

  const copy = (node: GraphNode): GraphNode => ({
    ...node,
    ...(node.bind ? { bind: { ...node.bind } } : {}),
  });
  const nodes = (graph.nodes ?? []).filter((node) => !removed.has(node.id)).map(copy);
  if (removed.size) {
    for (const node of nodes) {
      for (const [port, source] of Object.entries(node.bind ?? {})) {
        const read = sourcePort(source);
        if (read && removed.has(read.node)) delete node.bind![port];
      }
    }
  }
  let root = graph.root !== undefined && removed.has(graph.root) ? undefined : graph.root;
  const at = new Map(nodes.map((node, i) => [node.id, i]));
  for (const node of diff.set ?? []) {
    const i = at.get(node.id);
    if (i === undefined) {
      at.set(node.id, nodes.length);
      nodes.push(copy(node));
    } else {
      nodes[i] = copy(node);
    }
  }
  for (const port of diff.unbind ?? []) {
    const i = at.get(port.node);
    if (i !== undefined) delete nodes[i]!.bind?.[port.port];
  }
  for (const binding of diff.bind ?? []) {
    const node = nodes[at.get(binding.node)!]!;
    (node.bind ??= {})[binding.port] = binding.source;
  }
  for (const node of nodes) if (node.bind && !Object.keys(node.bind).length) delete node.bind;
  if (diff.root !== undefined) root = diff.root;
  return { ...(root !== undefined ? { root } : {}), ...(nodes.length ? { nodes } : {}) };
}
