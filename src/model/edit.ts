import type {
  Argument,
  BehaviorDocument,
  Expression,
  FunctionName,
  SourceNode,
  Span,
} from "../text/ast";

/**
 * Edits of a behavior document. Each returns a new document and leaves its
 * input as it was, sharing the parts it does not change; an edit that does
 * not apply returns its input.
 *
 * A node is addressed by its path: its index among the top-level nodes, then
 * its index among its parent's children at each level. `[0]` is the root,
 * `[0, 2]` the root's third child, `[3]` the third node no node holds.
 */
export type NodePath = readonly number[];

/** The span of a node or expression an edit made, which the text has not placed yet. */
export const NO_SPAN: Span = { start: 0, end: 0, line: 0, column: 0 };

/** A new node calling `function`, with `args` by parameter name. */
export function newNode(
  function_: FunctionName | string,
  args: readonly (readonly [string, Expression])[] = [],
): SourceNode {
  return {
    name: null,
    target: null,
    function:
      typeof function_ === "string" ? { module: null, name: function_, span: NO_SPAN } : function_,
    arguments: args.map(([name, value]) => ({ name, value, span: NO_SPAN })),
    children: [],
    span: NO_SPAN,
  };
}

/** The node at `path`. */
export function nodeAt(document: BehaviorDocument, path: NodePath): SourceNode | undefined {
  let nodes = document.nodes;
  let node: SourceNode | undefined;
  for (const index of path) {
    node = nodes[index];
    if (!node) return undefined;
    nodes = node.children;
  }
  return node;
}

/** Each node with its path, depth first, in file order. */
export function walk(document: BehaviorDocument): { node: SourceNode; path: NodePath }[] {
  const out: { node: SourceNode; path: NodePath }[] = [];
  const visit = (nodes: readonly SourceNode[], prefix: NodePath) =>
    nodes.forEach((node, index) => {
      const path = [...prefix, index];
      out.push({ node, path });
      visit(node.children, path);
    });
  visit(document.nodes, []);
  return out;
}

/** The path of the sibling `delta` places from `path`. */
export function siblingPath(path: NodePath, delta: number): NodePath {
  return [...path.slice(0, -1), path.at(-1)! + delta];
}

/** Whether `path` is `ancestor` or under it. */
export function isWithin(path: NodePath, ancestor: NodePath): boolean {
  return ancestor.length <= path.length && ancestor.every((index, i) => path[i] === index);
}

/** Add `node` under the node at `parent`, at `index` among its children (last by default). */
export function addChild(
  document: BehaviorDocument,
  parent: NodePath,
  node: SourceNode,
  index?: number,
): BehaviorDocument {
  return updateNode(document, parent, (n) => ({
    ...n,
    children: insert(n.children, index ?? n.children.length, node),
  }));
}

/** Add `node` after the others as a node no node holds. */
export function addDetached(document: BehaviorDocument, node: SourceNode): BehaviorDocument {
  return { ...document, nodes: [...document.nodes, node] };
}

/** Remove the node at `path` and everything under it. The root stays. */
export function deleteNode(document: BehaviorDocument, path: NodePath): BehaviorDocument {
  if (path.length === 0 || isRoot(path) || !nodeAt(document, path)) return document;
  return updateSiblings(document, path.slice(0, -1), (siblings) =>
    siblings.filter((_, i) => i !== path.at(-1)),
  );
}

/**
 * Move the node at `path` one place up (`-1`) or down (`+1`) among its
 * siblings. The root stays first of the top-level nodes.
 */
export function moveNode(
  document: BehaviorDocument,
  path: NodePath,
  delta: -1 | 1,
): BehaviorDocument {
  if (path.length === 0 || isRoot(path)) return document;
  const index = path.at(-1)!;
  const to = index + delta;
  const parent = path.slice(0, -1);
  const count = parent.length ? nodeAt(document, parent)?.children.length : document.nodes.length;
  const first = parent.length ? 0 : 1;
  if (count === undefined || to < first || to >= count) return document;
  return updateSiblings(document, parent, (siblings) => {
    const next = [...siblings];
    [next[index], next[to]] = [next[to]!, next[index]!];
    return next;
  });
}

/**
 * Move the node at `path` under the node at `parent`, at `index` among its
 * children as they are once it has left its place; with `parent` `null`, to
 * the top level, among the nodes no node holds. The root stays, and no node
 * moves under itself.
 */
export function reparent(
  document: BehaviorDocument,
  path: NodePath,
  parent: NodePath | null,
  index: number,
): BehaviorDocument {
  const node = nodeAt(document, path);
  if (!node || isRoot(path) || (parent && isWithin(parent, path))) return document;
  if (parent && !nodeAt(document, parent)) return document;
  const removed = deleteNode(document, path);
  // Removing the node shifts the later siblings of each ancestor it had in common with `parent`.
  const target = parent ? shiftAfterRemoval(parent, path) : null;
  if (!target) {
    const at = Math.max(1, Math.min(index, removed.nodes.length));
    return { ...removed, nodes: insert(removed.nodes, at, node) };
  }
  return updateNode(removed, target, (n) => ({
    ...n,
    children: insert(n.children, Math.max(0, Math.min(index, n.children.length)), node),
  }));
}

