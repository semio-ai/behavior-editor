import type { Graph } from "../model/graph";
import { RET } from "../runtime/natives";
import type { FunctionIndex } from "./functions";

/** The keys a runtime publishes itself, such as its clock: `arora/time`, `arora/dt`. */
const RUNTIME_KEYS = "arora/";

/**
 * The store keys a person should not write, because something else writes
 * them at every tick: the runtime's own keys, under `arora/`, and the keys
 * the behavior writes and does not read, its outputs. A key the behavior both
 * writes and reads, such as a flag it sets and a person resets, stays an input.
 */
export function outputKeys(graph: Graph, index: FunctionIndex): (key: string) => boolean {
  const signatures = new Map(index.entries.map((e) => [e.signature.id, e.signature.function]));
  const written = new Set<string>();
  const read = new Set<string>();
  for (const link of graph.links) {
    if (!("variable" in link.source)) continue;
    const key = graph.variables[link.source.variable];
    if (key === undefined || key.startsWith(".")) continue;
    const fn = graph.nodes[link.target.node]?.function;
    const signature = fn === undefined ? undefined : signatures.get(fn);
    const port = link.target.port;
    // A mutable parameter is read for its state as well as written.
    if (port === RET) written.add(key);
    else if (signature?.parameters[port]?.mutable) written.add(key);
    else read.add(key);
  }
  return (key) => key.startsWith(RUNTIME_KEYS) || (written.has(key) && !read.has(key));
}
