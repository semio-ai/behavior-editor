import { beforeAll, describe, expect, it } from "vitest";
import { type Example, GREET, READERS_PARALLEL, idOf } from "../../fixtures/examples";
import { MATH_FUNCTIONS, loadLanguage } from "../../fixtures/language";
import type { WasmBehaviorText } from "../text/wasm-language";
import { dropAt } from "./Diagram";
import { layoutDiagram } from "./diagram-layout";
import { diagramRows } from "./diagram-rows";
import { functionIndex } from "./functions";

let language: WasmBehaviorText;
beforeAll(async () => {
  language = await loadLanguage();
});

/** The example's text, parsed and resolved against the mock device's functions. */
function resolved(example: Example) {
  const { document } = language.parse(example.text);
  return { document, loaded: language.resolve(document, MATH_FUNCTIONS) };
}

function rowsOf(example: Example) {
  const { document, loaded } = resolved(example);
  const index = functionIndex(language.natives(), MATH_FUNCTIONS);
  return diagramRows(document, index, loaded.nodes);
}

describe("the diagram's rows", () => {
  it("list the tree from its root, then the detached nodes, each with its graph node", () => {
    const rows = rowsOf(GREET);
    expect(rows.map((r) => [r.key, r.title])).toEqual([
      ["0", "fallback"],
      ["0.0", "sequence"],
      ["0.0.0", "equal"],
      ["0.0.1", "equal"],
      ["0.0.2", "parallel"],
      ["0.0.2.0", "{rig/arm_raise} = number"],
      ["0.0.2.1", "{rig/arm_wave} = number"],
      ["0.0.2.2", "wait"],
      ["0.0.3", "{social/greeted} = boolean"],
      ["0.1", "parallel"],
      ["0.1.0", "{rig/arm_raise} = number"],
      ["0.1.1", "{rig/arm_wave} = number"],
      ["1", "fresh: not"],
      ["2", "raise: damp"],
      ["3", "sway: mul"],
      ["4", "rest_raise: damp"],
      ["5", "rest_wave: damp"],
    ]);
    const { loaded } = resolved(GREET);
    expect(rows.find((r) => r.key === "3")?.graphId).toBe(idOf(loaded, "sway"));
    expect(rows.find((r) => r.key === "0.0.2")?.graphId).toBe(idOf(loaded, "root.0.2"));
  });

  it("shape nodes by what they do and where they are", () => {
    const shapes = Object.fromEntries(rowsOf(GREET).map((r) => [r.key, [r.shape, r.glyph]]));
    expect(shapes["0"]).toEqual(["control", "?"]);
    expect(shapes["0.0"]).toEqual(["control", "→"]);
    expect(shapes["0.0.2"]).toEqual(["control", "⇉"]);
    expect(shapes["0.0.0"]).toEqual(["condition", ""]);
    expect(shapes["0.0.3"]).toEqual(["action", ""]);
    expect(shapes["2"]).toEqual(["data", ""]);
  });

  it("give one port per parameter, wired to the nodes it reads, nested calls included", () => {
    const rows = rowsOf(GREET);
    const raise = rows.find((r) => r.key === "2")!;
    expect(raise.ports).toEqual([
      { name: "target", text: "1", sources: [] },
      { name: "half_life", text: "0.12", sources: [] },
      { name: "state", text: "none", sources: [] },
      { name: "initial", text: "{rig/arm_raise}", sources: [] },
    ]);
    const sway = rows.find((r) => r.key === "3")!;
    expect(sway.ports[0]).toEqual({
      name: "a",
      text: "osc(t: {arora/time}, frequency: 1.6)",
      sources: [],
    });
    const wave = rows.find((r) => r.key === "0.0.2.1")!;
    expect(wave.ports).toEqual([{ name: "x", text: "@sway", sources: ["3"] }]);
    expect(rows.find((r) => r.key === "0.0.2")?.descendantKeys).toEqual([
      "0.0.2.0",
      "0.0.2.1",
      "0.0.2.2",
    ]);
  });
});

describe("the diagram's layout", () => {
  it("puts each detached node left of what reads it, clear of every other node", () => {
    const layout = layoutDiagram(rowsOf(READERS_PARALLEL), new Set());
    const box = (key: string) => layout.boxes.get(key)!;
    const all = [...layout.boxes.values()];
    const overlap = (a: (typeof all)[number], b: (typeof all)[number]) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    for (const d of ["1", "2", "3", "4", "5"].map(box)) {
      expect(all.filter((o) => o !== d && overlap(o, d))).toEqual([]);
    }
    // Each condition reads its own `lt`, placed left of it.
    for (const [reader, producer] of [
      ["0.0", "3"],
      ["0.1", "4"],
      ["0.2", "5"],
    ] as const) {
      expect(box(producer).x + box(producer).w).toBeLessThan(box(reader).x);
    }
    // raw → cm → near, mid, far: each column after the one it reads.
    expect(box("1").x).toBeLessThan(box("2").x);
    expect(box("2").x).toBeLessThan(box("3").x);
    expect(layout.wires.map((w) => `${w.from}>${w.to}`).sort()).toEqual([
      "1>2",
      "2>3",
      "2>4",
      "2>5",
      "3>0.0",
      "4>0.1",
      "5>0.2",
    ]);
    expect(layout.edges.map((e) => `${e.from}>${e.to}`)).toEqual(["0>0.0", "0>0.1", "0>0.2"]);
  });

  it("hides a folded node's subtree and has it stand for its nodes at a wire's end", () => {
    const rows = rowsOf(GREET);
    const layout = layoutDiagram(rows, new Set(["0.0.2"]));
    expect(layout.boxes.has("0.0.2.1")).toBe(false);
    const parallel = layout.boxes.get("0.0.2")!;
    expect(parallel.folded).toBe(true);
    expect(parallel.minis?.map((m) => m.key)).toEqual(["0.0.2.0", "0.0.2.1", "0.0.2.2"]);
    const intoFolded = layout.wires.filter((w) => w.to === "0.0.2");
    expect(intoFolded.map((w) => [w.from, w.port])).toEqual([
      ["2", null],
      ["3", null],
    ]);
  });

  it("drops a node into a control node, before a leaf, or among the detached nodes", () => {
    const rows = rowsOf(GREET);
    const layout = layoutDiagram(rows, new Set());
    const centre = (key: string) => {
      const b = layout.boxes.get(key)!;
      return [b.x + b.w / 2, b.y + b.h / 2] as const;
    };
    const dragged = rows.find((r) => r.key === "0.0.3")!;
    expect(dropAt(layout, dragged, ...centre("0.1"))).toEqual({ kind: "into", key: "0.1" });
    expect(dropAt(layout, dragged, ...centre("0.0.0"))).toEqual({ kind: "before", key: "0.0.0" });
    expect(dropAt(layout, dragged, ...centre("2"))).toEqual({ kind: "detach", key: "2" });
    expect(dropAt(layout, dragged, ...centre("0.0.3"))).toBeNull();
    // A node does not drop into its own subtree.
    const sequence = rows.find((r) => r.key === "0.0")!;
    expect(dropAt(layout, sequence, ...centre("0.0.2"))).toBeNull();
  });
});
