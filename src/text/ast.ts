/**
 * The syntax tree of a behavior file, as the language service's `parse`
 * returns it and its `format` takes it: the serde JSON of the Rust AST of
 * `arora-behavior-tree`'s `text` module. Every type of that boundary is in this
 * file, so aligning with the Rust shape touches nothing else.
 *
 * A file is the tree nested by indentation, its first top-level node the root,
 * then the nodes no node holds:
 *
 * ```text
 * fallback
 *   sequence
 *     equal(a: {person/visible}, b: true)
 *   succeed
 *
 * raw: mul(a: {sensor/distance}, b: 100)
 * level: {face/level} = add(a: @raw, b: 1)
 * ```
 */

/**
 * A range of the text: `start` and `end` in UTF-16 code units, which index a
 * JavaScript string, and the 1-based `line` and `column` of `start`.
 */
export interface Span {
  start: number;
  end: number;
  line: number;
  column: number;
}

/** A whole file. */
export interface BehaviorDocument {
  /** The top-level nodes in file order: the root, then the nodes no node holds. */
  nodes: SourceNode[];
  /** The comments, `# …` to the end of a line, which the formatter keeps in place. */
  comments: Comment[];
}

export interface Comment {
  text: string;
  span: Span;
}

/** A node as written: `[name ':'] [target '='] function ['(' args ')']`, then its children. */
export interface SourceNode {
  /** The name other nodes read it by, as `@name`. */
  name: Name | null;
  /** What its return value is bound to: `{key} = …`. */
  target: Expression | null;
  function: FunctionName;
  arguments: Argument[];
  /** The nodes indented under it, in order. */
  children: SourceNode[];
  span: Span;
}

export interface Name {
  text: string;
  span: Span;
}

/** A function: a bare name, or `module::name` when a bare name is ambiguous. */
export interface FunctionName {
  /** The module by its name or id, when stated. */
  module: string | null;
  name: string;
  span: Span;
}

/** `parameter: value`, by parameter name. */
export interface Argument {
  name: string;
  value: Expression;
  span: Span;
}

/** An argument's value. */
export type Expression =
  /** `1.5`, `1.5f64`: the text as written, and its type suffix when stated. */
  | { kind: "number"; text: string; suffix: string | null; span: Span }
  | { kind: "string"; value: string; span: Span }
  | { kind: "bool"; value: boolean; span: Span }
  /** `()` */
  | { kind: "unit"; span: Span }
  /** `[1.0, 2.0]`, `f64[1.0, 2.0]` */
  | { kind: "array"; element_type: string | null; items: Expression[]; span: Span }
  /** `some(x)` */
  | { kind: "some"; value: Expression; span: Span }
  /** `none` */
  | { kind: "none"; span: Span }
  /** `uuid(…)` */
  | { kind: "uuid"; value: string; span: Span }
  /** `{key}` a store key, `{.name}` a tree-local variable. */
  | { kind: "variable"; name: string; span: Span }
  /** `@node` its return value, `@node.parameter` one of its parameters. */
  | { kind: "node"; node: string; parameter: string | null; span: Span }
  /** `source[path]` */
  | { kind: "select"; source: Expression; path: string; span: Span }
  /** `function(parameter: value, …)` */
  | { kind: "call"; function: FunctionName; arguments: Argument[]; span: Span };

/** The kinds of expression. */
export type ExpressionKind = Expression["kind"];
