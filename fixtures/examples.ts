/**
 * The NGBT spectrum's examples as fixtures: each one's file text, and the
 * graph a device runs for it with the sources of its nodes, written out by
 * hand. The runtime's tests run each scenario on both: the hand-written graph
 * pins the runtime's semantics on its own, and the graph the resolver makes
 * of the text checks that the text says the same.
 *
 * Each example's nodes are stated once below, and the graph and node sources
 * are spelled from that statement mechanically: one node per line of the
 * text, in order, its parameters by the ids the math module and the natives
 * declare.
 */
import { MATH } from "../src/runtime/math-module";
import * as N from "../src/runtime/natives";
import type { Graph, GraphNode, Source } from "../src/model/graph";
import type { Value } from "../src/model/value";
import type { Span } from "../src/text/ast";
import type { Loaded, LoadedNode } from "../src/text/language";
import breathing from "./examples/breathing.bt?raw";
import greet from "./examples/greet.bt?raw";
import order from "./examples/order.bt?raw";
import readersFallback from "./examples/readers-fallback.bt?raw";
import readersParallel from "./examples/readers-parallel.bt?raw";
import smile from "./examples/smile.bt?raw";

/** A function as the fixtures call it: its name, id, and parameter ids by name. */
interface Fn {
  name: string;
  id: string;
  params: Record<string, string>;
}

const math = (name: keyof typeof MATH): Fn => {
  const { id, ...params } = MATH[name];
  return { name, id, params };
};

const native = (name: string, id: string, params: Record<string, string> = {}): Fn => ({
  name,
  id,
  params,
});

const SEQUENCE = native("sequence", N.SEQUENCE);
const FALLBACK = native("fallback", N.FALLBACK);
const PARALLEL = native("parallel", N.PARALLEL);
const RUNNING = native("running", N.RUNNING);

/** An argument as stated: a literal, a store key or local variable, a node's port, or a call. */
type Arg =
  | number
  | boolean
  | "none"
  | { key: string }
  | { ref: string; param?: string }
  | { call: Fn; args: Record<string, Arg> };

interface Spec {
  name?: string;
  /** The store key or local variable its return value is bound to. */
  target?: string;
  fn: Fn;
  args?: Record<string, Arg>;
  children?: Spec[];
}

export interface Example {
  id: string;
  title: string;
  /** The file's name, for the demo. */
  file: string;
  text: string;
  /** The graph, written out by hand, and its nodes' sources. */
  loaded: Loaded;
  /** The store's values to start from. */
  store: Record<string, Value>;
  /** The keys worth plotting. */
  plot: string[];
}

/** The id of the `i`th node of an example, nested calls after the nodes. */
const nodeId = (i: number) => `00000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, "0")}`;

const NO_SPAN: Span = { start: 0, end: 0, line: 0, column: 0 };

