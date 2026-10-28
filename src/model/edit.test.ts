import { describe, expect, it } from "vitest";
import type { BehaviorDocument, Expression, SourceNode } from "../text/ast";
import {
  NO_SPAN,
  addChild,
  addDetached,
  clearArgument,
  deleteNode,
  moveNode,
  newNode,
  nodeAt,
  renameNode,
  reparent,
  setArgument,
  setFunction,
  setTarget,
  walk,
} from "./edit";

const ref = (node: string, parameter: string | null = null): Expression => ({
  kind: "node",
  node,
  parameter,
  span: NO_SPAN,
});
const num = (text: string): Expression => ({ kind: "number", text, suffix: null, span: NO_SPAN });
const key = (name: string): Expression => ({ kind: "variable", name, span: NO_SPAN });

function named(name: string, node: SourceNode): SourceNode {
  return { ...node, name: { text: name, span: NO_SPAN } };
}

function withChildren(node: SourceNode, children: SourceNode[]): SourceNode {
  return { ...node, children };
}

/**
 * fallback
 *   sequence
 *     below(x: @cm, limit: 30)
 *     succeed
 *   fail
 *
 * raw: mul(a: {sensor/distance}, b: 100)
 * cm: clamp(x: @raw, min: 0)
 */
function sample(): BehaviorDocument {
  return {
    nodes: [
      withChildren(newNode("fallback"), [
        withChildren(newNode("sequence"), [
          newNode("below", [
            ["x", ref("cm")],
            ["limit", num("30")],
          ]),
          newNode("succeed"),
        ]),
        newNode("fail"),
      ]),
      named(
        "raw",
        newNode("mul", [
          ["a", key("sensor/distance")],
          ["b", num("100")],
        ]),
      ),
      named(
        "cm",
        newNode("clamp", [
          ["x", ref("raw")],
          ["min", num("0")],
        ]),
      ),
    ],
    comments: [],
  };
}

const functions = (document: BehaviorDocument) =>
  walk(document).map(({ node, path }) => `${path.join(".")} ${node.function.name}`);

