import { nativeWrites, RET } from "../runtime/natives";
import type { Loaded } from "../text/language";
import type { FunctionIndex } from "./functions";

/**
 * How a behavior writes a key:
 * - `sink`: a node no node holds publishes it after every tick, so what a
 *   person writes there is overwritten at once;
 * - `leaf`: a node of the tree writes it when it ticks, so what a person writes
 *   lasts until then.
 */
export type BehaviorWrite = "sink" | "leaf";

/** The store keys a behavior reads and writes, read off its graph. */
export interface BehaviorKeys {
  reads: ReadonlySet<string>;
  writes: ReadonlyMap<string, BehaviorWrite>;
}

/**
 * The keys `loaded` reads and writes: each store variable linked to a node's
 * argument, written when the argument is the node's return value or a
 * parameter its function writes, read otherwise. A key a node computes at run
 * time, such as `scatter`'s, is no variable of the graph: its runtime's meta
 * says what it is.
 */
export function behaviorKeys(loaded: Loaded, index: FunctionIndex): BehaviorKeys {
  const { graph } = loaded;
  const signatures = new Map(index.entries.map((e) => [e.signature.id, e.signature.function]));
  const attached = new Set(loaded.nodes.filter((n) => n.attached).map((n) => n.id));
  const reads = new Set<string>();
  const writes = new Map<string, BehaviorWrite>();
  for (const link of graph.links) {
    if (!("variable" in link.source)) continue;
    const key = graph.variables[link.source.variable];
    const node = graph.nodes[link.target.node];
    // A tree-local variable (`{.name}`, or an id that names none) is no store key.
    if (key === undefined || key.startsWith(".") || !node) continue;
    const port = link.target.port;
    const written =
      port === RET ||
      (signatures.get(node.function)?.parameters[port]?.mutable ?? false) ||
      nativeWrites(node.function, port);
    if (!written) {
      reads.add(key);
      continue;
    }
    if (!attached.has(node.id)) writes.set(key, "sink");
    else if (!writes.has(key)) writes.set(key, "leaf");
  }
  return { reads, writes };
}
