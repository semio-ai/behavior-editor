import type { Graph, GraphDiff } from "../model/graph";
import type { MethodSignature } from "../model/signature";
import type { TraceHandle, TraceOptions, TraceReport } from "../runtime/trace";
import type { BehaviorDocument, Span } from "./ast";

/**
 * The behavior language as the editor uses it: the parser, formatter and
 * resolver of `arora-behavior-tree`'s `text` module, compiled to wasm, so the
 * editor and the device read a file the same way.
 */
export interface BehaviorText {
  /** Parse a file. Recovery is per line: a document comes back with every error. */
  parse(text: string): ParseResult;
  /**
   * The file text of a parse result, in the one canonical layout, each node's
   * arguments in the order of its function's parameters. A parse with errors
   * is refused, as is a document nested deeper than the language allows: it
   * throws. A parse with errors leaves lines out of its document, so its text
   * is the only whole account of the behavior.
   */
  format(parsed: ParseResult, functions: MethodSignature[]): string;
  /**
   * Resolve a document against the functions it may call, `functions` being
   * the modules' as a device's `describeMethods` lists them (the natives are
   * known to the resolver): the graph a device runs, and where each of its
   * nodes comes from.
   */
  resolve(document: BehaviorDocument, functions: MethodSignature[]): Loaded;
  /** The native nodes, described as functions, for the palette. */
  natives(): MethodSignature[];
  /**
   * The `arora_types::call::Call` JSON that loads `graph` as a device's
   * behavior: the interpreter's `load`, which ticks it at every tick in place of
   * the behavior it had. The empty graph loads none.
   */
  loadCall(graph: Graph): string;
  /**
   * The diff that takes `previous` to `next`, `Graph::diff`: the nodes only
   * `next` has, or whose function or children change, set whole; one binding
   * per port whose binding changes; the root when it changes. `{}` when they
   * are the same graph.
   */
  diff(previous: Graph, next: Graph): GraphDiff;
  /**
   * The `arora_types::call::Call` JSON that applies `diff` to a device's
   * behavior: the interpreter's `edit`, which restarts the nodes the diff sets
   * or binds and keeps the state of every other.
   */
  editCall(diff: GraphDiff): string;
  /**
   * The `arora_types::call::Call` JSON that starts a trace of a device's
   * behavior: the interpreter's `TRACE`, whose reports carry the statuses,
   * the detached activity, and the outputs of `options.values`' nodes.
   */
  traceCall(options: TraceOptions): string;
  /**
   * The `arora_types::call::Call` JSON that reads a device's behavior: the
   * interpreter's `READ`, which answers the graph it runs and its revision.
   * Absent from a language built without it: a device's behavior is then not
   * read.
   */
  readCall?(): string;
  /** The behavior and its revision, out of the `CallResult` JSON a `READ` answered. */
  readResult?(resultJson: string): { graph: Graph; revision: number };
  /** The trace's handle, out of the `CallResult` JSON its call answered. */
  traceHandle(resultJson: string): TraceHandle;
  /** A trace's report, out of the `Value` JSON its feedback key holds. */
  traceReport(valueJson: string): TraceReport;
  /**
   * A behavior file in another form than the text, as the text the editor
   * edits: a readable graph in JSON or YAML (`arora-behavior-tree`'s
   * `readable`: references by name, by id, or both), its names resolved
   * against `functions` and the natives; or a Groot tree. A node the file
   * names keeps its name, and a readable graph's nodes keep their ids. A file
   * that does not load answers its problems, each with its place.
   */
  openFile(file: string, format: GraphFileFormat, functions: MethodSignature[]): FileOutcome;
  /**
   * A resolved behavior as a file in another form than the text: a readable
   * graph in JSON or YAML, each node, function and port by its name; or a
   * Groot tree, which holds no node outside the tree, no binding reading
   * another node and no node name, and answers those as problems. A file
   * that would not open again, such as YAML nested past its 128 levels, is
   * answered as a problem too.
   */
  writeFile(loaded: Loaded, format: GraphFileFormat, functions: MethodSignature[]): FileOutcome;
}

/** The forms a behavior file takes besides the text. */
export type GraphFileFormat = "json" | "yaml" | "groot";

/** A file's text, or why it has none. */
export type FileOutcome = { text: string } | { problems: FileProblem[] };

/** Why a file does not load, or a behavior has no form in a format, and where. */
export interface FileProblem {
  message: string;
  /** The path in the file a readable graph's reference is written at, as `nodes[2].bind.lo`. */
  at?: string;
  /** The 1-based line and column. */
  line?: number;
  column?: number;
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
