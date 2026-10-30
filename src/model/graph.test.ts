import { describe, expect, it } from "vitest";
import { EXAMPLES } from "../../fixtures/examples";
import { loadLanguage } from "../../fixtures/language";
import { DATAFLOW_FUNCTIONS } from "../../fixtures/local-arora";
import { type Graph, applyDiff, changedNodes, isEmptyDiff } from "./graph";

/**
 * Every `f32` in `value` as the float it is: the language writes one as the
 * nearest decimal or as its exact widening, the same `f32` either way.
 */
const f32s = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(f32s)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value).map(([k, v]) => [
            k,
            k === "f32" && typeof v === "number" ? Math.fround(v) : f32s(v),
          ]),
        )
      : value;

/**
 * `graph` with its nodes in id order, a graph's node order meaning nothing to
 * an interpreter, and its `f32`s as the floats they are.
 */
const sorted = (graph: Graph): Graph =>
  f32s({
    ...graph,
    nodes: [...(graph.nodes ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  }) as Graph;

describe("applyDiff", () => {
  it("takes every example's graph to every other's by the diff the language gives", async () => {
    const language = await loadLanguage();
    const graphs = [
      {},
      ...EXAMPLES.map(
        (e) => language.resolve(language.parse(e.text).document, DATAFLOW_FUNCTIONS).graph,
      ),
    ];
    for (const from of graphs) {
      for (const to of graphs) {
        const diff = language.diff(from, to);
        expect(sorted(applyDiff(from, diff))).toEqual(sorted(to));
        expect(isEmptyDiff(diff)).toBe(from === to);
      }
    }
  });

  it("leaves the graph it applies to as it was, and refuses a binding onto no node", () => {
    const graph: Graph = { root: "a", nodes: [{ id: "a", function: "f", bind: { p: { key: "k" } } }] };
    const before = structuredClone(graph);
    expect(applyDiff(graph, { unbind: [{ node: "a", port: "p" }] })).toEqual({
      root: "a",
      nodes: [{ id: "a", function: "f" }],
    });
    expect(graph).toEqual(before);
    expect(() =>
      applyDiff(graph, { remove: ["a"], bind: [{ node: "a", port: "p", source: { key: "j" } }] }),
    ).toThrow(/not in the graph/);
  });

  it("counts the nodes a diff sets or binds as changed, not those it removes", () => {
    const changed = changedNodes({
      remove: ["r"],
      set: [{ id: "s", function: "f" }],
      unbind: [{ node: "u", port: "p" }],
      bind: [{ node: "b", port: "p", source: { value: "unit" } }],
    });
    expect([...changed].sort()).toEqual(["b", "s", "u"]);
  });
});
