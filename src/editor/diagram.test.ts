import { beforeAll, describe, expect, it } from "vitest";
import { EXAMPLES, type Example, GREET, READERS_PARALLEL, idOf } from "../../fixtures/examples";
import { MATH_FUNCTIONS, loadLanguage } from "../../fixtures/language";
import type { BehaviorText } from "../text/language";
import { dropAt } from "./Diagram";
import { PAD, layoutDiagram } from "./diagram-layout";
import { diagramRows } from "./diagram-rows";
import { functionIndex } from "./functions";

let language: BehaviorText;
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
      ["0.0.0", "truthy"],
      ["0.0.1", "truthy"],
      ["0.0.2", "parallel"],
      ["0.0.2.0", "{rig/arm_raise} = damp"],
      ["0.0.2.1", "{rig/arm_wave} = mul"],
      ["0.0.2.2", "wait"],
      ["0.0.3", "{social/greeted} = identity"],
      ["0.1", "parallel"],
      ["0.1.0", "{rig/arm_raise} = damp"],
      ["0.1.1", "{rig/arm_wave} = damp"],
      ["1", "fresh: not"],
    ]);
    const { loaded } = resolved(GREET);
    expect(rows.find((r) => r.key === "1")?.graphId).toBe(idOf(loaded, "fresh"));
    expect(rows.find((r) => r.key === "0.0.2")?.graphId).toBe(idOf(loaded, "root.0.2"));
  });

  it("shape nodes by what they do and where they are", () => {
    const shapes = Object.fromEntries(rowsOf(GREET).map((r) => [r.key, [r.shape, r.glyph]]));
    expect(shapes["0"]).toEqual(["control", "?"]);
    expect(shapes["0.0"]).toEqual(["control", "→"]);
    expect(shapes["0.0.2"]).toEqual(["control", "⇉"]);
    // A condition returns a status from what it reads, and writes nothing.
    expect(shapes["0.0.0"]).toEqual(["condition", ""]);
    // `wait` writes its state; `identity` returns a value.
    expect(shapes["0.0.2.2"]).toEqual(["action", ""]);
    expect(shapes["0.0.3"]).toEqual(["action", ""]);
    expect(shapes["1"]).toEqual(["data", ""]);
  });

  it("give one port per parameter, wired to the nodes it reads, nested calls included", () => {
    const rows = rowsOf(GREET);
    const raise = rows.find((r) => r.key === "0.0.2.0")!;
    expect(raise.ports).toEqual([
      { name: "target", text: "1", sources: [] },
      { name: "half_life", text: "0.12", sources: [] },
      { name: "state", text: "none", sources: [] },
      { name: "initial", text: "{rig/arm_raise}", sources: [] },
    ]);
    const wave = rows.find((r) => r.key === "0.0.2.1")!;
    expect(wave.ports[0]).toEqual({
      name: "a",
      text: "oscillator(t: {arora/time}, frequency: 1.6)",
      sources: [],
    });
    expect(rows.find((r) => r.key === "0.0.1")?.ports).toEqual([
      { name: "x", text: "@fresh._ret", sources: ["1"] },
    ]);
    expect(rows.find((r) => r.key === "0.0.2")?.descendantKeys).toEqual([
      "0.0.2.0",
      "0.0.2.1",
      "0.0.2.2",
    ]);
  });
});

describe("the diagram's layout", () => {
  it.each(EXAMPLES.map((e) => [e.file, e] as const))(
    "%s: every node lies within the drawing, folded or not",
    (_, example) => {
      const rows = rowsOf(example);
      const foldable = rows.filter((r) => r.childKeys.length && r.depth >= 1).map((r) => r.key);
      for (const folds of [new Set<string>(), new Set(foldable)]) {
        const layout = layoutDiagram(rows, folds);
        for (const box of layout.boxes.values()) {
          expect(box.x, box.row.key).toBeGreaterThanOrEqual(0);
          expect(box.y, box.row.key).toBeGreaterThanOrEqual(0);
          expect(box.x + box.w, box.row.key).toBeLessThanOrEqual(layout.width);
          expect(box.y + box.h, box.row.key).toBeLessThanOrEqual(layout.height);
        }
        const xs = [...layout.boxes.values()].map((b) => b.x);
        expect(Math.min(...xs)).toBe(PAD);
      }
    },
  );

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

  it("puts a detached node's producer in an earlier column, whatever the file's order", () => {
    // `cm` comes before the `raw` it reads.
    const text = READERS_PARALLEL.text.replace(
      /^(raw: .*\n)(cm: .*\n)/m,
      (_, raw: string, cm: string) => cm + raw,
    );
    expect(text.indexOf("cm:")).toBeLessThan(text.indexOf("raw:"));
    const layout = layoutDiagram(rowsOf({ ...READERS_PARALLEL, text }), new Set());
    const box = (key: string) => layout.boxes.get(key)!;
    expect(box("1").row.title).toContain("cm");
    expect(box("2").x + box("2").w).toBeLessThan(box("1").x);
    expect(box("1").x + box("1").w).toBeLessThan(box("3").x);
  });

  it("lays out detached nodes that read each other in a cycle", () => {
    const text = "running\n\na: add(a: @b, b: 1)\nb: add(a: @a, b: 1)\n";
    const layout = layoutDiagram(rowsOf({ ...READERS_PARALLEL, text }), new Set());
    expect(layout.boxes.has("1") && layout.boxes.has("2")).toBe(true);
  });

  it("hides a folded node's subtree and has it stand for its nodes at a wire's end", () => {
    const rows = rowsOf(GREET);
    const layout = layoutDiagram(rows, new Set(["0.0"]));
    expect(layout.boxes.has("0.0.1")).toBe(false);
    const sequence = layout.boxes.get("0.0")!;
    expect(sequence.folded).toBe(true);
    expect(sequence.minis?.map((m) => m.key)).toEqual(
      rows.find((r) => r.key === "0.0")!.descendantKeys,
    );
    expect(layout.wires.filter((w) => w.to === "0.0").map((w) => [w.from, w.port])).toEqual([
      ["1", null],
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
    expect(dropAt(layout, dragged, ...centre("1"))).toEqual({ kind: "detach", key: "1" });
    expect(dropAt(layout, dragged, ...centre("0.0.3"))).toBeNull();
    // A node does not drop into its own subtree.
    const sequence = rows.find((r) => r.key === "0.0")!;
    expect(dropAt(layout, sequence, ...centre("0.0.2"))).toBeNull();
  });
});
