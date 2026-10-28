import type { Graph } from "../model/graph";
import type { MethodSignature } from "../model/signature";
import type { BehaviorDocument, Span } from "./ast";

/**
 * The behavior language as the editor uses it: the parser, formatter and
 * resolver of `arora-behavior-tree`'s `text` module, compiled to wasm, so the
 * editor and the device read a file the same way.
 */
export interface BehaviorText {
  /** Parse a file. Recovery is per line: a document comes back with every error. */
  parse(text: string): ParseResult;
  /** The file text of a document, in the one canonical layout. */
  format(document: BehaviorDocument): string;
  /**
   * Resolve a document against the functions it may call, `functions` being
   * the modules' (the natives are known to the resolver): the graph a device
   * runs, and where each of its nodes comes from.
   */
  resolve(document: BehaviorDocument, functions: MethodSignature[]): Loaded;
  /** The native nodes, described as functions, for the palette. */
  natives(): MethodSignature[];
  /** The `arora_types::call::Call` JSON that spawns `graph` on a device's interpreter. */
  spawnGraphCall(graph: Graph): string;
}

export interface ParseResult {
  document: BehaviorDocument;
  diagnostics: Diagnostic[];
}

/** A resolved behavior: the graph, its nodes' sources, and what resolving found. */
export interface Loaded {
  graph: Graph;
  /** One entry per graph node, nested calls included. */
  nodes: LoadedNode[];
  diagnostics: Diagnostic[];
}

/** Where a graph node comes from in the text. */
export interface LoadedNode {
  id: string;
  /** The node's name; `null` for an unnamed node or a nested call. */
  name: string | null;
  /** The node's span, or the call's for a nested call. */
  span: Span;
  /** Whether the tree holds it: the root and its descendants. */
  attached: boolean;
  /** The function id. */
  function: string;
  /** The id of the node holding it, or of the node whose argument a nested call is. */
  parent: string | null;
  /** Its position: `root`, `root.0.2`, `detached.3`, `<parent path>.<parameter>`. */
  path: string;
}

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  span: Span;
}
