import { EMPTY_GRAPH, type Graph, type GraphDiff, isEmptyDiff } from "../model/graph";
import type { MethodSignature } from "../model/signature";
import { type Value, valueEquals } from "../model/value";
import type { BehaviorText, Loaded } from "../text/language";
import type { BehaviorRuntime, KeyInfo, TickReport } from "./runtime";
import { parseExact } from "./exact-json";
import { type TraceHandle, TraceView, watchedNodes } from "./trace";

/** What a device says of a key: `arora_types::data::KeyMeta`'s JSON, as far as the editor reads it. */
interface KeyMeta {
  ty?: string;
  min?: number;
  max?: number;
  editable?: boolean;
}

/** An answer now, or the promise of one: a device in the page answers at once, a remote one later. */
export type DeviceAnswer<T> = T | Promise<T>;

/**
 * A behavior running on a device as a client knows it, to follow it: its
 * root, whose status is the behavior's, its nodes, and those whose outputs
 * the trace carries.
 */
export interface FollowedBehavior {
  root?: string;
  nodes: readonly string[];
  watched: readonly string[];
}

/**
 * The behavior `loaded` as a trace follows it: the nodes the text names and
 * the detached ones watched.
 */
export function followed(loaded: Loaded): FollowedBehavior {
  return {
    ...(loaded.graph.root === undefined ? {} : { root: loaded.graph.root }),
    nodes: loaded.nodes.map((n) => n.id),
    watched: watchedNodes(loaded),
  };
}

/**
 * An Arora device as its host offers it to the page: a remote client's
 * operations on the device (describe its methods, call one, write its inputs,
 * list its keys), a read of its store, and its step. Each answers when it
 * returns, or with a promise; a refusal throws or rejects. Values cross as the
 * JSON of Arora's `Value`.
 *
 * Keys are relative to the device, except `read`'s where the store it reads
 * holds the device's keys under its id, as a host's store does
 * (`DeviceRuntimeOptions.deviceId`).
 *
 * A device either steps when the editor steps it, or runs on its own clock,
 * as a device reached over a network does (`ownClock`): its `step` then
 * waits for the device's next step rather than making one.
 */
export interface AroraDevice {
  /** The module functions the device exposes: a JSON `MethodSignature[]`. */
  describeMethods(prefix?: string): DeviceAnswer<string>;
  /** Call a module function: an `arora_types::call::Call` JSON in, its `CallResult` JSON out. */
  call(callJson: string): DeviceAnswer<string>;
  /** Write device-relative keys, `{ "<key>": <Value JSON> | null }`, applied at the next step. */
  update(changesJson: string): DeviceAnswer<void>;
  /** Read one key: its Value JSON, or `null`. */
  read(key: string): DeviceAnswer<string>;
  /**
   * The values the device-relative `key` took since the last call for it,
   * oldest first, as a JSON array: the first call answers the value it holds.
   * A device on its own clock offers it, as a key may change at several of its
   * steps between two the editor sees.
   */
  takeValues?(key: string): DeviceAnswer<string>;
  /**
   * Keep, from now on, every value pushed to a device-relative key starting
   * with `prefix`, for `takeValues` to give: a key that appears with its
   * first values, as a trace's feedback key does, loses none of them. A key
   * kept this way gives nothing at its first `takeValues` but what it was
   * pushed.
   */
  keepValues?(prefix: string): DeviceAnswer<void>;
  /** The device's keys and what they are: a JSON array of `[key, KeyMeta]`, device-relative. */
  listKeys(prefix?: string): DeviceAnswer<string>;
  /**
   * The device's next step: advance it by `dtMs` milliseconds or, on its own
   * clock, wait for it, answering after about `dtMs` when it has not stepped.
   */
  step(dtMs: number): DeviceAnswer<void>;
  /** Whether the device steps on its own clock, the editor only following it. */
  readonly ownClock?: boolean;
}

