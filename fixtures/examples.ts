/**
 * The examples the demo offers, each a behavior calling `@arora/dataflow` and
 * the natives: the NGBT spectrum's, and a mood, a level, a sway and a smile on
 * a distance. Each says the keys a person sets, with what a device's store
 * says of them, the values they start from, and the keys worth plotting. The
 * same text runs on the local Arora and on any device carrying
 * `@arora/dataflow`.
 */
import type { KeyMeta } from "../src/bridge/bridge-client";
import type { Value } from "../src/model/value";
import type { Loaded } from "../src/text/language";
import breathing from "./examples/breathing.bt?raw";
import dataflow from "./examples/dataflow.bt?raw";
import greet from "./examples/greet.bt?raw";
import order from "./examples/order.bt?raw";
import readersFallback from "./examples/readers-fallback.bt?raw";
import readersParallel from "./examples/readers-parallel.bt?raw";
import returnValues from "./examples/return-values.bt?raw";
import smile from "./examples/smile.bt?raw";

export interface Example {
  id: string;
  title: string;
  /** The file's name. */
  file: string;
  text: string;
  /** The keys a person sets: what the device's store says of each. */
  inputs: Record<string, KeyMeta>;
  /** The values the inputs start from. */
  values: Record<string, Value>;
  /** The keys worth plotting. */
  plot: string[];
}

/** A number a person sets, between `min` and `max`. */
const number = (min: number, max: number): KeyMeta => ({ ty: "f32", editable: true, min, max });
/** A switch a person sets. */
const flag: KeyMeta = { ty: "bool", editable: true };

export const SMILE: Example = {
  id: "smile",
  title: "Smile mapping",
  file: "smile.bt",
  text: smile,
  inputs: { "face/smile": number(0, 1) },
  values: { "face/smile": { f32: 0.2 } },
  plot: ["rig/mouth_corner", "rig/cheek_raise"],
};

export const BREATHING: Example = {
  id: "breathing",
  title: "Breathing",
  file: "breathing.bt",
  text: breathing,
  inputs: { "face/energy": number(0, 1), "face/breath_rate": number(0, 2) },
  values: { "face/energy": { f32: 0.4 }, "face/breath_rate": { f32: 0.3 } },
  plot: ["rig/chest", "face/flush"],
};

export const GREET: Example = {
  id: "greet",
  title: "Greet, then rest",
  file: "greet.bt",
  text: greet,
  inputs: { "person/visible": flag, "social/greeted": flag },
  values: { "person/visible": { bool: false }, "social/greeted": { bool: false } },
  plot: ["rig/arm_raise", "rig/arm_wave"],
};

export const READERS_PARALLEL: Example = {
  id: "readers-parallel",
  title: "Three readers, all asked",
  file: "readers-parallel.bt",
  text: readersParallel,
  inputs: { "sensor/distance": number(0, 2) },
  values: { "sensor/distance": { f32: 0.2 } },
  plot: ["sensor/distance"],
};

export const READERS_FALLBACK: Example = {
  id: "readers-fallback",
  title: "Three readers, the first that holds",
  file: "readers-fallback.bt",
  text: readersFallback,
  inputs: { "sensor/distance": number(0, 2) },
  values: { "sensor/distance": { f32: 0.2 } },
  plot: ["sensor/distance"],
};

export const ORDER: Example = {
  id: "order",
  title: "Order within a tick",
  file: "order.bt",
  text: order,
  inputs: { v: number(0, 1000) },
  values: { v: { f32: 0 } },
  plot: ["v"],
};

export const RETURN_VALUES: Example = {
  id: "return-values",
  title: "Return values",
  file: "return-values.bt",
  text: returnValues,
  inputs: { "sensor/distance": number(0, 2) },
  values: { "sensor/distance": { f32: 0.3 } },
  plot: ["sensor/distance", "face/level", "face/look"],
};

export const DATAFLOW: Example = {
  id: "dataflow",
  title: "Dataflow",
  file: "dataflow.bt",
  text: dataflow,
  inputs: { "sensor/distance": number(0, 2), "face/smile_target": number(0, 1) },
  values: { "sensor/distance": { f32: 0.3 }, "face/smile_target": { f32: 1 } },
  plot: ["face/level", "rig/sway", "face/smile"],
};

export const EXAMPLES: readonly Example[] = [
  SMILE,
  BREATHING,
  GREET,
  READERS_PARALLEL,
  READERS_FALLBACK,
  ORDER,
  RETURN_VALUES,
  DATAFLOW,
];

/** Every example's inputs, as an Arora running any of them declares them. */
export const INPUTS: Record<string, KeyMeta> = Object.assign({}, ...EXAMPLES.map((e) => e.inputs));

/** The values every example's inputs start from; of two examples reading a key, the later's. */
export const VALUES: Record<string, Value> = Object.assign({}, ...EXAMPLES.map((e) => e.values));

/** The graph node id of the node `loaded` names `name`, or whose path is `name`. */
export function idOf(loaded: Loaded, name: string): string {
  const node = loaded.nodes.find((n) => n.name === name || n.path === name);
  if (!node) throw new Error(`no node ${name}`);
  return node.id;
}
