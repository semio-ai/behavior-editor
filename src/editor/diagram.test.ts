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
import { loadLanguage } from "../../fixtures/language";
import { DATAFLOW_FUNCTIONS } from "../../fixtures/local-arora";
import type { BehaviorText } from "../text/language";
import { dropAt } from "./Diagram";
import type { FrozenTy, MethodSignature } from "../model/signature";
import { PAD, keySummary, layoutDiagram, outputY, portY } from "./diagram-layout";
import { diagramRows } from "./diagram-rows";
import { functionIndex } from "./functions";

let language: BehaviorText;
beforeAll(async () => {
  language = await loadLanguage();
});

/** The example's text, parsed and resolved against `@arora/dataflow`'s functions. */
function resolved(example: Example) {
  const { document } = language.parse(example.text);
  return { document, loaded: language.resolve(document, DATAFLOW_FUNCTIONS) };
}

function rowsOf(example: Example) {
  const { document, loaded } = resolved(example);
  const index = functionIndex(language.natives(), DATAFLOW_FUNCTIONS);
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
      ["0.0.2.0", "damp"],
      ["0.0.2.1", "{rig/arm_wave} = multiply"],
      ["0.0.2.2", "fallback"],
      ["0.0.2.2.0", "equal"],
      ["0.0.2.2.1", "running"],
      ["0.0.3", "{social/greeted} = not"],
      ["0.1", "parallel"],
      ["0.1.0", "damp"],
      ["0.1.1", "damp"],
      ["0.1.2", "{social/rested_at} = time"],
      ["1", "fresh: not"],
      ["2", "waved: greaterthan"],
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
    // A damp writes its state back; a leaf binding its return value to a key writes it.
    expect(shapes["0.0.2.0"]).toEqual(["action", ""]);
    expect(shapes["0.0.3"]).toEqual(["action", ""]);
    expect(shapes["0.0.2.2.1"]).toEqual(["action", ""]);
    expect(shapes["1"]).toEqual(["data", ""]);
  });

  it("give one port per argument, wired to the nodes it reads, nested calls included", () => {
    const rows = rowsOf(GREET);
    const raise = rows.find((r) => r.key === "0.0.2.0")!;
    expect(raise.ports).toEqual([
      { name: "in", text: "1f32", sources: [] },
      { name: "param.half_life", text: "0.12f32", sources: [] },
      { name: "dt", text: "{arora/dt}", sources: [], key: "arora/dt" },
      // A key two nodes both read and write is a state they share: no link between them.
      { name: "state", text: "{rig/arm_raise}", sources: [], key: "rig/arm_raise" },
    ]);
    const wave = rows.find((r) => r.key === "0.0.2.1")!;
    expect(wave.ports[0]).toEqual({
      name: "operand_0",
      text: "oscillator(frequency: 1.6f32, t: {arora/time})",
      sources: [],
    });
    expect(rows.find((r) => r.key === "0.0.1")?.ports).toEqual([
      { name: "a", text: "@fresh._ret", sources: [{ key: "1", output: "_ret" }] },
      { name: "b", text: "true", sources: [] },
    ]);
    expect(rows.find((r) => r.key === "0.0.2")?.descendantKeys).toEqual([
      "0.0.2.0",
      "0.0.2.1",
      "0.0.2.2",
      "0.0.2.2.0",
      "0.0.2.2.1",
    ]);
  });
});

/** The layout of `text`, resolved against `@arora/dataflow`'s functions. */
function layoutOf(text: string) {
  const { document } = language.parse(text);
  const loaded = language.resolve(document, DATAFLOW_FUNCTIONS);
  const index = functionIndex(language.natives(), DATAFLOW_FUNCTIONS);
  return layoutDiagram(diagramRows(document, index, loaded.nodes), new Set());
}

