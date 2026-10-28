import type { Graph, GraphNode, LinkSource } from "../model/graph";
import type { FunctionSignature, MethodSignature } from "../model/signature";
import { type Value, valueEquals, valueString } from "../model/value";
import type { Loaded } from "../text/language";
import { mathModule } from "./math-module";
import * as N from "./natives";
import type { BehaviorRuntime, DetachedActivity, Status, TickReport } from "./runtime";

/** What a module function answers: its return value, and the mutable parameters it wrote. */
export interface CallResult {
  ret: Value;
  mutated: { id: string; value: Value }[];
}

/** A module function of the mock device, answering in process. */
export interface MockFunction {
  signature: MethodSignature;
  /** Call it with its arguments by parameter id; throws when it fails. */
  call(args: ReadonlyMap<string, Value>): CallResult;
}

export interface MockModule {
  id: string;
  functions: MockFunction[];
}

export interface MockAroraOptions {
  /** The store's keys and values to begin with. */
  store?: Record<string, Value>;
  /** The modules the device carries; the math module by default. */
  modules?: MockModule[];
}

/** The key the device publishes its clock to, in seconds, before each tick. */
export const TIME_KEY = "arora/time";

/**
 * A device in process, running a behavior's graph with the semantics of
 * `arora-behavior-tree`:
 *
 * - The tree ticks from its root. Sequence, fallback and parallel tick their
 *   children every tick; a parallel succeeds when all its children do, fails
 *   when one does, and runs otherwise. `sequence_star` resumes past the children
 *   that succeeded. Nothing is halted.
 * - A module leaf succeeds when its return value is bound (`_ret`), and
 *   otherwise reports the `Status` it returns, Success for any other value.
 * - A detached node is brought up to date when a node that reads it is about to
 *   tick, at most once per tick, and calls its function only when its argument
 *   values differ from those of its last call. Its state lives in its mutable
 *   parameters.
 * - A detached node with an output bound to a store key is a sink: brought up
 *   to date after the tree at every tick, whether or not the tree failed, and
 *   once every sink is, each publishes its keys in the order the tree lists
 *   them, root first then by id.
 * - A store key reads as the store holds it, so a value fed back through a key
 *   arrives at the next tick.
 *
 * Starting a behavior while another runs keeps the state of the nodes the new
 * graph left as they were: their literal cells and the tree-local variables
 * they read.
 */
export class MockArora implements BehaviorRuntime {
  readonly #store = new Map<string, Value>();
  readonly #functions = new Map<string, MockFunction>();
  #program: Program | null = null;
  #ticks = 0;
  #time = 0;

  constructor(options: MockAroraOptions = {}) {
    for (const [key, value] of Object.entries(options.store ?? {})) this.#store.set(key, value);
    for (const module of options.modules ?? [mathModule()]) {
      for (const fn of module.functions) this.#functions.set(fn.signature.id, fn);
    }
  }