/**
 * Name the node at `path` `name`, or unname it with `null`, and make every
 * `@old` reference read the new name. Refused when another node has the name.
 */
export function renameNode(
  document: BehaviorDocument,
  path: NodePath,
  name: string | null,
): BehaviorDocument {
  const node = nodeAt(document, path);
  if (!node) return document;
  const old = node.name?.text ?? null;
  if (old === name) return document;
  if (name !== null && walk(document).some(({ node: n }) => n.name?.text === name)) return document;
  const renamed = updateNode(document, path, (n) => ({
    ...n,
    name: name === null ? null : { text: name, span: NO_SPAN },
  }));
  if (old === null || name === null) return renamed;
  return mapNodes(renamed, (n) => ({
    ...n,
    target: n.target && renameReferences(n.target, old, name),
    arguments: renameInArguments(n.arguments, old, name),
  }));
}

/**
 * Make the node at `path` call `function_`. With `parameters`, the arguments
 * of parameters the new function does not have are dropped.
 */
export function setFunction(
  document: BehaviorDocument,
  path: NodePath,
  function_: FunctionName,
  parameters?: readonly string[],
): BehaviorDocument {
  return updateNode(document, path, (n) => ({
    ...n,
    function: function_,
    arguments: parameters ? n.arguments.filter((a) => parameters.includes(a.name)) : n.arguments,
  }));
}

/** Set the argument of the parameter `name` of the node at `path`. */
export function setArgument(
  document: BehaviorDocument,
  path: NodePath,
  name: string,
  value: Expression,
): BehaviorDocument {
  return updateNode(document, path, (n) => {
    const at = n.arguments.findIndex((a) => a.name === name);
    const argument: Argument = { name, value, span: at >= 0 ? n.arguments[at]!.span : NO_SPAN };
    return {
      ...n,
      arguments:
        at >= 0 ? n.arguments.map((a, i) => (i === at ? argument : a)) : [...n.arguments, argument],
    };
  });
}

/** Remove the argument of the parameter `name` of the node at `path`. */
export function clearArgument(
  document: BehaviorDocument,
  path: NodePath,
  name: string,
): BehaviorDocument {
  const node = nodeAt(document, path);
  if (!node?.arguments.some((a) => a.name === name)) return document;
  return updateNode(document, path, (n) => ({
    ...n,
    arguments: n.arguments.filter((a) => a.name !== name),
  }));
}

/** Bind the return value of the node at `path` to `target`, or unbind it with `null`. */
export function setTarget(
  document: BehaviorDocument,
  path: NodePath,
  target: Expression | null,
): BehaviorDocument {
  return updateNode(document, path, (n) => ({ ...n, target }));
}

function isRoot(path: NodePath): boolean {
  return path.length === 1 && path[0] === 0;
}

function insert<T>(items: readonly T[], index: number, item: T): T[] {
  return [...items.slice(0, index), item, ...items.slice(index)];
}

/** `path` once the node at `removed` has left its siblings. */
function shiftAfterRemoval(path: NodePath, removed: NodePath): NodePath {
  const depth = removed.length - 1;
  const sameParent = removed.slice(0, depth).every((index, i) => path[i] === index);
  if (!sameParent || path.length <= depth || path[depth]! < removed[depth]!) return path;
  return path.map((index, i) => (i === depth ? index - 1 : index));
}

function updateNode(
  document: BehaviorDocument,
  path: NodePath,
  update: (node: SourceNode) => SourceNode,
): BehaviorDocument {
  if (path.length === 0 || !nodeAt(document, path)) return document;
  return updateSiblings(document, path.slice(0, -1), (siblings) =>
    siblings.map((n, i) => (i === path.at(-1) ? update(n) : n)),
  );
}

function updateSiblings(
  document: BehaviorDocument,
  parent: NodePath,
  update: (siblings: readonly SourceNode[]) => SourceNode[],
): BehaviorDocument {
  if (parent.length === 0) return { ...document, nodes: update(document.nodes) };
  return updateNode(document, parent, (n) => ({ ...n, children: update(n.children) }));
}

function mapNodes(
  document: BehaviorDocument,
  update: (node: SourceNode) => SourceNode,
): BehaviorDocument {
  const map = (nodes: readonly SourceNode[]): SourceNode[] =>
    nodes.map((n) => update({ ...n, children: map(n.children) }));
  return { ...document, nodes: map(document.nodes) };
}

function renameInArguments(args: readonly Argument[], old: string, name: string): Argument[] {
  return args.map((a) => ({ ...a, value: renameReferences(a.value, old, name) }));
}

function renameReferences(expression: Expression, old: string, name: string): Expression {
  switch (expression.kind) {
    case "node":
      return expression.node === old ? { ...expression, node: name } : expression;
    case "array":
      return {
        ...expression,
        items: expression.items.map((x) => renameReferences(x, old, name)),
      };
    case "some":
      return { ...expression, value: renameReferences(expression.value, old, name) };
    case "select":
      return { ...expression, source: renameReferences(expression.source, old, name) };
    case "call":
      return { ...expression, arguments: renameInArguments(expression.arguments, old, name) };
    default:
      return expression;
  }
}
