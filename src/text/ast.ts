/**
 * The syntax tree of a behavior file, as the language service's `parse`
 * returns it and its `format` takes it: the serde JSON of
 * `arora_behavior_tree::text::Document`. Every type of that boundary is in
 * this file.
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
 * JavaScript string, and the 1-based `line` and `column` of `start`. A part an
 * edit made, which no text holds yet, has a span of zeros.
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
  /** The comments after the last node. */
  comments: Comment[];
}

/** A node: `[name ':'] [target '='] function ['(' arguments ')']`, its children indented under it. */
export interface SourceNode {
  /** The node's line, from its first token to its last. */
  span: Span;
  /** The name other nodes read it by, as `@name`. */
  name: Name | null;
  /** Where its return value goes: `{key}`, or `@node.parameter`. */
  target: Expression | null;
  call: Call;
  children: SourceNode[];
  /** The comment lines right above it. */
  comments: Comment[];
  /** The comment at the end of its line. */
  comment: Comment | null;
  /** Whether a blank line separates it from what comes before it. */
  blank_before: boolean;
}

/** `function(parameter: value, …)`. */
export interface Call {
  span: Span;
  function: FunctionName;
  arguments: Argument[];
}

/** A function: `name`, or `module::name` with the module's id. */
export interface FunctionName {
  span: Span;
  module: Name | null;
  name: Name;
}

/** `parameter: value`. */
export interface Argument {
  span: Span;
  name: Name;
  value: Expression;
  /** The comments after it, in a call broken over lines. */
  comments: Comment[];
}

/** An identifier or an id, as written. */
export interface Name {
  span: Span;
  text: string;
}

/** `#` and the rest of its line; `text` follows the `#`. */
export interface Comment {
  span: Span;
  text: string;
}

export interface Expression {
  span: Span;
  kind: ExpressionKind;
}

/** What an expression is, tagged by `type`. */
export type ExpressionKind =
  /** `1.5`, `100u8`: the digits as written, and the type suffix when stated. */
  | { type: "number"; text: string; suffix: string | null }
  /** A string, unescaped. */
  | { type: "string"; value: string }
  | { type: "bool"; value: boolean }
  /** `()` */
  | { type: "unit" }
  /** `none` */
  | { type: "none" }
  /** `some(value)` */
  | { type: "some"; value: Expression }
  /** `[a, b]`, or `f64[a, b]` with its element type. */
  | { type: "array"; element: string | null; elements: Expression[] }
  /** `uuid(…)` */
  | { type: "uuid"; value: string }
  /** `json("…")`: a value in its serde JSON form, a structure or an enumeration. */
  | { type: "json"; text: string }
  /**
   * `{key}` a store key, `{.name}` a tree-local variable; `{"a key"}` quoted,
   * for a key `{key}` cannot hold. `name` is the key itself, unquoted.
   */
  | { type: "variable"; name: string }
  /** `{<uuid>}`: the variable of that id, which names none. */
  | { type: "variable_id"; value: string }
  /** `@node` its return value, `@node.parameter` one of its parameters. */
  | { type: "port"; node: Name; parameter: Name | null }
  /** `source[path]`: the path runs to the first `]`. */
  | { type: "select"; source: Expression; path: string }
  /** `function(parameter: value, …)` */
  | { type: "call"; call: Call };

/** The kinds of expression. */
export type ExpressionType = ExpressionKind["type"];
