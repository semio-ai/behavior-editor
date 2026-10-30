import { EMPTY_GRAPH, type Graph, type GraphDiff } from "../model/graph";
import type { MethodSignature } from "../model/signature";
import { type Value, valueEquals } from "../model/value";
import type { Loaded } from "../text/language";
import type { BehaviorRuntime, KeyInfo, TickReport } from "./runtime";

/** What a device says of a key: `arora_types::data::KeyMeta`'s JSON, as far as the editor reads it. */
interface KeyMeta {
  ty?: string;
  min?: number;
  max?: number;
  editable?: boolean;
}

/**
 * An Arora device as its host offers it to the page, each operation answering
 * when it returns: a remote client's operations on the device (describe its
 * methods, call one, write its inputs, list its keys), a read of the host's
 * store, and the device's step. Keys are relative to the device, except
 * `read`'s: the host's store holds the device's keys under its id. Values
 * cross as the JSON of Arora's `Value`.
 */
export interface AroraDevice {
  /** The module functions the device exposes: a JSON `MethodSignature[]`. */
  describeMethods(prefix?: string): string;
  /** Call a module function: an `arora_types::call::Call` JSON in, its `CallResult` JSON out. */
  call(callJson: string): string;
  /** Write device-relative keys, `{ "<key>": <Value JSON> | null }`, applied at the next step. */
  update(changesJson: string): void;
  /** Read one key of the host's store, `<deviceId>/<key>`: its Value JSON, or `null`. */
  read(key: string): string;
  /** The device's keys and what they are: a JSON array of `[key, KeyMeta]`, device-relative. */
  listKeys(prefix?: string): string;
  /** Advance the device by `dtMs` milliseconds. */
  step(dtMs: number): void;
}

export interface DeviceRuntimeOptions {
  device: AroraDevice;
  /** The device's id: the namespace its keys are read under. */
  deviceId: string;
  /** The `Call` JSON that loads a graph as the device's behavior: the language's `loadCall`. */
  loadCall: (graph: Graph) => string;
  /** The `Call` JSON that applies a diff to the device's behavior: the language's `editCall`. */
  editCall: (diff: GraphDiff) => string;
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
 * The device reports its store; it does not say which nodes ticked or what
 * the root returned.
 */
export class DeviceRuntime implements BehaviorRuntime {
  readonly #options: DeviceRuntimeOptions;
  #running = false;
  #ticks = 0;
  /** The store as the last step left it, to report what a step changed. */
  #seen = new Map<string, Value>();

  constructor(options: DeviceRuntimeOptions) {
    this.#options = options;
  }

  functions(): Promise<MethodSignature[]> {
    return this.#attempt(
      () => JSON.parse(this.#options.device.describeMethods()) as MethodSignature[],
    );
  }

  start(loaded: Loaded): Promise<void> {
    return this.#attempt(() => {
      const { device, loadCall } = this.#options;
      device.call(loadCall(loaded.graph));
      this.#running = true;
      this.#ticks = 0;
      this.#seen = this.#snapshot();
    });
  }

  edit(diff: GraphDiff): Promise<void> {
    return this.#attempt(() => {
      if (!this.#running) throw new Error("no behavior runs on the device: start one to edit it");
      this.#options.device.call(this.#options.editCall(diff));
      // The device applies a call with a step: a step reports what changed since.
      this.#seen = this.#snapshot();
    });
  }

  step(dtMs: number): Promise<TickReport> {
    return this.#attempt(() => {
      this.#options.device.step(dtMs);
      const now = this.#snapshot();
      const changes: TickReport["changes"] = [];
      for (const [key, value] of now) {
        if (!valueEquals(this.#seen.get(key), value)) changes.push({ key, value });
      }
      for (const key of this.#seen.keys()) if (!now.has(key)) changes.push({ key, value: null });
      this.#seen = now;
      if (!this.#running) return { tick: 0, changes };
      this.#ticks += 1;
      return { tick: this.#ticks, changes };
    });
  }

  write(key: string, value: Value | null): Promise<void> {
    return this.#attempt(() => this.#options.device.update(JSON.stringify({ [key]: value })));
  }

  read(key: string): Promise<Value | null> {
    return this.#attempt(() => this.#readKey(key));
  }

  keys(): Promise<KeyInfo[]> {
    return this.#attempt(() =>
      this.#listed().map(([key, meta]) => ({
        key,
        editable: meta.editable === true,
        ...(meta.ty === undefined ? {} : { ty: meta.ty }),
        ...(meta.min === undefined ? {} : { min: meta.min }),
        ...(meta.max === undefined ? {} : { max: meta.max }),
      })),
    );
  }

  stop(): Promise<void> {
    return this.#attempt(() => {
      if (this.#running) this.#options.device.call(this.#options.loadCall(EMPTY_GRAPH));
      this.#running = false;
    });
  }

  /** `run`'s result, or its exception as a rejection: the device throws its refusals. */
  #attempt<T>(run: () => T): Promise<T> {
    try {
      return Promise.resolve(run());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** The device's keys with their meta: what makes a key open to `update`, and its type. */
  #listed(): [string, KeyMeta][] {
    return JSON.parse(this.#options.device.listKeys()) as [string, KeyMeta][];
  }

  #readKey(key: string): Value | null {
    return JSON.parse(
      this.#options.device.read(`${this.#options.deviceId}/${key}`),
    ) as Value | null;
  }

  #snapshot(): Map<string, Value> {
    const values = new Map<string, Value>();
    for (const [key] of this.#listed()) {
      const value = this.#readKey(key);
      if (value !== null) values.set(key, value);
    }
    return values;
  }
}
