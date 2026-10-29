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
 * The keys `loaded` reads and writes: each store key bound to a node's port,
 * directly or through a selection, written when the port is the node's return
 * value or a parameter its function writes, read otherwise. A key a node
 * computes at run time, such as `scatter`'s, is bound to no port: its
 * runtime's meta says what it is.
 */
export function behaviorKeys(loaded: Loaded, index: FunctionIndex): BehaviorKeys {
  const signatures = new Map(index.entries.map((e) => [e.signature.id, e.signature.function]));
  const attached = new Set(loaded.nodes.filter((n) => n.attached).map((n) => n.id));
  const reads = new Set<string>();
  const writes = new Map<string, BehaviorWrite>();
  for (const node of loaded.graph.nodes ?? []) {
    for (const [port, bound] of Object.entries(node.bind ?? {})) {
      // A selection, `{pose}[x]`, reads the key it selects from.
      let source = bound;
      while ("select" in source) source = source.select.source;
      // A tree-local key (`{.name}`, or `{<uuid>}`, which names none) is no store key.
      if (!("key" in source) || source.key.startsWith(".")) continue;
      const { key } = source;
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
  }
  return { reads, writes };
}
