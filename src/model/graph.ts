import type { Value } from "./value";

/**
 * The shared behavior graph, `arora_behavior::graph::Graph`, in its serde JSON
 * form: what resolving a behavior's text produces and what an interpreter
 * loads as its behavior. Its nodes are keyed by id and keep no order; the
 * tree lists them root first, then by id.
 */
export interface Graph {
  root?: string;
  nodes: Record<string, GraphNode>;
  links: Link[];
  /** The named variables, `id -> name`: a store key, or a tree-local `.name`. */
  variables: Record<string, string>;
}

/** A node bound to a function, native or a module's. */
export interface GraphNode {
  id: string;
  function: string;
  inputs: Io[];
  outputs: Io[];
  /** The children, in order, of a node the tree holds others under; `null` for a leaf. */
  children: string[] | null;
}

/** A typed slot of a node. */
export interface Io {
  id: string;
  ty?: TypeRef;
  predetermined_key?: string;
}

/** A header type reference, `arora_types::module::high::TypeRef`. */
export type TypeRef =
  | { kind: "scalar"; id: string }
  | { kind: "array"; id: string }
  | { kind: "map"; key_id: string; value_id: string }
  | { kind: "option"; id: string };

/** One slot of one node. */
export interface Port {
  node: string;
  port: string;
}

/** A wire feeding one node input. At most one link targets a port. */
export interface Link {
  target: Port;
  source: LinkSource;
}

/** Where a link's value comes from. */
export type LinkSource =
  | { literal: Value }
  | { variable: string }
  | { port: Port }
  | { select: { source: LinkSource; path: string } };
