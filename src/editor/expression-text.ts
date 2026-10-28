import type { Call, Expression, FunctionName } from "../text/ast";

/** A function as a node names it: `name`, or `module::name`. */
export function functionText(name: FunctionName): string {
  return name.module === null ? name.name.text : `${name.module.text}::${name.name.text}`;
}

/** A call on one line: `function(parameter: value, …)`. */
export function callText(call: Call): string {
  const args = call.arguments.map((a) => `${a.name.text}: ${expressionText(a.value)}`);
  return `${functionText(call.function)}(${args.join(", ")})`;
}

/**
 * An argument's value as the diagram and the inspector show it, on one line:
 * `0.6`, `{face/smile}`, `@raw`, `osc(t: {arora/time}, frequency: 1.6)`. The
 * file's own text is the language service's to write.
 */
export function expressionText(expression: Expression): string {
  const { kind } = expression;
  switch (kind.type) {
    case "number":
      return kind.text + (kind.suffix ?? "");
    case "string":
      return JSON.stringify(kind.value);
    case "bool":
      return kind.value ? "true" : "false";
    case "unit":
      return "()";
    case "none":
      return "none";
    case "some":
      return `some(${expressionText(kind.value)})`;
    case "array":
      return `${kind.element ?? ""}[${kind.elements.map(expressionText).join(", ")}]`;
    case "uuid":
      return `uuid(${kind.value})`;
    case "json":
      return `json(${JSON.stringify(kind.text)})`;
    case "variable":
      return variableText(kind.name);
    case "variable_id":
      return `{${kind.value}}`;
    case "port":
      return `@${kind.node.text}${kind.parameter === null ? "" : `.${kind.parameter.text}`}`;
    case "select":
      return `${expressionText(kind.source)}[${kind.path}]`;
    case "call":
      return callText(kind.call);
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A variable as the language writes it: `{key}`, or `{"key"}` when `{key}`
 * would not read back as `key`: a key that is empty, holds a space, a brace, a
 * quote or a line break, starts with `=`, or is an id.
 */
export function variableText(key: string): string {
  const plain = key !== "" && !key.startsWith("=") && !/[\s{}"]/.test(key) && !UUID.test(key);
  return plain ? `{${key}}` : `{${JSON.stringify(key)}}`;
}

/** The nodes `expression` reads, as `@node`, at any depth. */
export function nodesRead(expression: Expression): string[] {
  const { kind } = expression;
  switch (kind.type) {
    case "port":
      return [kind.node.text];
    case "array":
      return kind.elements.flatMap(nodesRead);
    case "some":
      return nodesRead(kind.value);
    case "select":
      return nodesRead(kind.source);
    case "call":
      return kind.call.arguments.flatMap((a) => nodesRead(a.value));
    default:
      return [];
  }
}