export interface DeviceRuntimeOptions {
  device: AroraDevice;
  /**
   * The device's id, where `read` reads a store holding the device's keys
   * under it (a host's store, as arora-web's); absent where `read` reads the
   * device's own keys.
   */
  deviceId?: string;
  /** The `Call` JSON that loads a graph as the device's behavior: the language's `loadCall`. */
  loadCall: (graph: Graph) => string;
  /** The `Call` JSON that applies a diff to the device's behavior: the language's `editCall`. */
  editCall: (diff: GraphDiff) => string;
  /**
   * How to trace the behavior, for each node's status, each detached node's
   * activity and the named and detached nodes' values: the language. Without
   * it, or on a device whose interpreter does not trace, the runtime reports
   * the store alone.
   */
  trace?: Pick<BehaviorText, "traceCall" | "traceHandle" | "traceReport">;
}

/**
 * A behavior running on a device, through the device's own call path, as any
 * client's call would reach the interpreter:
 *
 * - `start` sends LOAD with the behavior's graph: the device ticks it at every
 *   step and re-evaluates it once it completes, as a behavior tree is, in place
 *   of the behavior it had, every node starting afresh.
 * - `edit` sends EDIT with a graph diff: the device restarts the nodes the diff
 *   sets or binds, and every other node keeps its state, a `sequence_star`
 *   its place among its children and a `damp` its value.
 * - `stop` sends LOAD with the empty graph, which runs nothing.
 *
 * Given the language's `trace`, it follows the behavior's nodes through a
 * trace (arora-behavior's `docs/trace.md`): `start` starts one, watching the
 * outputs of the nodes the text names and of the detached ones, and each step
 * folds the reports written since into each node's status, each detached
 * node's activity and each watched node's return value, as the mock reports
 * them. An edit that changes the nodes watched, or a report that follows one
 * not read, starts the trace over; `stop` halts it. Without a trace, the
 * device reports its store alone.
 *
 * A device on its own clock runs its behavior whether the editor follows it
 * or not: a step waits for the device's next one and reports what changed
 * since the previous step the editor saw, which may span several of the
 * device's; pausing stops following, not the device.
 */
export class DeviceRuntime implements BehaviorRuntime {
  readonly #options: DeviceRuntimeOptions;
  #running = false;
  #ticks = 0;
  /**
   * The store as the last step reported it, to report what a step changed;
   * `null` after a start or an edit, when the next step states every key
   * (`whole`).
   * The host may read the store meanwhile, and a device on its own clock
   * changes it under that read: the next step then states it whole.
   */
  #seen: Map<string, Value> | null = new Map();
  /** The trace following the behavior's nodes, and the nodes it watches. */
  #trace: { handle: TraceHandle; watched: string[] } | null = null;
  #view = new TraceView();
  /** The behavior's root, whose status is the report's. */
  #root: string | undefined;
  /** Where the interpreter keeps its traces' keys, once one is started: `arora/tasks/<module>/<TRACE>/`. */
  #traces: string | null = null;
  /** Whether the trace's view missed a report it could not start over for at once. */
  #missed = false;
  /** The behavior's nodes: a trace reports the interpreter's own besides. */
  #nodes = new Set<string>();

  constructor(options: DeviceRuntimeOptions) {
    this.#options = options;
  }

