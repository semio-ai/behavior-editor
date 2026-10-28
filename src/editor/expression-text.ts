import type { Expression, FunctionName } from "../text/ast";

/** A function as a node names it: `name`, or `module::name`. */
export function functionText(name: FunctionName): string {
  return name.module === null ? name.name : `${name.module}::${name.name}`;
}

/**
 * An argument's value as the diagram and the inspector show it, on one line:
 * `0.6`, `{face/smile}`, `@raw`, `osc(t: {arora/time}, frequency: 1.6)`. The
 * file's own text is the language service's to write.
 */
export function expressionText(expression: Expression): string {
  switch (expression.kind) {
    case "number":
      return expression.text + (expression.suffix ?? "");
    case "string":
      return JSON.stringify(expression.value);
    case "bool":
      return expression.value ? "true" : "false";
    case "unit":
      return "()";
    case "array":
      return `${expression.element_type ?? ""}[${expression.items.map(expressionText).join(", ")}]`;
    case "some":
      return `some(${expressionText(expression.value)})`;
    case "none":
      return "none";
    case "uuid":
      return `uuid(${expression.value})`;
    case "variable":
      return `{${expression.name}}`;
    case "node":
      return `@${expression.node}${expression.parameter === null ? "" : `.${expression.parameter}`}`;
    case "select":
      return `${expressionText(expression.source)}[${expression.path}]`;
    case "call":
      return `${functionText(expression.function)}(${expression.arguments
        .map((a) => `${a.name}: ${expressionText(a.value)}`)
        .join(", ")})`;
  }
}

/** The nodes `expression` reads, as `@node`, at any depth. */
export function nodesRead(expression: Expression): string[] {
  switch (expression.kind) {
    case "node":
      return [expression.node];
    case "array":
      return expression.items.flatMap(nodesRead);
    case "some":
      return nodesRead(expression.value);
    case "select":
      return nodesRead(expression.source);
    case "call":
      return expression.arguments.flatMap((a) => nodesRead(a.value));
    default:
      return [];
  }
}