describe("edits of a behavior document", () => {
  it("address nodes by path and walk them in file order", () => {
    const document = sample();
    expect(nodeAt(document, [0, 0, 1])?.function.name).toBe("succeed");
    expect(nodeAt(document, [0, 5])).toBeUndefined();
    expect(functions(document)).toEqual([
      "0 fallback",
      "0.0 sequence",
      "0.0.0 below",
      "0.0.1 succeed",
      "0.1 fail",
      "1 mul",
      "2 clamp",
    ]);
  });

  it("leave the input untouched and share what they do not change", () => {
    const document = sample();
    const before = JSON.stringify(document);
    const edited = addChild(document, [0, 0], newNode("running"));
    expect(JSON.stringify(document)).toBe(before);
    expect(edited.nodes[1]).toBe(document.nodes[1]);
    expect(edited.nodes[0]!.children[1]).toBe(document.nodes[0]!.children[1]);
  });

  it("add a child last, or at an index", () => {
    const last = addChild(sample(), [0, 0], newNode("running"));
    expect(nodeAt(last, [0, 0, 2])?.function.name).toBe("running");
    const first = addChild(sample(), [0, 0], newNode("running"), 0);
    expect(nodeAt(first, [0, 0, 0])?.function.name).toBe("running");
    expect(nodeAt(first, [0, 0, 1])?.function.name).toBe("below");
    expect(addChild(sample(), [0, 9], newNode("running"))).toEqual(sample());
  });

  it("add a detached node after the others", () => {
    const edited = addDetached(sample(), named("level", newNode("add")));
    expect(edited.nodes.at(-1)?.name?.text).toBe("level");
    expect(edited.nodes).toHaveLength(4);
  });

  it("delete a node and its subtree, but never the root", () => {
    const edited = deleteNode(sample(), [0, 0]);
    expect(functions(edited)).toEqual(["0 fallback", "0.0 fail", "1 mul", "2 clamp"]);
    const document = sample();
    expect(deleteNode(document, [0])).toBe(document);
    expect(deleteNode(document, [7])).toBe(document);
  });

  it("move a node among its siblings, keeping the root first", () => {
    const down = moveNode(sample(), [0, 0], 1);
    expect(functions(down).slice(0, 5)).toEqual([
      "0 fallback",
      "0.0 fail",
      "0.1 sequence",
      "0.1.0 below",
      "0.1.1 succeed",
    ]);
    const up = moveNode(sample(), [2], -1);
    expect(up.nodes.map((n) => n.function.name)).toEqual(["fallback", "clamp", "mul"]);
    const document = sample();
    expect(moveNode(document, [1], -1)).toBe(document);
    expect(moveNode(document, [0, 1], 1)).toBe(document);
    expect(moveNode(document, [0], 1)).toBe(document);
  });

  it("re-parent a node, counting the index once it has left its place", () => {
    // `fail` moves into the sequence, between below and succeed.
    const moved = reparent(sample(), [0, 1], [0, 0], 1);
    expect(functions(moved).slice(0, 5)).toEqual([
      "0 fallback",
      "0.0 sequence",
      "0.0.0 below",
      "0.0.1 fail",
      "0.0.2 succeed",
    ]);
    // `below` leaves the sequence for the fallback, whose path does not shift.
    const out = reparent(sample(), [0, 0, 0], [0], 2);
    expect(functions(out).slice(0, 5)).toEqual([
      "0 fallback",
      "0.0 sequence",
      "0.0.0 succeed",
      "0.1 fail",
      "0.2 below",
    ]);
  });

  it("re-parent into a later sibling's subtree, whose path shifts", () => {
    const document: BehaviorDocument = {
      nodes: [withChildren(newNode("sequence"), [newNode("succeed"), newNode("fallback")])],
      comments: [],
    };
    // The fallback is [0, 1] before the move and [0, 0] once succeed has left.
    const moved = reparent(document, [0, 0], [0, 1], 0);
    expect(functions(moved)).toEqual(["0 sequence", "0.0 fallback", "0.0.0 succeed"]);
  });

  it("detach a node to the top level, and attach a detached one", () => {
    const detached = reparent(sample(), [0, 1], null, 1);
    expect(detached.nodes.map((n) => n.function.name)).toEqual([
      "fallback",
      "fail",
      "mul",
      "clamp",
    ]);
    const attached = reparent(sample(), [2], [0], 0);
    expect(functions(attached).slice(0, 2)).toEqual(["0 fallback", "0.0 clamp"]);
    expect(attached.nodes).toHaveLength(2);
  });

  it("refuse to move the root or a node under itself", () => {
    const document = sample();
    expect(reparent(document, [0], null, 1)).toBe(document);
    expect(reparent(document, [0, 0], [0, 0, 1], 0)).toBe(document);
    expect(reparent(document, [0, 0], [0, 0], 0)).toBe(document);
  });

  it("rename a node and every reference to it", () => {
    const edited = renameNode(sample(), [1], "centimetres");
    expect(nodeAt(edited, [1])?.name?.text).toBe("centimetres");
    expect(nodeAt(edited, [2])?.arguments[0]?.value).toMatchObject({ node: "centimetres" });
    expect(nodeAt(edited, [0, 0, 0])?.arguments[0]?.value).toMatchObject({ node: "cm" });
  });

  it("rename references in nested calls and targets", () => {
    const nested: Expression = {
      kind: "call",
      function: { module: null, name: "mul", span: NO_SPAN },
      arguments: [{ name: "a", value: ref("raw", "state"), span: NO_SPAN }],
      span: NO_SPAN,
    };
    const document = setTarget(setArgument(sample(), [2], "x", nested), [2], ref("raw", "x"));
    const edited = renameNode(document, [1], "r");
    const node = nodeAt(edited, [2])!;
    expect(node.arguments[0]?.value).toMatchObject({
      kind: "call",
      arguments: [{ value: { node: "r", parameter: "state" } }],
    });
    expect(node.target).toMatchObject({ node: "r", parameter: "x" });
  });

  it("refuse a name another node has, and unname without touching references", () => {
    const document = sample();
    expect(renameNode(document, [1], "cm")).toBe(document);
    const unnamed = renameNode(document, [1], null);
    expect(nodeAt(unnamed, [1])?.name).toBeNull();
    expect(nodeAt(unnamed, [2])?.arguments[0]?.value).toMatchObject({ node: "raw" });
  });

  it("set a function, dropping arguments the new one does not take", () => {
    const fn = { module: "math", name: "max", span: NO_SPAN };
    const kept = setFunction(sample(), [2], fn);
    expect(nodeAt(kept, [2])?.function).toEqual(fn);
    expect(nodeAt(kept, [2])?.arguments.map((a) => a.name)).toEqual(["x", "min"]);
    const pruned = setFunction(sample(), [2], fn, ["x", "max"]);
    expect(nodeAt(pruned, [2])?.arguments.map((a) => a.name)).toEqual(["x"]);
  });

  it("set an argument in place or append it, and clear one", () => {
    const replaced = setArgument(sample(), [2], "min", num("5"));
    expect(nodeAt(replaced, [2])?.arguments.map((a) => [a.name, a.value])).toEqual([
      ["x", ref("raw")],
      ["min", num("5")],
    ]);
    const added = setArgument(sample(), [2], "max", num("80"));
    expect(nodeAt(added, [2])?.arguments.map((a) => a.name)).toEqual(["x", "min", "max"]);
    const cleared = clearArgument(sample(), [2], "x");
    expect(nodeAt(cleared, [2])?.arguments.map((a) => a.name)).toEqual(["min"]);
    const document = sample();
    expect(clearArgument(document, [2], "nothing")).toBe(document);
  });

  it("bind and unbind a node's return value", () => {
    const bound = setTarget(sample(), [2], key("face/level"));
    expect(nodeAt(bound, [2])?.target).toEqual(key("face/level"));
    expect(nodeAt(setTarget(bound, [2], null), [2])?.target).toBeNull();
  });
});
