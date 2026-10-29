import { describe, expect, it } from "vitest";
import type { BehaviorDocument, Expression, SourceNode } from "../text/ast";
import {
  addChild,
  call,
  expression,
  functionName,
  name,
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

const ref = (node: string, parameter = "_ret"): Expression =>
  expression({ type: "port", node: name(node), parameter: name(parameter) });
const num = (text: string): Expression => expression({ type: "number", text, suffix: null });
const key = (variable: string): Expression => expression({ type: "variable", name: variable });

function named(text: string, node: SourceNode): SourceNode {
  return { ...node, name: name(text) };
}

const fn = (node: SourceNode | undefined) => node?.call.function.name.text;
const args = (node: SourceNode | undefined) => node?.call.arguments.map((a) => a.name.text);

function withChildren(node: SourceNode, children: SourceNode[]): SourceNode {
  return { ...node, children };
}

/**
 * fallback
 *   sequence
 *     below(x: @cm._ret, limit: 30)
 *     succeed
 *   fail
 *
 * raw: mul(a: {sensor/distance}, b: 100)
 * cm: clamp(x: @raw._ret, min: 0)
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
  walk(document).map(({ node, path }) => `${path.join(".")} ${fn(node)}`);

describe("edits of a behavior document", () => {
  it("address nodes by path and walk them in file order", () => {
    const document = sample();
    expect(fn(nodeAt(document, [0, 0, 1]))).toBe("succeed");
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
    expect(fn(nodeAt(last, [0, 0, 2]))).toBe("running");
    const first = addChild(sample(), [0, 0], newNode("running"), 0);
    expect(fn(nodeAt(first, [0, 0, 0]))).toBe("running");
    expect(fn(nodeAt(first, [0, 0, 1]))).toBe("below");
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
    expect(up.nodes.map(fn)).toEqual(["fallback", "clamp", "mul"]);
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
    expect(detached.nodes.map(fn)).toEqual(["fallback", "fail", "mul", "clamp"]);
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
    expect(nodeAt(edited, [2])?.call.arguments[0]?.value).toEqual(ref("centimetres"));
    expect(nodeAt(edited, [0, 0, 0])?.call.arguments[0]?.value).toEqual(ref("cm"));
  });

  it("rename references in nested calls and targets", () => {
    const nested = expression({ type: "call", call: call("mul", [["a", ref("raw", "state")]]) });
    const document = setTarget(setArgument(sample(), [2], "x", nested), [2], ref("raw", "x"));
    const edited = renameNode(document, [1], "r");
    const node = nodeAt(edited, [2])!;
    expect(node.call.arguments[0]?.value).toEqual(
      expression({ type: "call", call: call("mul", [["a", ref("r", "state")]]) }),
    );
    expect(node.target).toEqual(ref("r", "x"));
  });

  it("refuse a name another node has, and unname without touching references", () => {
    const document = sample();
    expect(renameNode(document, [1], "cm")).toBe(document);
    const unnamed = renameNode(document, [1], null);
    expect(nodeAt(unnamed, [1])?.name).toBeNull();
    expect(nodeAt(unnamed, [2])?.call.arguments[0]?.value).toEqual(ref("raw"));
  });

  it("set a function, dropping arguments the new one does not take", () => {
    const max = { ...functionName("max"), module: name("77a83264-60a2-467c-9292-092cc08f051a") };
    const kept = setFunction(sample(), [2], max);
    expect(nodeAt(kept, [2])?.call.function).toEqual(max);
    expect(args(nodeAt(kept, [2]))).toEqual(["x", "min"]);
    const pruned = setFunction(sample(), [2], max, ["x", "max"]);
    expect(args(nodeAt(pruned, [2]))).toEqual(["x"]);
  });

  it("set an argument in place or append it, and clear one", () => {
    const replaced = setArgument(sample(), [2], "min", num("5"));
    expect(nodeAt(replaced, [2])?.call.arguments.map((a) => [a.name.text, a.value])).toEqual([
      ["x", ref("raw")],
      ["min", num("5")],
    ]);
    const added = setArgument(sample(), [2], "max", num("80"));
    expect(args(nodeAt(added, [2]))).toEqual(["x", "min", "max"]);
    const cleared = clearArgument(sample(), [2], "x");
    expect(args(nodeAt(cleared, [2]))).toEqual(["min"]);
    const document = sample();
    expect(clearArgument(document, [2], "nothing")).toBe(document);
  });

  it("bind and unbind a node's return value", () => {
    const bound = setTarget(sample(), [2], key("face/level"));
    expect(nodeAt(bound, [2])?.target).toEqual(key("face/level"));
    expect(nodeAt(setTarget(bound, [2], null), [2])?.target).toBeNull();
  });
});
