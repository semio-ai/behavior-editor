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
