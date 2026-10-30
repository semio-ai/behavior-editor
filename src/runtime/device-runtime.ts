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

/** An answer now, or the promise of one: a device in the page answers at once, a remote one later. */
export type DeviceAnswer<T> = T | Promise<T>;

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
  /** The store as the last step left it, to report what a step changed. */
  #seen = new Map<string, Value>();

  constructor(options: DeviceRuntimeOptions) {
    this.#options = options;
  }

  async functions(): Promise<MethodSignature[]> {
    return JSON.parse(await this.#options.device.describeMethods()) as MethodSignature[];
  }

  async start(loaded: Loaded): Promise<void> {
    const { device, loadCall } = this.#options;
    await device.call(loadCall(loaded.graph));
    this.#running = true;
    this.#ticks = 0;
    this.#seen = await this.#snapshot();
  }

  async edit(diff: GraphDiff): Promise<void> {
    if (!this.#running) throw new Error("no behavior runs on the device: start one to edit it");
    await this.#options.device.call(this.#options.editCall(diff));
    // The device applies a call with a step: a step reports what changed since.
    this.#seen = await this.#snapshot();
  }

  async step(dtMs: number): Promise<TickReport> {
    await this.#options.device.step(dtMs);
    const now = await this.#snapshot();
    const changes: TickReport["changes"] = [];
    for (const [key, value] of now) {
      if (!valueEquals(this.#seen.get(key), value)) changes.push({ key, value });
    }
    for (const key of this.#seen.keys()) if (!now.has(key)) changes.push({ key, value: null });
    this.#seen = now;
    if (!this.#running) return { tick: 0, changes };
    this.#ticks += 1;
    return { tick: this.#ticks, changes };
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
    if (this.#running) await this.#options.device.call(this.#options.loadCall(EMPTY_GRAPH));
    this.#running = false;
  }

  /** The device's keys with their meta: what makes a key open to `update`, and its type. */
  async #listed(): Promise<[string, KeyMeta][]> {
    return JSON.parse(await this.#options.device.listKeys()) as [string, KeyMeta][];
  }

  async #readKey(key: string): Promise<Value | null> {
    const { device, deviceId } = this.#options;
    const at = deviceId === undefined ? key : `${deviceId}/${key}`;
    return JSON.parse(await device.read(at)) as Value | null;
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
