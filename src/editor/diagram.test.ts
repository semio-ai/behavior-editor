import { beforeAll, describe, expect, it } from "vitest";
import {
  EXAMPLES,
  type Example,
  GREET,
  READERS_PARALLEL,
  RETURN_VALUES,
  SMILE,
  idOf,
} from "../../fixtures/examples";
import { MATH_FUNCTIONS, loadLanguage } from "../../fixtures/language";
import type { BehaviorText } from "../text/language";
import { dropAt } from "./Diagram";
import { PAD, layoutDiagram, outputY } from "./diagram-layout";
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
      { name: "x", text: "@fresh._ret", sources: [{ key: "1", output: "_ret" }] },
    ]);
    expect(rows.find((r) => r.key === "0.0.2")?.descendantKeys).toEqual([
      "0.0.2.0",
      "0.0.2.1",
      "0.0.2.2",
    ]);
  });
});

/** The layout of `text`, resolved against the mock device's functions. */
function layoutOf(text: string) {
  const { document } = language.parse(text);
  const loaded = language.resolve(document, MATH_FUNCTIONS);
  const index = functionIndex(language.natives(), MATH_FUNCTIONS);
  return layoutDiagram(diagramRows(document, index, loaded.nodes), new Set());
}

describe("the diagram's outputs", () => {
  it("names each output: _ret where it is written, then the parameters a function writes back", () => {
    const rows = rowsOf(RETURN_VALUES);
    const outputs = (key: string) => rows.find((r) => r.key === key)!.outputs;
    // A named node's return value, read by others, written nowhere.
    expect(outputs("1")).toEqual([{ name: "_ret", text: "" }]);
    // A node binding its return value to a store key.
    expect(outputs("3")).toEqual([{ name: "_ret", text: "{face/level}" }]);
    // A tree leaf binding its return value; a condition's status is its pill, not an output.
    expect(outputs("0.0.1")).toEqual([{ name: "_ret", text: "{face/look}" }]);
    expect(outputs("0.0.0")).toEqual([]);
    // A function writing a parameter back lists it after _ret.
    const mouth = rowsOf(SMILE).find((r) => r.node.name?.text === "mouth")!;
    expect(mouth.outputs).toEqual([
      { name: "_ret", text: "{rig/mouth_corner}" },
      { name: "state", text: "" },
    ]);
  });

  it("reads an output a reference names by its parameter's id", () => {
    const damp = MATH_FUNCTIONS.find((f) => f.name === "damp")!.function;
    const state = Object.entries(damp.parameters).find(([, p]) => p.name === "state")![0];
    const text = `${SMILE.text}watch: identity(x: @mouth.${state})\n`;
    const { document } = language.parse(text);
    const loaded = language.resolve(document, MATH_FUNCTIONS);
    const index = functionIndex(language.natives(), MATH_FUNCTIONS);
    const rows = diagramRows(document, index, loaded.nodes);
    const mouth = rows.find((r) => r.node.name?.text === "mouth")!;
    const watch = rows.find((r) => r.node.name?.text === "watch")!;
    expect(watch.ports[0]!.sources).toEqual([{ key: mouth.key, output: "state" }]);
    const layout = layoutDiagram(rows, new Set());
    const box = layout.boxes.get(mouth.key)!;
    const wire = layout.wires.find((w) => w.from === mouth.key && w.to === watch.key)!;
    expect(wire.d.startsWith(`M${box.x + box.w},${box.y + outputY(box, 1)} `)).toBe(true);
  });

  it("tells apart the wires of one argument reading two outputs of a node", () => {
    const text = `${SMILE.text}watch: identity(x: f64[@mouth._ret, @mouth.state])\n`;
    const { document } = language.parse(text);
    const loaded = language.resolve(document, MATH_FUNCTIONS);
    const index = functionIndex(language.natives(), MATH_FUNCTIONS);
    const layout = layoutDiagram(diagramRows(document, index, loaded.nodes), new Set());
    const ids = layout.wires.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id.endsWith(">5@0"))).toEqual(["3._ret>5@0", "3.state>5@0"]);
  });

  it("routes a wire back to a reader on its left over both nodes", () => {
    const text =
      "sequence\n  identity(x: @m.state)\n  m: damp(target: 1, half_life: 0.1, state: none)\n";
    const { document } = language.parse(text);
    const loaded = language.resolve(document, MATH_FUNCTIONS);
    const index = functionIndex(language.natives(), MATH_FUNCTIONS);
    const layout = layoutDiagram(diagramRows(document, index, loaded.nodes), new Set());
    const [reader, producer] = [layout.boxes.get("0.0")!, layout.boxes.get("0.1")!];
    expect(reader.x + reader.w).toBeLessThan(producer.x);
    const wire = layout.wires.find((w) => w.from === "0.1" && w.to === "0.0")!;
    expect(wire.d).not.toContain("C");
    const ys = [...wire.d.matchAll(/V(-?[\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBeLessThan(Math.min(reader.y, producer.y));
  });

  it("routes a wire to a reader under its producer across the gap between them", () => {
    const layout = layoutOf("p: sequence\n  succeed\n  identity(x: @p._ret)\n");
    const [producer, reader] = [layout.boxes.get("0")!, layout.boxes.get("0.1")!];
    const wire = layout.wires.find((w) => w.from === "0" && w.to === "0.1")!;
    const across = Number(/V(-?[\d.]+)/.exec(wire.d)![1]);
    expect(across).toBeGreaterThan(producer.y + producer.h);
    expect(across).toBeLessThan(reader.y);
  });

  it("routes a wire to a reader rows under its producer clear of the nodes between", () => {
    const layout = layoutOf(
      "sequence\n  a: identity(x: 1)\n  succeed\n  succeed\n  succeed\n  identity(x: @a._ret)\n",
    );
    const wire = layout.wires.find((w) => w.from === "0.0" && w.to === "0.4")!;
    const between = ["0.1", "0.2", "0.3"].map((k) => layout.boxes.get(k)!);
    expect(between[0]!.y).toBeGreaterThan(layout.boxes.get("0.0")!.y);
    const [x, across] = [...wire.d.matchAll(/[HV](-?[\d.]+)/g)].map((m) => Number(m[1]));
    for (const b of between) {
      // The lane passes no node, and the way down passes right of each.
      expect(across! < b.y || across! > b.y + b.h).toBe(true);
      expect(x).toBeGreaterThan(b.x + b.w);
    }
  });

  it.each([
    [
      "a reader in a nested sequence",
      "sequence\n  sequence\n    identity(x: @a._ret)\n  a: identity(x: 1)\n",
    ],
    [
      "a reader under its producer beside a sibling",
      "sequence\n  p: sequence\n    identity(x: @p._ret)\n  damp(target: 1, half_life: 0.1, state: none)\n",
    ],
    [
      "a parent reading its child beside a sibling",
      "sequence_star(index: @a._ret)\n  a: identity(x: 1u16)\n  damp(target: 1, half_life: 0.1, state: none)\n",
    ],
    [
      "a reader on the producer's left",
      "sequence\n  identity(x: @m.state)\n  m: damp(target: 1, half_life: 0.1, state: none)\n",
    ],
  ])("routes a wire back clear of every node: %s", (_, text) => {
    const layout = layoutOf(text);
    const back = layout.wires.filter((w) => !w.d.includes("C"));
    expect(back.length).toBeGreaterThan(0);
    for (const wire of back) {
      const points = [...wire.d.matchAll(/([MHV])(-?[\d.]+)(?:,(-?[\d.]+))?/g)];
      let [x, y] = [Number(points[0]![2]), Number(points[0]![3])];
      const segments: [number, number, number, number][] = [];
      for (const [, op, v] of points.slice(1)) {
        const [nx, ny] = op === "H" ? [Number(v), y] : [x, Number(v)];
        segments.push([x, y, nx, ny]);
        [x, y] = [nx, ny];
      }
      for (const box of layout.boxes.values()) {
        const inside = ([ax, ay, bx, by]: [number, number, number, number]) =>
          Math.min(ax, bx) < box.x + box.w &&
          Math.max(ax, bx) > box.x &&
          Math.min(ay, by) < box.y + box.h &&
          Math.max(ay, by) > box.y;
        expect(segments.filter(inside), `${wire.id} through ${box.row.key}`).toEqual([]);
      }
    }
  });

  it("curves a wire to the sibling on its right within the gap between them", () => {
    const layout = layoutOf("sequence\n  a: identity(x: 1)\n  identity(x: @a._ret)\n");
    const [producer, reader] = [layout.boxes.get("0.0")!, layout.boxes.get("0.1")!];
    const wire = layout.wires.find((w) => w.from === "0.0" && w.to === "0.1")!;
    const xs = /C(-?[\d.]+),[^ ]+ (-?[\d.]+),/.exec(wire.d)!.slice(1).map(Number);
    for (const x of xs) {
      expect(x).toBeGreaterThanOrEqual(producer.x + producer.w);
      expect(x).toBeLessThanOrEqual(reader.x);
    }
  });

  it("starts a wire at the output it reads", () => {
    const layout = layoutDiagram(rowsOf(RETURN_VALUES), new Set());
    const level = layout.boxes.get("3")!;
    const wire = layout.wires.find((w) => w.from === "3" && w.to === "0.0.1")!;
    expect(wire.d.startsWith(`M${level.x + level.w},${level.y + outputY(level, 0)} `)).toBe(true);
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
