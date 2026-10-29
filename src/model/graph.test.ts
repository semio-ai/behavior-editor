import { describe, expect, it } from "vitest";
import { EXAMPLES } from "../../fixtures/examples";
import { MATH_FUNCTIONS, loadLanguage } from "../../fixtures/language";
import { type Graph, applyDiff, changedNodes, isEmptyDiff } from "./graph";

/** `graph` with its nodes in id order: a graph's node order means nothing to an interpreter. */
const sorted = (graph: Graph): Graph => ({
  ...graph,
  nodes: [...(graph.nodes ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
});

describe("applyDiff", () => {
  it("takes every example's graph to every other's by the diff the language gives", async () => {
    const language = await loadLanguage();
    const graphs = [
      {},
      ...EXAMPLES.map(
        (e) => language.resolve(language.parse(e.text).document, MATH_FUNCTIONS).graph,
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