  async functions(): Promise<MethodSignature[]> {
    return JSON.parse(await this.#options.device.describeMethods()) as MethodSignature[];
  }

  async start(loaded: Loaded): Promise<void> {
    const { device, loadCall } = this.#options;
    await device.call(loadCall(loaded.graph));
    await this.follow(followed(loaded));
  }

  /**
   * Follow the behavior the device runs without loading one, as a client
   * attaching to a device finds it: from its next step, as from a start, with
   * a new trace watching `behavior.watched`.
   */
  async follow(behavior: FollowedBehavior): Promise<void> {
    this.#running = true;
    this.#ticks = 0;
    this.#root = behavior.root;
    this.#nodes = new Set(behavior.nodes);
    // A behavior followed afresh shows nothing of the one before.
    this.#view = new TraceView();
    await this.#follow([...behavior.watched]);
    this.#seen = null;
  }

  /**
   * Stop following the behavior, its trace halted, and leave it running on
   * the device: what a client letting go of a device does.
   */
  async release(): Promise<void> {
    await this.#halt();
    this.#running = false;
  }

  /**
   * The interpreter's tick of the last trace report read: the device's own
   * count, which a trace reports at each tick that changes what it follows.
   * `null` without a trace, or before its first report.
   */
  get deviceTick(): number | null {
    return this.#trace ? this.#view.tick : null;
  }

  /** The `Call` JSON that halts the trace running, for a client that loses the connection it ran on. */
  get traceStop(): string | null {
    return this.#trace ? JSON.stringify(this.#trace.handle.stop) : null;
  }

  async edit(diff: GraphDiff, next?: Loaded): Promise<void> {
    if (!this.#running) throw new Error("no behavior runs on the device: start one to edit it");
    // An empty diff changes nothing on the device: only what `next` says of the nodes.
    if (!isEmptyDiff(diff)) await this.#options.device.call(this.#options.editCall(diff));
    if (next) {
      this.#root = next.graph.root;
      this.#nodes = new Set(next.nodes.map((n) => n.id));
    } else {
      // The behavior as the diff makes it, as far as it says, in the order
      // `applyDiff` applies it: a removed root goes with its node, then the
      // diff's own root, if any, stands.
      for (const id of diff.remove ?? []) {
        this.#nodes.delete(id);
        if (this.#root === id) this.#root = undefined;
      }
      for (const node of diff.set ?? []) this.#nodes.add(node.id);
      if (diff.root !== undefined) this.#root = diff.root;
    }
    const watched = next && watchedNodes(next);
    if (this.#trace && watched && !sameNodes(watched, this.#trace.watched)) {
      await this.#follow(watched);
    } else if (this.#trace) {
      await this.#readTrace(true);
    }
    // The device applies a call with a step: a step reports what changed since.
    this.#seen = null;
  }

  async step(dtMs: number): Promise<TickReport> {
    await this.#options.device.step(dtMs);
    // The trace is read, and started over if need be, before the store: a
    // device applying a call with a step ticks at HALT and TRACE, and the
    // store then shows what that tick did, as the nodes do.
    if (this.#running && this.#trace) await this.#readTrace(true);
    const now = await this.#snapshot();
    const changes: TickReport["changes"] = [];
    for (const [key, value] of now) {
      if (!this.#seen || !valueEquals(this.#seen.get(key), value)) changes.push({ key, value });
    }
    for (const key of this.#seen?.keys() ?? [])
      if (!now.has(key)) changes.push({ key, value: null });
    const store = this.#seen === null ? { changes, whole: true } : { changes };
    this.#seen = now;
    if (!this.#running) return { tick: 0, ...store };
    this.#ticks += 1;
    if (!this.#trace) return { tick: this.#ticks, ...store };
    return { tick: this.#ticks, ...store, ...this.#view.report(this.#root, this.#nodes) };
  }

  async write(key: string, value: Value | null): Promise<void> {
    await this.#options.device.update(JSON.stringify({ [key]: value }));
  }

  read(key: string): Promise<Value | null> {
    return this.#readKey(key);
  }

  async keys(): Promise<KeyInfo[]> {
    return (await this.#listed()).map(([key, meta]) => ({
      key,
      editable: meta.editable === true,
      ...(meta.ty === undefined ? {} : { ty: meta.ty }),
      ...(meta.min === undefined ? {} : { min: meta.min }),
      ...(meta.max === undefined ? {} : { max: meta.max }),
    }));
  }

  async stop(): Promise<void> {
    await this.#halt();
    if (this.#running) await this.#options.device.call(this.#options.loadCall(EMPTY_GRAPH));
    this.#running = false;
  }

  /**
   * Follow the behavior with a new trace watching `watched`, in place of the
   * one running: its first report states every node anew. A device whose
   * interpreter refuses to trace is followed by its store alone.
   */
  async #follow(watched: string[]) {
    const { device, trace } = this.#options;
    await this.#halt();
    if (!trace) return;
    const call = trace.traceCall({ values: watched });
    // A trace's keys sit under `arora/tasks/<module>/<function>/<run id>/`: a
    // device that keeps values keeps the reports from the first, which may be
    // pushed before the call is answered.
    const { module_id: module, id } = JSON.parse(call) as { module_id: string; id: string };
    this.#traces = `arora/tasks/${module}/${id}/`;
    await device.keepValues?.(this.#traces);
    let handle: TraceHandle;
    try {
      handle = trace.traceHandle(await device.call(call));
    } catch {
      return;
    }
    this.#trace = { handle, watched };
    this.#missed = false;
    // A new trace is read from its first report: until one comes, no report
    // of it follows one the view read, whatever the old trace's last tick.
    this.#view.awaitFirst();
    // A device applying a call with a step may have reported already.
    await this.#readTrace(false);
  }

  /** Halt the trace running, if one does: a trace the device no longer runs is let go. */
  async #halt() {
    const running = this.#trace;
    this.#trace = null;
    if (!running) return;
    const { device } = this.#options;
    try {
      await device.call(JSON.stringify(running.handle.stop));
      // What it reported and was not read goes with it.
      await device.takeValues?.(running.handle.feedback[0]!);
    } catch {
      // The trace ended with the behavior or the device: nothing to halt.
    }
  }

  /**
   * Fold in the reports the trace wrote since they were last read; past a
   * gap, start it over when `restart` says so. A device applying a call with
   * a step reports at the call: each call is followed by a read.
   */
  async #readTrace(restart: boolean) {
    const { device, trace } = this.#options;
    const running = this.#trace!;
    const feedback = running.handle.feedback[0]!;
    // A report missed at a read that could not start the trace over still
    // makes the view incomplete: the next read that can, does.
    if (restart && this.#missed) {
      await this.#follow(running.watched);
      return;
    }
    // Each report as JSON, its integers' digits as the device wrote them: the
    // Rust decoder refuses a rounded 64-bit value.
    let reports: string[];
    if (device.takeValues) {
      const taken = parseExact(await device.takeValues(feedback)) as unknown[];
      reports = taken.map((value) => JSON.stringify(value));
    } else {
      const latest = await this.#rawRead(feedback);
      reports = latest === "null" ? [] : [latest];
    }
    for (const report of reports) {
      if (!this.#view.read(trace!.traceReport(report))) {
        if (restart) await this.#follow(running.watched);
        else this.#missed = true;
        return;
      }
    }
  }

  /**
   * The device's keys with their meta: what makes a key open to `update`, and
   * its type. The keys of the interpreter's traces, this runtime's or any
   * client's, are the clients' bookkeeping, not the behavior's: they are left
   * out.
   */
  async #listed(): Promise<[string, KeyMeta][]> {
    const listed = JSON.parse(await this.#options.device.listKeys()) as [string, KeyMeta][];
    const traces = this.#traces;
    return traces === null ? listed : listed.filter(([key]) => !key.startsWith(traces));
  }

  async #readKey(key: string): Promise<Value | null> {
    return JSON.parse(await this.#rawRead(key)) as Value | null;
  }

  /** The Value JSON of the device-relative `key`, or `null`. */
  async #rawRead(key: string): Promise<string> {
    const { device, deviceId } = this.#options;
    return device.read(deviceId === undefined ? key : `${deviceId}/${key}`);
  }

  async #snapshot(): Promise<Map<string, Value>> {
    const keys = (await this.#listed()).map(([key]) => key);
    const values = await Promise.all(keys.map((key) => this.#readKey(key)));
    const snapshot = new Map<string, Value>();
    keys.forEach((key, i) => {
      const value = values[i];
      if (value != null) snapshot.set(key, value);
    });
    return snapshot;
  }
}

/** Whether `a` and `b` hold the same nodes. */
function sameNodes(a: readonly string[], b: readonly string[]): boolean {
  const set = new Set(a);
  return a.length === b.length && b.every((n) => set.has(n));
}