describe("the diagram's outputs", () => {
  it("names each output: _ret where it is written, then the parameters a function writes back", () => {
    const rows = rowsOf(RETURN_VALUES);
    const outputs = (key: string) => rows.find((r) => r.key === key)!.outputs;
    // A named node's return value, read by others, written nowhere; a
    // function of `@arora/dataflow` writes its state back, listed after it.
    expect(outputs("1")).toEqual([
      { name: "_ret", text: "" },
      { name: "state", text: "" },
    ]);
    // A node binding its return value to a store key.
    expect(outputs("3")).toEqual([
      { name: "_ret", text: "{face/level}", key: "face/level" },
      { name: "state", text: "" },
    ]);
    // A tree leaf binding its return value; a condition's status is its pill, not an output.
    expect(outputs("0.0.1")).toEqual([
      { name: "_ret", text: "{face/look}", key: "face/look" },
      { name: "state", text: "" },
    ]);
    expect(outputs("0.0.0")).toEqual([]);
    // The parameter a function writes back.
    const mouth = rowsOf(SMILE).find((r) => r.node.name?.text === "mouth")!;
    expect(mouth.outputs).toEqual([
      { name: "_ret", text: "{rig/mouth_corner}", key: "rig/mouth_corner" },
      { name: "state", text: "" },
    ]);
  });

  it("reads an output a reference names by its parameter's id", () => {
    const damp = DATAFLOW_FUNCTIONS.find((f) => f.name === "damp")!.function;
    const state = Object.entries(damp.parameters).find(([, p]) => p.name === "state")![0];
    const text = `${SMILE.text}watch: add(operand_0: @mouth.${state})\n`;
    const { document } = language.parse(text);
    const loaded = language.resolve(document, DATAFLOW_FUNCTIONS);
    const index = functionIndex(language.natives(), DATAFLOW_FUNCTIONS);
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
    const text = `${SMILE.text}watch: add(operand_0: f32[@mouth._ret, @mouth.state])\n`;
    const { document } = language.parse(text);
    const loaded = language.resolve(document, DATAFLOW_FUNCTIONS);
    const index = functionIndex(language.natives(), DATAFLOW_FUNCTIONS);
    const layout = layoutDiagram(diagramRows(document, index, loaded.nodes), new Set());
    const ids = layout.wires.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id.endsWith(">5@0"))).toEqual(["3._ret>5@0", "3.state>5@0"]);
  });

  it("routes a wire back to a reader on its left over both nodes", () => {
    const text =
      "sequence\n  add(operand_0: @m.state)\n  m: damp(in: 1f32, param.half_life: 0.1f32, state: ())\n";
    const { document } = language.parse(text);
    const loaded = language.resolve(document, DATAFLOW_FUNCTIONS);
    const index = functionIndex(language.natives(), DATAFLOW_FUNCTIONS);
    const layout = layoutDiagram(diagramRows(document, index, loaded.nodes), new Set());
    const [reader, producer] = [layout.boxes.get("0.0")!, layout.boxes.get("0.1")!];
    expect(reader.x + reader.w).toBeLessThan(producer.x);
    const wire = layout.wires.find((w) => w.from === "0.1" && w.to === "0.0")!;
    expect(wire.d).not.toContain("C");
    const ys = [...wire.d.matchAll(/V(-?[\d.]+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...ys)).toBeLessThan(Math.min(reader.y, producer.y));
  });

  it("routes a wire to a reader under its producer across the gap between them", () => {
    const layout = layoutOf("p: sequence\n  succeed\n  add(operand_0: @p._ret)\n");
    const [producer, reader] = [layout.boxes.get("0")!, layout.boxes.get("0.1")!];
    const wire = layout.wires.find((w) => w.from === "0" && w.to === "0.1")!;
    const across = Number(/V(-?[\d.]+)/.exec(wire.d)![1]);
    expect(across).toBeGreaterThan(producer.y + producer.h);
    expect(across).toBeLessThan(reader.y);
  });

  it("routes a wire to a reader rows under its producer clear of the nodes between", () => {
    const layout = layoutOf(
      "sequence\n  a: add(operand_0: 1f32)\n  succeed\n  succeed\n  succeed\n  add(operand_0: @a._ret)\n",
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
      "sequence\n  sequence\n    add(operand_0: @a._ret)\n  a: add(operand_0: 1f32)\n",
    ],
    [
      "a reader under its producer beside a sibling",
      "sequence\n  p: sequence\n    add(operand_0: @p._ret)\n  damp(in: 1f32, param.half_life: 0.1f32, state: ())\n",
    ],
    [
      "a parent reading its child beside a sibling",
      "sequence_star(index: @a._ret)\n  a: add(operand_0: 1u16)\n  damp(in: 1f32, param.half_life: 0.1f32, state: ())\n",
    ],
    [
      "a reader on the producer's left",
      "sequence\n  add(operand_0: @m.state)\n  m: damp(in: 1f32, param.half_life: 0.1f32, state: ())\n",
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
    const layout = layoutOf("sequence\n  a: add(operand_0: 1f32)\n  add(operand_0: @a._ret)\n");
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
    const text = "running\n\na: add(operand_0: @b, operand_1: 1f32)\nb: add(operand_0: @a, operand_1: 1f32)\n";
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
      ["2", null],
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

const F32: FrozenTy = { type: "primitive", value: { kind: "f32" } };

/** A robot's module: a node sensing, conditions on what it senses, and one acting. */
function robotFunctions(): MethodSignature[] {
  const status = language.natives().find((n) => n.name === "equal")!.function.returnType;
  let count = 0;
  const uuid = () => `00000000-0000-4000-8000-${(++count).toString(16).padStart(12, "0")}`;
  const module = uuid();
  const fn = (name: string, params: string[], mutable: string[] = []): MethodSignature => {
    const ids = [...params, ...mutable].map(uuid);
    return {
      module_id: module,
      id: uuid(),
      name,
      function: {
        parameters: Object.fromEntries(
          [...params, ...mutable].map((p, i) => [
            ids[i]!,
            { name: p, type: F32, mutable: mutable.includes(p) },
          ]),
        ),
        parameterOrdering: ids,
        returnType: status,
      },
    };
  };
  return [
    fn("sense", [...SENSORS.map(([p]) => p)], ["sensed", "posture"]),
    fn("lying", ["posture"], ["mode", "held"]),
    fn("falling", ["posture"], ["mode"]),
    fn("blocked", ["sensed"]),
    fn("act", ["skill", "vx", "vy", "vyaw", "sensed"], ["targets", "stiffness"]),
  ];
}

const SENSORS = [
  ["vx", "command.vx"],
  ["vy", "command.vy"],
  ["gyro", "imu.gyro"],
  ["orientation", "imu.orientation"],
  ["accelerometer", "imu.accelerometer"],
  ["joint_positions", "joints.position"],
  ["joint_velocities", "joints.velocity"],
  ["efforts", "joints.effort"],
  ["fsr", "feet.fsr"],
  ["bumpers", "feet.bumpers"],
  ["touch", "touch.pressed"],
  ["sonar", "sonar.echo"],
  ["temperatures", "joints.temperature"],
  ["base_position", "sim/base.position"],
  ["base_velocity", "sim/base.linear_velocity"],
] as const;

/**
 * Sense, then the first condition that holds sets the skill, then act on it:
 * one node read by seven, a key six nodes write and one reads, a key three
 * nodes read and write, and fifteen keys no node writes.
 */
const ROBOT = `sequence
  sense: sense(${SENSORS.map(([p, k]) => `${p}: {${k}}`).join(", ")}, sensed: {robot/sensed}, posture: {robot/posture})
  fallback
${["lying", "falling", "lying"]
  .map(
    (c, i) =>
      `    sequence\n      ${c}(posture: @sense.posture, mode: {robot/mode}${c === "lying" ? ", held: 0f32" : ""})\n      set_string(variable: {robot/skill}, value: "s${i}")\n`,
  )
  .join("")}${[3, 4]
  .map(
    (i) =>
      `    sequence\n      blocked(sensed: @sense.sensed)\n      set_string(variable: {robot/skill}, value: "s${i}")\n`,
  )
  .join("")}    set_string(variable: {robot/skill}, value: "walk")
  act(skill: {robot/skill}, vx: {command.vx}, vy: {command.vy}, vyaw: {command.vyaw}, sensed: @sense.sensed, targets: {joints.target_position}, stiffness: {joints.stiffness})
`;

function robotRows() {
  const functions = robotFunctions();
  const { document } = language.parse(ROBOT);
  const loaded = language.resolve(document, functions);
  return diagramRows(document, functionIndex(language.natives(), functions), loaded.nodes);
}

/** The segments of a path of `M`, `H` and `V` commands. */
function segmentsOf(d: string): [number, number, number, number][] {
  const points = [...d.matchAll(/([MHV])(-?[\d.]+)(?:,(-?[\d.]+))?/g)];
  let [x, y] = [Number(points[0]![2]), Number(points[0]![3])];
  const segments: [number, number, number, number][] = [];
  for (const [, op, v] of points.slice(1)) {
    const [nx, ny] = op === "H" ? [Number(v), y] : [x, Number(v)];
    segments.push([x, y, nx, ny]);
    [x, y] = [nx, ny];
  }
  return segments;
}

describe("the diagram's links through keys", () => {
  it("links each node writing a key to each node reading it, but between two holding it", () => {
    const rows = robotRows();
    const row = (title: RegExp, at = 0) => rows.filter((r) => title.test(r.title))[at]!;
    const act = row(/^act/);
    const skill = act.ports.find((p) => p.name === "skill")!;
    // Six nodes write the skill, one reads it.
    expect(skill.sources).toHaveLength(6);
    expect(skill.sources.every((s) => s.via === "robot/skill" && s.output === "variable")).toBe(true);
    expect(rows.filter((r) => r.title === "set_string").map((r) => r.key)).toEqual(
      skill.sources.map((s) => s.key),
    );
    // Each condition reads and writes the mode: a state they share, linked to none.
    for (const condition of rows.filter((r) => /^(lying|falling)$/.test(r.title))) {
      expect(condition.ports.find((p) => p.name === "mode")!.sources).toEqual([]);
      expect(condition.outputs.find((o) => o.name === "mode")).toEqual({
        name: "mode",
        text: "{robot/mode}",
        key: "robot/mode",
      });
    }
    // A node holding a key it alone reads is linked to nothing through it.
    expect(row(/^sense:/).ports.every((p) => p.sources.length === 0)).toBe(true);
    // The references, as ever.
    expect(act.ports.find((p) => p.name === "sensed")!.sources).toEqual([
      { key: "0.0", output: "sensed" },
    ]);
  });

  it("links a writer to a reader that holds the key, and stops linking when asked", () => {
    // GREET: the wave's leaf writes {rig/arm_wave}, which the resting damp eases.
    const rows = rowsOf(GREET);
    const damp = rows.find((r) => r.key === "0.1.1")!;
    expect(damp.ports.find((p) => p.name === "state")!.sources).toEqual([
      { key: "0.0.2.1", output: "_ret", via: "rig/arm_wave" },
    ]);
    const store = (storeLinks: boolean) =>
      layoutDiagram(rows, new Set(), { storeLinks })
        .wires.filter((w) => w.store)
        .map((w) => `${w.from}>${w.to} ${w.carries.join()}`);
    expect(store(true).sort()).toEqual([
      "0.0.2.1>0.1.1 {rig/arm_wave}",
      "0.0.3>1 {social/greeted}",
      "0.1.2>2 {social/rested_at}",
    ]);
    expect(store(false)).toEqual([]);
  });
});

describe("the diagram's packing", () => {
  it("sums up keys in short", () => {
    const keys = SENSORS.map(([, k]) => k);
    expect(keySummary(keys, 60)).toBe(
      "command, imu, joints, feet, touch.pressed, sonar.echo, sim/base",
    );
    expect(keySummary(["joints.target_position", "joints.stiffness", "robot/skill"], 60)).toBe(
      "joints.{target_position,stiffness}, robot/skill",
    );
    expect(keySummary(["a/b.c", "a/b.d", "a/e"], 60)).toBe("a/{b.c,b.d,e}");
  });

  it("sums up the keys no node writes in one line, and lists them under it unpacked", () => {
    const rows = robotRows();
    const sense = rows.find((r) => r.title.startsWith("sense:"))!;
    const packed = layoutDiagram(rows, new Set(), { packed: new Set([sense.key]) });
    const loose = layoutDiagram(rows, new Set());
    const box = packed.boxes.get(sense.key)!;
    expect(box.packed).toBe(true);
    expect(box.lines[0]).toMatch(/^▸ 15 keys: command, imu, joints/);
    expect(new Set(box.portLine.slice(0, 15))).toEqual(new Set([0]));
    expect(box.summaries[0]).toMatchObject({ output: false, from: 0 });
    expect(box.summaries[0]!.title.split("\n")).toHaveLength(15);
    // A port written back shares its line with its output, where its wires leave.
    const posture = sense.ports.findIndex((p) => p.name === "posture");
    const out = sense.outputs.findIndex((o) => o.name === "posture");
    expect(box.lines[box.portLine[posture]!]).toBe("posture ⇄ {robot/posture}");
    expect(outputY(box, out)).toBe(portY(box, posture));
    // Its return value, a status no node reads, written nowhere: packed, not listed.
    expect(box.outputLines).toEqual([]);
    const open = loose.boxes.get(sense.key)!;
    expect(open.packed).toBe(false);
    expect(open.lines[0]).toBe("▾ 15 keys");
    expect(open.lines[1]).toBe("  vx  {command.vx}");
    expect(open.h).toBeGreaterThan(box.h * 3);
    // A native writing a key: its line says so.
    const set = rows.find((r) => r.title === "set_string")!;
    const all = layoutDiagram(rows, new Set(), { packed: new Set(rows.map((r) => r.key)) });
    expect(all.boxes.get(set.key)!.lines[0]).toBe("variable → {robot/skill}");
  });

  it("joins the links reaching one line of a packed node, and counts them", () => {
    const rows = robotRows();
    const act = rows.find((r) => r.title.startsWith("act"))!;
    const skill = act.ports.findIndex((p) => p.name === "skill");
    const packed = layoutDiagram(rows, new Set(), { packed: new Set([act.key]) });
    const box = packed.boxes.get(act.key)!;
    expect(packed.badges).toEqual([
      expect.objectContaining({ to: act.key, y: box.y + portY(box, skill), count: 6 }),
    ]);
    expect(layoutDiagram(rows, new Set()).badges).toEqual([]);
    // Two outputs of one node read by one packed node: one wire, carrying both.
    const text = `${SMILE.text}watch: add(operand_0: @mouth._ret, operand_1: @mouth.state)\n`;
    const { document } = language.parse(text);
    const loaded = language.resolve(document, DATAFLOW_FUNCTIONS);
    const index = functionIndex(language.natives(), DATAFLOW_FUNCTIONS);
    const smile = diagramRows(document, index, loaded.nodes);
    const watch = smile.find((r) => r.node.name?.text === "watch")!;
    const joined = layoutDiagram(smile, new Set(), { packed: new Set([watch.key]) });
    const into = joined.wires.filter((w) => w.to === watch.key);
    expect(into.map((w) => w.carries)).toEqual([["@mouth._ret", "@mouth.state"]]);
    expect(joined.boxes.get(watch.key)!.lines.slice(0, 2).join(" ")).toBe(
      "operand_0, operand_1  @mouth._ret, @mouth.state",
    );
    expect(joined.badges.map((b) => b.count)).toEqual([2]);
    expect(layoutDiagram(smile, new Set()).wires.filter((w) => w.to === watch.key)).toHaveLength(2);
  });

  it.each([false, true])(
    "stacks subtrees too wide side by side, and routes every wire clear of the nodes (packed: %s)",
    (pack) => {
      const rows = robotRows();
      const layout = layoutDiagram(rows, new Set(), {
        packed: new Set(pack ? rows.map((r) => r.key) : []),
      });
      const fallback = rows.find((r) => r.title === "fallback")!;
      const column = fallback.childKeys.map((k) => layout.boxes.get(k)!);
      const holder = layout.boxes.get(fallback.key)!;
      for (const [a, b] of column.slice(1).map((next, i) => [column[i]!, next] as const)) {
        expect(b.y).toBeGreaterThan(a.y + a.h);
        expect(b.x).toBe(holder.x + 24);
      }
      // Each sequence in the column holds its two leaves in a row on its right.
      for (const sequence of column.filter((c) => c.row.childKeys.length)) {
        const [first, second] = sequence.row.childKeys.map((k) => layout.boxes.get(k)!);
        expect([first!.y, second!.y]).toEqual([sequence.y, sequence.y]);
        expect(first!.x).toBeGreaterThan(sequence.x + sequence.w);
        expect(second!.x).toBeGreaterThan(first!.x + first!.w);
      }
      const boxes = [...layout.boxes.values()];
      for (const wire of layout.wires) {
        const ends = [wire.from, wire.to];
        if (wire.d.includes("C")) continue;
        for (const box of boxes.filter((b) => !ends.includes(b.row.key))) {
          const inside = ([ax, ay, bx, by]: [number, number, number, number]) =>
            Math.min(ax, bx) < box.x + box.w &&
            Math.max(ax, bx) > box.x &&
            Math.min(ay, by) < box.y + box.h &&
            Math.max(ay, by) > box.y;
          expect(segmentsOf(wire.d).filter(inside), `${wire.id} through ${box.row.key}`).toEqual(
            [],
          );
        }
      }
      // Sense feeds seven nodes, the six setting the skill feed one.
      expect(layout.wires.filter((w) => w.from === "0.0" && !w.store)).toHaveLength(pack ? 6 : 6);
      expect(layout.wires.filter((w) => w.store && w.to === "0.2")).toHaveLength(6);
    },
  );
});