  functions(): Promise<MethodSignature[]> {
    return Promise.resolve([...this.#functions.values()].map((fn) => fn.signature));
  }

  start(loaded: Loaded): Promise<void> {
    try {
      this.#program = new Program(loaded.graph, this.#functions, this.#store, this.#program);
      this.#ticks = 0;
      return Promise.resolve();
    } catch (error) {
      return Promise.reject(asError(error));
    }
  }

  step(dtMs: number): Promise<TickReport> {
    const before = new Map(this.#store);
    this.#time += dtMs / 1000;
    this.#store.set(TIME_KEY, { f64: this.#time });
    const program = this.#program;
    if (!program) return Promise.resolve({ tick: 0, changes: changes(before, this.#store) });
    this.#ticks += 1;
    const outcome = program.tick();
    const report: TickReport = {
      tick: this.#ticks,
      ...(outcome.root ? { root: outcome.root } : {}),
      statuses: outcome.statuses,
      detached: outcome.detached,
      changes: changes(before, this.#store),
    };
    return outcome.error ? Promise.reject(outcome.error) : Promise.resolve(report);
  }

  write(key: string, value: Value | null): Promise<void> {
    if (value === null) this.#store.delete(key);
    else this.#store.set(key, value);
    return Promise.resolve();
  }

  read(key: string): Promise<Value | null> {
    return Promise.resolve(this.#store.get(key) ?? null);
  }

  keys(): Promise<string[]> {
    return Promise.resolve([...this.#store.keys()].sort());
  }

  stop(): Promise<void> {
    this.#program = null;
    return Promise.resolve();
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function changes(
  before: ReadonlyMap<string, Value>,
  after: ReadonlyMap<string, Value>,
): TickReport["changes"] {
  const out: TickReport["changes"] = [];
  for (const [key, value] of after) {
    if (!valueEquals(before.get(key), value)) out.push({ key, value });
  }
  for (const key of before.keys()) if (!after.has(key)) out.push({ key, value: null });
  return out;
}

/** Where an argument's value lives between ticks. */
interface Cell {
  get(): Value | undefined;
  set(value: Value | undefined): void;
}

/** A cell of the tree's own: a literal's, a port's, or a tree-local variable's. */
class LocalCell implements Cell {
  constructor(public value: Value | undefined = undefined) {}
  get() {
    return this.value;
  }
  set(value: Value | undefined) {
    this.value = value;
  }
}

/** A store key, read and written as the store holds it. */
class StoreCell implements Cell {
  constructor(
    private readonly store: Map<string, Value>,
    readonly key: string,
  ) {}
  get() {
    return this.store.get(this.key);
  }
  set(value: Value | undefined) {
    if (value === undefined) this.store.delete(this.key);
    else this.store.set(this.key, value);
  }
}

interface DetachedState {
  /** The arguments of its last call. */
  args?: Value[];
  /** Its outputs after its last call, by port. */
  outputs: Map<string, Value>;
  /** The tick it was last brought up to date at, and why that failed if it did. */
  tick: number;
  failed?: Error;
  activity: DetachedActivity;
}

interface TickOutcome {
  root?: Status;
  statuses: Record<string, Status>;
  detached: Record<string, DetachedActivity>;
  error?: Error;
}

const portKey = (node: string, port: string) => `${node}|${port}`;

/** A graph lowered for ticking: its cells, who reads whom, and what each detached node holds. */
class Program {
  readonly #graph: Graph;
  readonly #functions: ReadonlyMap<string, MockFunction>;
  readonly #store: Map<string, Value>;
  readonly #root: string;
  /** The links, by the port they feed. */
  readonly #links = new Map<string, LinkSource>();
  readonly #cells = new Map<string, Cell>();
  /** The cells each literal argument owns, by port: what a rebuilt graph carries over. */
  readonly #literalCells = new Map<string, LocalCell>();
  readonly #variables = new Map<string, Cell>();
  readonly #attached = new Set<string>();
  /** The detached nodes, in the order the tree lists them. */
  readonly #detached: string[] = [];
  /** The store key each port of a detached node publishes to, by port. */
  readonly #publish = new Map<string, string>();
  /** By detached node: the detached nodes it reads, inputs first. */
  readonly #reads = new Map<string, string[]>();
  /** By attached node: the detached nodes it reads. */
  readonly #pulls = new Map<string, string[]>();
  readonly #sinks: string[] = [];
  readonly #state = new Map<string, DetachedState>();
  #tick = 0;
  #statuses: Record<string, Status> = {};

  constructor(
    graph: Graph,
    functions: ReadonlyMap<string, MockFunction>,
    store: Map<string, Value>,
    previous: Program | null,
  ) {
    this.#graph = graph;
    this.#functions = functions;
    this.#store = store;
    if (!graph.root || !graph.nodes[graph.root]) {
      throw new Error(`the graph's root ${graph.root ?? "(none)"} is not a node`);
    }
    this.#root = graph.root;
    for (const link of graph.links) {
      if ("select" in link.source) throw new Error("the mock device does not evaluate selections");
      this.#links.set(portKey(link.target.node, link.target.port), link.source);
    }
    this.#holdFrom(this.#root);
    const order = Object.keys(graph.nodes).sort((a, b) =>
      a === this.#root ? -1 : b === this.#root ? 1 : a < b ? -1 : a > b ? 1 : 0,
    );
    for (const id of order) {
      const node = graph.nodes[id]!;
      if (
        !this.#attached.has(id) &&
        !N.NATIVE_FUNCTIONS.has(node.function) &&
        !node.children?.length
      ) {
        this.#detached.push(id);
        this.#state.set(id, { outputs: new Map(), tick: 0, activity: "idle" });
      }
    }
    this.#lowerDetached();
    if (previous) this.#keepState(previous);
  }

  /** Mark `id` and its descendants attached. */
  #holdFrom(id: string) {
    if (this.#attached.has(id)) return;
    this.#attached.add(id);
    for (const child of this.#graph.nodes[id]?.children ?? []) {
      if (!this.#graph.nodes[child]) throw new Error(`node ${id} holds ${child}, which is no node`);
      this.#holdFrom(child);
    }
  }

  #signature(node: GraphNode): FunctionSignature | undefined {
    return this.#functions.get(node.function)?.signature.function;
  }

  /** Whether the port `param` of the detached node `id` is one of its outputs. */
  #isDetachedOutput(id: string, param: string): boolean {
    if (!this.#state.has(id)) return false;
    if (param === N.RET) return true;
    return this.#signature(this.#graph.nodes[id]!)?.parameters[param]?.mutable ?? false;
  }

  /** The cell of the port `param` of node `id`, which its link decides. */
  #cell(id: string, param: string, visiting = new Set<string>()): Cell {
    const at = portKey(id, param);
    const known = this.#cells.get(at);
    if (known) return known;
    if (visiting.has(at)) throw new Error(`the links of port ${at} form a cycle`);
    visiting.add(at);
    const source = this.#links.get(at);
    let cell: Cell;
    if (!source) {
      cell = new LocalCell();
    } else if ("literal" in source) {
      const own = new LocalCell(source.literal);
      this.#literalCells.set(at, own);
      cell = own;
    } else if ("variable" in source) {
      const name = this.#graph.variables[source.variable];
      if (name === undefined)
        throw new Error(
          `port ${at} reads variable ${source.variable}, which the graph does not name`,
        );
      if (!name.startsWith(".") && this.#isDetachedOutput(id, param)) {
        // A detached node's output bound to a store key keeps a cell of its
        // own, which `@node` reads, and publishes to the key after the tree.
        this.#publish.set(at, name);
        cell = new LocalCell();
      } else {
        cell = this.#variable(name);
      }
    } else if ("port" in source) {
      if (!this.#graph.nodes[source.port.node]) {
        throw new Error(`port ${at} reads node ${source.port.node}, which is no node`);
      }
      cell = this.#cell(source.port.node, source.port.port, visiting);
    } else {
      throw new Error("the mock device does not evaluate selections");
    }
    this.#cells.set(at, cell);
    return cell;
  }

  #variable(name: string): Cell {
    let cell = this.#variables.get(name);
    if (!cell) {
      cell = name.startsWith(".") ? new LocalCell() : new StoreCell(this.#store, name);
      this.#variables.set(name, cell);
    }
    return cell;
  }

  /** The parameters of `node` its links or its signature name, `_ret` aside. */
  #inputs(id: string): string[] {
    const node = this.#graph.nodes[id]!;
    const signature = this.#signature(node);
    const linked = this.#graph.links
      .filter((l) => l.target.node === id && l.target.port !== N.RET)
      .map((l) => l.target.port);
    if (!signature) return linked;
    return [...signature.parameterOrdering, ...linked.filter((p) => !signature.parameters[p])];
  }

  /** The output ports of the detached node `id`: its return value and its mutable parameters. */
  #outputs(id: string): string[] {
    const signature = this.#signature(this.#graph.nodes[id]!);
    const mutable = signature
      ? signature.parameterOrdering.filter((p) => signature.parameters[p]?.mutable)
      : [];
    return [N.RET, ...mutable];
  }

  /** Find who writes each tree-local cell, who reads which detached node, and the sinks. */
  #lowerDetached() {
    const writers = new Map<Cell, string>();
    const claim = (cell: Cell, writer: string, detached: boolean) => {
      if (!(cell instanceof LocalCell)) return;
      const other = writers.get(cell);
      if (other !== undefined && other !== writer && (detached || this.#state.has(other))) {
        throw new Error(`nodes ${other} and ${writer} both write one tree-local cell`);
      }
      writers.set(cell, writer);
    };
    for (const id of this.#detached) {
      for (const port of this.#outputs(id)) claim(this.#cell(id, port), id, true);
    }
    for (const id of this.#attached) {
      const node = this.#graph.nodes[id]!;
      if (this.#links.has(portKey(id, N.RET))) claim(this.#cell(id, N.RET), id, false);
      const signature = this.#signature(node);
      for (const param of signature?.parameterOrdering ?? []) {
        if (signature!.parameters[param]?.mutable) claim(this.#cell(id, param), id, false);
      }
    }
    const detachedWriter = (cell: Cell) => {
      const writer = writers.get(cell);
      return writer !== undefined && this.#state.has(writer) ? writer : undefined;
    };
    for (const id of this.#detached) {
      const reads = new Set<string>();
      for (const param of this.#inputs(id)) {
        const writer = detachedWriter(this.#cell(id, param));
        if (writer !== undefined && writer !== id) reads.add(writer);
      }
      this.#reads.set(id, [...reads]);
      if (this.#outputs(id).some((port) => this.#publish.has(portKey(id, port)))) {
        this.#sinks.push(id);
      }
    }
    for (const id of this.#attached) {
      const pulls = new Set<string>();
      for (const param of this.#inputs(id)) {
        const writer = detachedWriter(this.#cell(id, param));
        if (writer !== undefined) pulls.add(writer);
      }
      this.#pulls.set(id, [...pulls]);
    }
    const done = new Set<string>();
    const visit = (id: string, path: string[]) => {
      if (done.has(id)) return;
      if (path.includes(id))
        throw new Error(`detached nodes read each other in a cycle: ${[...path, id].join(" → ")}`);
      for (const read of this.#reads.get(id) ?? []) visit(read, [...path, id]);
      done.add(id);
    };
    for (const id of this.#detached) visit(id, []);
  }

  /**
   * Take over the state `previous` holds for every node this graph left as it
   * was: its literal cells, and the tree-local variables those nodes read.
   */
  #keepState(previous: Program) {
    const same = (id: string) => definition(this.#graph, id) === definition(previous.#graph, id);
    for (const [at, cell] of this.#literalCells) {
      const held = previous.#literalCells.get(at);
      if (held && same(at.split("|")[0]!)) cell.set(held.get());
    }
    for (const link of this.#graph.links) {
      if (!("variable" in link.source) || !same(link.target.node)) continue;
      const name = this.#graph.variables[link.source.variable];
      const cell = name === undefined ? undefined : this.#variables.get(name);
      const held = name === undefined ? undefined : previous.#variables.get(name);
      if (cell instanceof LocalCell && held instanceof LocalCell) cell.set(held.get());
    }
  }

  tick(): TickOutcome {
    this.#tick += 1;
    this.#statuses = {};
    for (const state of this.#state.values()) state.activity = "idle";
    let root: Status | undefined;
    let error: Error | undefined;
    try {
      root = this.#tickNode(this.#root);
    } catch (e) {
      error = asError(e);
    }
    for (const id of this.#sinks) {
      try {
        this.#bringUpToDate(id);
      } catch (e) {
        error ??= asError(e);
      }
    }
    for (const id of this.#sinks) {
      const state = this.#state.get(id)!;
      if (state.failed) continue;
      for (const port of this.#outputs(id)) {
        const key = this.#publish.get(portKey(id, port));
        const value = state.outputs.get(port);
        if (key !== undefined && value !== undefined) {
          writeBack(new StoreCell(this.#store, key), value, this.#outputOptional(id, port));
        }
      }
    }
    return {
      ...(root ? { root } : {}),
      statuses: this.#statuses,
      detached: Object.fromEntries([...this.#state].map(([id, s]) => [id, s.activity])),
      ...(error ? { error } : {}),
    };
  }

  #tickNode(id: string): Status {
    const node = this.#graph.nodes[id]!;
    for (const read of this.#pulls.get(id) ?? []) this.#bringUpToDate(read);
    const status = N.NATIVE_FUNCTIONS.has(node.function)
      ? this.#tickNative(node)
      : this.#tickModuleLeaf(node);
    this.#statuses[id] = status;
    return status;
  }

  #arg(id: string, param: string): Value {
    return this.#cell(id, param).get() ?? "unit";
  }

  #tickNative(node: GraphNode): Status {
    const children = node.children ?? [];
    const id = node.id;
    switch (node.function) {
      case N.SUCCEED:
        return "S";
      case N.FAIL:
        return "F";
      case N.RUNNING:
        return "R";
      case N.SEQUENCE:
        for (const child of children) {
          const status = this.#tickNode(child);
          if (status !== "S") return status;
        }
        return "S";
      case N.FALLBACK:
        if (!children.length) return "S";
        for (const child of children) {
          const status = this.#tickNode(child);
          if (status !== "F") return status;
        }
        return "F";
      case N.PARALLEL: {
        const statuses = children.map((child) => this.#tickNode(child));
        if (statuses.every((s) => s === "S")) return "S";
        return statuses.includes("F") ? "F" : "R";
      }
      case N.SEQUENCE_STAR: {
        const cell = this.#cell(id, N.SEQUENCE_STAR_INDEX);
        const held = cell.get();
        let index = held !== undefined && held !== "unit" && "u16" in held ? held.u16 : 0;
        let status: Status = "S";
        for (const child of children.slice(index)) {
          status = this.#tickNode(child);
          if (status !== "S") break;
          index += 1;
        }
        cell.set({ u16: status === "R" ? index : 0 });
        return status;
      }
      case N.EQUAL:
        return valueEquals(this.#arg(id, N.EQUAL_A), this.#arg(id, N.EQUAL_B)) ? "S" : "F";
      case N.SET_STRING:
        this.#cell(id, N.SET_STRING_VARIABLE).set(this.#optionalString(id, N.SET_STRING_VALUE));
        return "S";
      case N.UNSET_STRING:
        this.#cell(id, N.UNSET_STRING_VARIABLE).set(undefined);
        return "S";
      case N.IS_STRING_SET:
        return valueString(this.#optionalString(id, N.IS_STRING_SET_VALUE)) ? "S" : "F";
      case N.WAIT_STRING_SET:
        return valueString(this.#optionalString(id, N.WAIT_STRING_SET_VALUE)) ? "S" : "R";
      case N.REGEX_MATCH:
        return this.#regexMatch(id);
      case N.UNPACK:
        return this.#unpack(id);
      case N.SCATTER:
        return this.#scatter(id);
      default:
        throw new Error(`the mock device does not tick native function ${node.function}`);
    }
  }

  /** A string argument, `undefined` when unset; any other value is an error. */
  #optionalString(id: string, param: string): Value | undefined {
    const value = this.#cell(id, param).get();
    if (value === undefined || valueString(value) !== undefined) return value;
    throw new Error(`node ${id}: ${JSON.stringify(value)} is not a string`);
  }

  #regexMatch(id: string): Status {
    const value = valueString(this.#optionalString(id, N.REGEX_MATCH_VALUE));
    const matcher = valueString(this.#optionalString(id, N.REGEX_MATCH_MATCHER));
    if (value === undefined || matcher === undefined) return "F";
    let found: RegExpExecArray | null;
    try {
      found = new RegExp(matcher).exec(value);
    } catch {
      return "F";
    }
    if (!found) return "F";
    this.#cell(id, N.REGEX_MATCH_FIRST_MATCH).set({ str: found[0] });
    return "S";
  }

  #unpack(id: string): Status {
    const bound = this.#graph.links
      .map((l) => (l.target.node === id ? N.unpackOutIndex(l.target.port) : undefined))
      .filter((i): i is number => i !== undefined);
    const elements = arrayElements(this.#arg(id, N.UNPACK_VALUES));
    const needed = bound.length ? Math.max(...bound) + 1 : 0;
    if (!elements || elements.length < needed) return "F";
    for (const i of bound) {
      if (elements[i] !== "unit") this.#cell(id, N.unpackOut(i)).set(elements[i]);
    }
    return "S";
  }

  #scatter(id: string): Status {
    const within = valueString(this.#cell(id, N.SCATTER_WITHIN).get()) ?? "";
    const keys = arrayElements(this.#arg(id, N.SCATTER_KEYS))?.map(valueString);
    const values = arrayElements(this.#arg(id, N.SCATTER_VALUES));
    if (!keys || !values || keys.length !== values.length || keys.includes(undefined)) return "F";
    const seen = new Set<string>();
    for (const key of keys as string[]) {
      const inside = !within || key === within || key.startsWith(`${within}/`);
      if (key.startsWith(".") || !inside || seen.has(key)) {
        throw new Error(`scatter node ${id} cannot write key ${key}`);
      }
      seen.add(key);
    }
    (keys as string[]).forEach((key, i) => {
      if (values[i] !== "unit") this.#store.set(key, values[i]!);
    });
    return "S";
  }

  #tickModuleLeaf(node: GraphNode): Status {
    const fn = this.#functions.get(node.function);
    if (!fn)
      throw new Error(`node ${node.id} calls function ${node.function}, which no module has`);
    const signature = fn.signature.function;
    const args = new Map<string, Value>();
    for (const param of signature.parameterOrdering) {
      args.set(
        param,
        argumentValue(this.#cell(node.id, param).get(), isOptional(signature, param)),
      );
    }
    const result = fn.call(args);
    for (const mutated of result.mutated) {
      writeBack(this.#cell(node.id, mutated.id), mutated.value, isOptional(signature, mutated.id));
    }
    if (this.#links.has(portKey(node.id, N.RET))) {
      writeBack(
        this.#cell(node.id, N.RET),
        result.ret,
        signature.returnType.type === "frozenOption",
      );
      return "S";
    }
    return N.statusOf(result.ret) ?? "S";
  }

  #outputOptional(id: string, port: string): boolean {
    const signature = this.#signature(this.#graph.nodes[id]!);
    if (!signature) return false;
    return port === N.RET
      ? signature.returnType.type === "frozenOption"
      : isOptional(signature, port);
  }

  /** Bring the detached node `id` up to date for this tick, at most once. */
  #bringUpToDate(id: string) {
    const state = this.#state.get(id)!;
    if (state.tick === this.#tick) {
      if (state.failed) throw state.failed;
      return;
    }
    try {
      for (const read of this.#reads.get(id) ?? []) this.#bringUpToDate(read);
      this.#evaluate(id, state);
      state.tick = this.#tick;
      state.failed = undefined;
    } catch (e) {
      state.tick = this.#tick;
      state.failed = asError(e);
      throw state.failed;
    }
  }

  #evaluate(id: string, state: DetachedState) {
    const node = this.#graph.nodes[id]!;
    const outputs = this.#outputs(id);
    // A mutable parameter bound to a store key has the key's value as its state.
    for (const port of outputs) {
      const key = this.#publish.get(portKey(id, port));
      if (port !== N.RET && key !== undefined) this.#cell(id, port).set(this.#store.get(key));
    }
    const fn = this.#functions.get(node.function);
    const signature = fn?.signature.function;
    const params = this.#inputs(id);
    const args = params.map((param) =>
      argumentValue(this.#cell(id, param).get(), signature ? isOptional(signature, param) : false),
    );
    if (
      state.args &&
      state.args.length === args.length &&
      state.args.every((a, i) => valueEquals(a, args[i]))
    ) {
      for (const [port, value] of state.outputs) {
        writeBack(this.#cell(id, port), value, this.#outputOptional(id, port));
      }
      state.activity = "cached";
      return;
    }
    if (!fn) throw new Error(`node ${id} calls function ${node.function}, which no module has`);
    const result = fn.call(new Map(params.map((param, i) => [param, args[i]!])));
    const results = new Map<string, Value>();
    params.forEach((param, i) => {
      if (outputs.includes(param)) results.set(param, args[i]!);
    });
    results.set(N.RET, result.ret);
    for (const mutated of result.mutated) results.set(mutated.id, mutated.value);
    for (const port of outputs) {
      const value = results.get(port);
      if (value !== undefined)
        writeBack(this.#cell(id, port), value, this.#outputOptional(id, port));
    }
    state.args = args;
    state.outputs = results;
    state.activity = "called";
  }
}

/** A node's definition: what a rebuilt graph compares to know it left the node as it was. */
function definition(graph: Graph, id: string): string | undefined {
  const node = graph.nodes[id];
  if (!node) return undefined;
  const links = graph.links
    .filter((l) => l.target.node === id)
    .map((l) => JSON.stringify([l.target.port, l.source, sourceName(graph, l.source)]))
    .sort();
  return JSON.stringify([node.function, node.children, links]);
}

function sourceName(graph: Graph, source: LinkSource): string | undefined {
  return "variable" in source ? graph.variables[source.variable] : undefined;
}

function isOptional(signature: FunctionSignature, param: string): boolean {
  return signature.parameters[param]?.type.type === "frozenOption";
}

/**
 * The argument a bound value passes: to an optional parameter, an absent value
 * passes `none` and a present one `some(value)`; to any other, an absent value
 * passes `()`.
 */
function argumentValue(value: Value | undefined, optional: boolean): Value {
  if (value !== undefined && value !== "unit" && "option" in value) return value;
  if (optional) return { option: value ?? null };
  return value ?? "unit";
}

/** Write an output back to its cell: an optional's presence is the cell's. */
function writeBack(cell: Cell, value: Value, optional: boolean) {
  if (optional && value !== "unit" && "option" in value) {
    if (value.option !== null) cell.set(value.option);
    else if (cell.get() !== undefined) cell.set(undefined);
    return;
  }
  cell.set(value);
}

/** The elements of an array value, each as a value. */
function arrayElements(value: Value): Value[] | undefined {
  if (value === "unit") return undefined;
  const [tag, contents] = Object.entries(value)[0]! as [string, unknown];
  if (!Array.isArray(contents)) return undefined;
  if (tag === "values") return contents as Value[];
  const scalar: Record<string, string> = {
    bools: "bool",
    u8s: "u8",
    u16s: "u16",
    u32s: "u32",
    u64s: "u64",
    i8s: "i8",
    i16s: "i16",
    i32s: "i32",
    i64s: "i64",
    f32s: "f32",
    f64s: "f64",
    strs: "str",
  };
  const element = scalar[tag];
  return element ? contents.map((x) => ({ [element]: x }) as Value) : undefined;
}