/** The spans of the lines that hold a node: each line with text other than a comment. */
function nodeLineSpans(text: string): Span[] {
  const spans: Span[] = [];
  let offset = 0;
  text.split("\n").forEach((line, i) => {
    const code = line.replace(/\s*#.*$/, "");
    const indent = code.length - code.trimStart().length;
    if (code.trim()) {
      spans.push({
        start: offset + indent,
        end: offset + code.length,
        line: i + 1,
        column: indent + 1,
      });
    }
    offset += line.length + 1;
  });
  return spans;
}

function build(
  exampleId: string,
  title: string,
  file: string,
  text: string,
  tree: Spec,
  detached: Spec[],
  store: Record<string, Value>,
  plot: string[],
): Example {
  const lines = nodeLineSpans(text);
  const specs: { spec: Spec; path: string; parent: string | null; attached: boolean }[] = [];
  const visit = (spec: Spec, path: string, parent: string | null, attached: boolean) => {
    specs.push({ spec, path, parent, attached });
    spec.children?.forEach((child, i) => visit(child, `${path}.${i}`, path, attached));
  };
  visit(tree, "root", null, true);
  detached.forEach((spec, i) => visit(spec, `detached.${i}`, null, false));
  if (lines.length !== specs.length) {
    throw new Error(`${file}: ${lines.length} node lines for ${specs.length} nodes`);
  }
  const ids = new Map(specs.map(({ spec, path }, i) => [spec.name ?? path, nodeId(i)]));
  const idOfPath = new Map(specs.map(({ path }, i) => [path, nodeId(i)]));
  const named = (name: string) => {
    const found = ids.get(name);
    if (!found) throw new Error(`${file}: no node ${name}`);
    return found;
  };
  const fnOf = new Map(specs.map(({ spec, path }) => [named(spec.name ?? path), spec.fn]));

  const nodes: GraphNode[] = [];
  const graph: Graph = { root: nodeId(0), nodes };
  const loadedNodes: LoadedNode[] = [];
  let anonymous = specs.length;
  const literal = (arg: number | boolean | "none"): Value =>
    arg === "none" ? { option: null } : typeof arg === "boolean" ? { bool: arg } : { f64: arg };
  const source = (arg: Arg, holder: string, path: string, param: string): Source => {
    if (typeof arg !== "object") return { value: literal(arg) };
    if ("key" in arg) return { key: arg.key };
    if ("ref" in arg) {
      const node = named(arg.ref);
      const port = arg.param ? fnOf.get(node)!.params[arg.param]! : N.RET;
      return { port: { node, port } };
    }
    const call = nodeId(anonymous++);
    addNode(call, arg.call, null, arg.args, `${path}.${param}`, holder, NO_SPAN, false, null);
    return { port: { node: call, port: N.RET } };
  };
  function addNode(
    id: string,
    fn: Fn,
    children: string[] | null,
    args: Record<string, Arg>,
    path: string,
    parent: string | null,
    span: Span,
    attached: boolean,
    name: string | null,
  ) {
    const node: GraphNode = { id, function: fn.id, ...(children ? { children } : {}) };
    nodes.push(node);
    loadedNodes.push({ id, name, span, attached, function: fn.id, parent, path });
    for (const [param, arg] of Object.entries(args)) {
      const port = fn.params[param];
      if (!port) throw new Error(`${fn.name} has no parameter ${param}`);
      (node.bind ??= {})[port] = source(arg, id, path, param);
    }
    return node;
  }
  specs.forEach(({ spec, path, parent, attached }, i) => {
    const id = nodeId(i);
    const children = spec.children
      ? spec.children.map((_, k) => idOfPath.get(`${path}.${k}`)!)
      : null;
    const node = addNode(
      id,
      spec.fn,
      children,
      spec.args ?? {},
      path,
      parent === null ? null : idOfPath.get(parent)!,
      lines[i]!,
      attached,
      spec.name ?? null,
    );
    if (spec.target) (node.bind ??= {})[N.RET] = { key: spec.target };
  });

  return {
    id: exampleId,
    title,
    file,
    text,
    loaded: { graph, nodes: loadedNodes, diagnostics: [] },
    store,
    plot,
  };
}

const readersTree = (root: Fn): Spec => ({
  fn: root,
  children: ["near", "mid", "far"].map((ref) => ({ fn: math("truthy"), args: { x: { ref } } })),
});
const readersDetached: Spec[] = [
  { name: "raw", fn: math("mul"), args: { a: { key: "sensor/distance" }, b: 100 } },
  { name: "cm", fn: math("clamp"), args: { x: { ref: "raw" }, min: 0, max: 1000 } },
  { name: "near", fn: math("lt"), args: { a: { ref: "cm" }, b: 10 } },
  { name: "mid", fn: math("lt"), args: { a: { ref: "cm" }, b: 30 } },
  { name: "far", fn: math("lt"), args: { a: { ref: "cm" }, b: 50 } },
];

export const SMILE = build(
  "smile",
  "Smile mapping",
  "smile.bt",
  smile,
  { fn: RUNNING },
  [
    { name: "amount", fn: math("clamp"), args: { x: { key: "face/smile" }, min: 0, max: 1 } },
    {
      name: "corner",
      fn: math("remap"),
      args: { x: { ref: "amount" }, in_min: 0, in_max: 1, out_min: -0.2, out_max: 1 },
    },
    {
      name: "mouth",
      target: "rig/mouth_corner",
      fn: math("damp"),
      args: { target: { ref: "corner" }, half_life: 0.12, state: "none" },
    },
    {
      name: "cheeks",
      target: "rig/cheek_raise",
      fn: math("mul"),
      args: { a: { ref: "amount" }, b: 0.6 },
    },
  ],
  { "face/smile": { f64: 0.2 } },
  ["rig/mouth_corner", "rig/cheek_raise"],
);

export const BREATHING = build(
  "breathing",
  "Breathing",
  "breathing.bt",
  breathing,
  { fn: RUNNING },
  [
    {
      name: "wave",
      fn: math("oscillator"),
      args: { t: { key: "arora/time" }, frequency: { key: "face/breath_rate" } },
    },
    {
      name: "amplitude",
      fn: math("remap"),
      args: { x: { key: "face/energy" }, in_min: 0, in_max: 1, out_min: 0.03, out_max: 0.2 },
    },
    {
      name: "chest",
      target: "rig/chest",
      fn: math("add"),
      args: {
        a: { call: math("mul"), args: { a: { ref: "wave" }, b: { ref: "amplitude" } } },
        b: 0.5,
      },
    },
    {
      name: "flush",
      target: "face/flush",
      fn: math("remap"),
      args: { x: { key: "face/energy" }, in_min: 0, in_max: 1, out_min: 0.15, out_max: 0.85 },
    },
  ],
  { "face/energy": { f64: 0.4 }, "face/breath_rate": { f64: 0.3 } },
  ["rig/chest", "face/flush"],
);

const ease = (target: number, halfLife: number, key: string): Spec => ({
  target: key,
  fn: math("damp"),
  args: { target, half_life: halfLife, state: "none", initial: { key } },
});

export const GREET = build(
  "greet",
  "Greet, then rest",
  "greet.bt",
  greet,
  {
    fn: FALLBACK,
    children: [
      {
        fn: SEQUENCE,
        children: [
          { fn: math("truthy"), args: { x: { key: "person/visible" } } },
          { fn: math("truthy"), args: { x: { ref: "fresh" } } },
          {
            fn: PARALLEL,
            children: [
              ease(1, 0.12, "rig/arm_raise"),
              {
                target: "rig/arm_wave",
                fn: math("mul"),
                args: {
                  a: {
                    call: math("oscillator"),
                    args: { t: { key: "arora/time" }, frequency: 1.6 },
                  },
                  b: 0.6,
                },
              },
              { fn: math("wait"), args: { seconds: 2, now: { key: "arora/time" }, since: "none" } },
            ],
          },
          { target: "social/greeted", fn: math("identity"), args: { x: true } },
        ],
      },
      {
        fn: PARALLEL,
        children: [ease(0, 0.2, "rig/arm_raise"), ease(0, 0.2, "rig/arm_wave")],
      },
    ],
  },
  [{ name: "fresh", fn: math("not"), args: { x: { key: "social/greeted" } } }],
  {
    "person/visible": { bool: false },
    "social/greeted": { bool: false },
    "rig/arm_raise": { f64: 0 },
    "rig/arm_wave": { f64: 0 },
  },
  ["rig/arm_raise", "rig/arm_wave"],
);

export const READERS_PARALLEL = build(
  "readers-parallel",
  "Three readers, all asked",
  "readers-parallel.bt",
  readersParallel,
  readersTree(PARALLEL),
  readersDetached,
  { "sensor/distance": { f64: 0.2 } },
  ["sensor/distance"],
);

export const READERS_FALLBACK = build(
  "readers-fallback",
  "Three readers, the first that holds",
  "readers-fallback.bt",
  readersFallback,
  readersTree(FALLBACK),
  readersDetached,
  { "sensor/distance": { f64: 0.2 } },
  ["sensor/distance"],
);

export const ORDER = build(
  "order",
  "Order within a tick",
  "order.bt",
  order,
  {
    fn: SEQUENCE,
    children: [
      { target: "v", fn: math("identity"), args: { x: { ref: "inc" } } },
      { fn: math("truthy"), args: { x: { ref: "ok" } } },
      { target: "v", fn: math("identity"), args: { x: { ref: "inc" } } },
      { fn: math("truthy"), args: { x: { ref: "ok" } } },
    ],
  },
  [
    { name: "inc", fn: math("add"), args: { a: { key: "v" }, b: 1 } },
    { name: "scaled", fn: math("mul"), args: { a: { key: "v" }, b: 10 } },
    { name: "ok", fn: math("lt"), args: { a: { ref: "scaled" }, b: 1000000000000 } },
  ],
  { v: { f64: 0 } },
  ["v"],
);

export const EXAMPLES: readonly Example[] = [
  SMILE,
  BREATHING,
  GREET,
  READERS_PARALLEL,
  READERS_FALLBACK,
  ORDER,
];

/** The graph node id of the node `loaded` names `name`, or whose path is `name`. */
export function idOf(loaded: Loaded, name: string): string {
  const node = loaded.nodes.find((n) => n.name === name || n.path === name);
  if (!node) throw new Error(`no node ${name}`);
  return node.id;
}
