/**
 * A device in the page, such as the local Arora's device, reached as a
 * bridge client: it pushes what each step changed, a call's step among them,
 * as a device behind a bridge does. It steps when the page steps it
 * (`step`), or on its own every `periodMs`, as a remote device would.
 */
import type {
  BridgeClient,
  BridgeClosure,
  BridgeKey,
  Call,
  CallResult,
} from "../bridge/bridge-client";
import type { MethodSignature } from "../model/signature";
import { type Value, valueEquals } from "../model/value";
import { parseExact } from "../runtime/exact-json";

/**
 * A device the page holds: the local Arora's `DataflowDevice`'s surface, each
 * operation answering when it returns, values as the JSON of Arora's `Value`.
 */
export interface PageDevice {
  describeMethods(prefix?: string): string;
  call(callJson: string): string;
  update(changesJson: string): void;
  /** A key by its full path, `<namespace>/<key>`. */
  read(path: string): string;
  listKeys(prefix?: string): string;
  step(dtMs: number): void;
}

export interface PageBridgeOptions {
  /** The namespace the device's keys sit under in the store `read` reads. */
  namespace: string;
  /**
   * How often the device steps on its own, in milliseconds. Without it, the
   * device steps only when the page steps it through `step`.
   */
  periodMs?: number;
}

export class PageBridge implements BridgeClient {
  readonly closed: Promise<BridgeClosure>;
  /**
   * Step the device by `dtMs` milliseconds and push what the step changed:
   * offered only by a bridge whose device steps when the page steps it.
   */
  readonly step?: (dtMs: number) => Promise<void>;
  readonly #device: PageDevice;
  readonly #namespace: string;
  readonly #listeners = new Set<(values: Record<string, Value>) => void>();
  readonly #timer: ReturnType<typeof setInterval> | undefined;
  #seen = new Map<string, Value>();
  #end: (closure: BridgeClosure) => void = () => {};
  #over: string | null = null;

  constructor(device: PageDevice, { namespace, periodMs }: PageBridgeOptions) {
    this.#device = device;
    this.#namespace = namespace;
    this.closed = new Promise((resolve) => (this.#end = resolve));
    if (periodMs === undefined) {
      this.step = (dtMs) =>
        this.#answer(() => {
          this.#device.step(dtMs);
          this.#publish();
        });
    } else {
      this.#timer = setInterval(() => this.#stepItself(periodMs), periodMs);
    }
  }

  describeMethods(prefix?: string): Promise<MethodSignature[]> {
    return this.#answer(() => JSON.parse(this.#device.describeMethods(prefix)) as MethodSignature[]);
  }

  call(call: Call): Promise<CallResult> {
    return this.#answer(() => {
      const result = parseExact(this.#device.call(JSON.stringify(call))) as CallResult;
      // The device applies a call with a step of its own, which pushes too.
      this.#publish();
      return result;
    });
  }

  readValues(keys: readonly string[]): Promise<Record<string, Value>> {
    return this.#answer(() => {
      const values: Record<string, Value> = {};
      for (const key of keys) {
        const value = this.#read(key);
        if (value !== null) values[key] = value;
      }
      return values;
    });
  }

  /**
   * The device checks a write at the step that applies it. A device the page
   * steps applies it at its next step, which rejects a refused one; a device
   * stepping on its own applies it now, by a step at a zero dt, as a call is,
   * so the write itself rejects.
   */
  writeValues(values: Record<string, Value>): Promise<void> {
    return this.#answer(() => {
      this.#device.update(JSON.stringify(values));
      if (this.step) return;
      this.#device.step(0);
      this.#publish();
    });
  }

  listKeys(prefix?: string): Promise<BridgeKey[]> {
    return this.#answer(() =>
      (JSON.parse(this.#device.listKeys(prefix)) as [string, BridgeKey["__meta"]][]).map(
        ([path, meta]) => ({ path, __meta: meta ?? {} }),
      ),
    );
  }

  onValues(listener: (values: Record<string, Value>) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close() {
    if (this.#over !== null) return;
    this.#over = "the connection to the device in the page is closed";
    clearInterval(this.#timer);
    this.#end({ reason: this.#over, cause: "closed" });
  }

  #read(key: string): Value | null {
    return parseExact(this.#device.read(`${this.#namespace}/${key}`)) as Value | null;
  }

  /** A step the device takes on its own, and what it changed pushed. */
  #stepItself(periodMs: number) {
    try {
      this.#device.step(periodMs);
    } catch {
      // A write the step refused is the writer's to hear of; the device steps on.
    }
    this.#publish();
  }

  /** Push what the device's last step changed. */
  #publish() {
    const keys = (JSON.parse(this.#device.listKeys()) as [string, unknown][]).map(([k]) => k);
    const now = new Map<string, Value>();
    const changed: Record<string, Value> = {};
    for (const key of keys) {
      const value = this.#read(key);
      if (value === null) continue;
      now.set(key, value);
      if (!valueEquals(this.#seen.get(key), value)) changed[key] = value;
    }
    this.#seen = now;
    for (const listener of [...this.#listeners]) listener(changed);
  }

  #answer<T>(answer: () => T): Promise<T> {
    if (this.#over !== null) return Promise.reject(new Error(this.#over));
    try {
      return Promise.resolve(answer());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
