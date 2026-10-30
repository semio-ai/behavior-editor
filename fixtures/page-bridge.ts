/**
 * A device in the page, such as `device/`'s arora-web device, reached as a
 * bridge client: it runs itself, stepping every `periodMs`, and pushes what
 * each step changed, a call's step among them, as a device behind a bridge
 * does.
 */
import type {
  BridgeClient,
  BridgeClosure,
  BridgeKey,
  Call,
  CallResult,
} from "../src/bridge/bridge-client";
import type { MethodSignature } from "../src/model/signature";
import type { Value } from "../src/model/value";
import { valueEquals } from "../src/model/value";
import { parseExact } from "../src/runtime/exact-json";

/** A device the page holds and steps: `DataflowDevice`'s surface. */
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
  /** How often the device steps, in milliseconds: 20 by default. */
  periodMs?: number;
}

export class PageBridge implements BridgeClient {
  readonly closed: Promise<BridgeClosure>;
  readonly #device: PageDevice;
  readonly #namespace: string;
  readonly #listeners = new Set<(values: Record<string, Value>) => void>();
  readonly #timer: ReturnType<typeof setInterval>;
  #seen = new Map<string, Value>();
  #end: (closure: BridgeClosure) => void = () => {};
  #over: string | null = null;

  constructor(device: PageDevice, { namespace, periodMs = 20 }: PageBridgeOptions) {
    this.#device = device;
    this.#namespace = namespace;
    this.closed = new Promise((resolve) => (this.#end = resolve));
    this.#timer = setInterval(() => this.#step(periodMs), periodMs);
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
   * The device checks a write at the step that applies it: the write is
   * applied by a step at a zero dt, as a call is, so a refused one rejects.
   */
  writeValues(values: Record<string, Value>): Promise<void> {
    return this.#answer(() => {
      this.#device.update(JSON.stringify(values));
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

  /** A step of the device, and what it changed pushed. */
  #step(periodMs: number) {
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
