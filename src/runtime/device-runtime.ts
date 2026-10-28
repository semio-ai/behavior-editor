import type { Graph } from "../model/graph";
import type { MethodSignature } from "../model/signature";
import { type Value, valueEquals } from "../model/value";
import type { Loaded } from "../text/language";
import * as N from "./natives";
import type { BehaviorRuntime, TickReport } from "./runtime";

/**
 * A device as Studio's World offers it, bound to one device: the methods of
 * `StudioAroraWorld` with the device id applied. Values cross as tagged JSON.
 */
export interface AroraDevice {
  /** The module functions the device exposes: a JSON `MethodSignature[]`. */
  describeMethods(prefix?: string): string;
  /** Call a module function: an `arora_types::call::Call` JSON in, its `CallResult` JSON out. */
  call(callJson: string): string;
  /** Write device-relative keys, `{ "<key>": <Value JSON> | null }`, applied at the next step. */
  update(changesJson: string): void;
  /** Read one key, namespaced `<device>/<key>`: its Value JSON, or `null`. */
  read(key: string): string;
  /** The device's keys and what they are: a JSON array of `[key, KeyMeta]`, device-relative. */
  listKeys(prefix?: string): string;
  /** Advance the World by `dtMs` milliseconds. */
  step(dtMs: number): void;
}

/** The run a spawned behavior is: how to stop it, and the key it reports its status on. */
export interface TaskHandle {
  /** The `Call` JSON that halts the run. */
  stop: string;
  /** The run's status key, device-relative. */
  status: string;
}

export interface DeviceRuntimeOptions {
  device: AroraDevice;
  /** The device's id: the namespace its keys are read under. */
  deviceId: string;
  /** The `Call` JSON that spawns a graph on the device's interpreter. */
  spawnGraphCall: (graph: Graph) => string;
  /** The run a spawn call's `CallResult` JSON answers with. */
  taskHandle: (callResultJson: string) => TaskHandle;
}

/**
 * A behavior running on a device, through the device's own call path: starting
 * one spawns its graph on the interpreter, as any client's call would, and a
 * graph whose root is the running one's takes its place, keeping the state of
 * the nodes it left in place. The device reports the run's status and its
 * store; it does not say which nodes ticked.
 */
export class DeviceRuntime implements BehaviorRuntime {
  readonly #options: DeviceRuntimeOptions;
  #run: TaskHandle | null = null;
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
      const { device, spawnGraphCall, taskHandle } = this.#options;
      this.#run = taskHandle(device.call(spawnGraphCall(loaded.graph)));
      this.#ticks = 0;
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
      if (!this.#run) return { tick: 0, changes };
      this.#ticks += 1;
      const root = N.statusOf(this.#readKey(this.#run.status));
      return { tick: this.#ticks, ...(root ? { root } : {}), changes };
    });
  }

  write(key: string, value: Value | null): Promise<void> {
    return this.#attempt(() => this.#options.device.update(JSON.stringify({ [key]: value })));
  }

  read(key: string): Promise<Value | null> {
    return this.#attempt(() => this.#readKey(key));
  }

  keys(): Promise<string[]> {
    return this.#attempt(() => this.#keys());
  }

  stop(): Promise<void> {
    return this.#attempt(() => {
      if (this.#run) this.#options.device.call(this.#run.stop);
      this.#run = null;
    });
  }

  /** `run`'s result, or its exception as a rejection: the World throws its refusals. */
  #attempt<T>(run: () => T): Promise<T> {
    try {
      return Promise.resolve(run());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  #keys(): string[] {
    const listed = JSON.parse(this.#options.device.listKeys()) as [string, unknown][];
    return listed.map(([key]) => key);
  }

  #readKey(key: string): Value | null {
    return JSON.parse(
      this.#options.device.read(`${this.#options.deviceId}/${key}`),
    ) as Value | null;
  }

  #snapshot(): Map<string, Value> {
    const values = new Map<string, Value>();
    for (const key of this.#keys()) {
      const value = this.#readKey(key);
      if (value !== null) values.set(key, value);
    }
    return values;
  }
}
