import type { Value } from "../model/value";
import type { AroraDevice } from "../runtime/device-runtime";
import { parseExact } from "../runtime/exact-json";
import { TIME_KEY } from "../runtime/mock-arora";
import type { BridgeClient, Call } from "./bridge-client";

/**
 * How many values of a key `takeValues` keeps between two calls: past it,
 * the oldest go. A trace reading them then sees a report missing and starts
 * over, so a long pause costs one restart rather than memory.
 */
export const TAKEN_LIMIT = 256;

/**
 * How many keys values are kept for: past it, the key kept longest goes, as
 * a trace no longer read leaves its feedback key behind.
 */
export const TAKEN_KEYS = 32;

/**
 * A device reached through a bridge client, as `DeviceRuntime` follows it:
 * on its own clock (`ownClock`), stepping whether a client follows it or not.
 *
 * `step` waits for the next push carrying the device's clock, `arora/time`,
 * or answers after `dtMs` when none comes. The store is read from what the
 * device pushed, which starts as what it held when the device was taken up,
 * and which each step reads again whole, as the device pushes what it sets
 * and not what it unsets: a read is as current as the device's last step.
 * `takeValues` gives every value a key was pushed, the last `TAKEN_LIMIT` of
 * them, for a key that changes at each of the device's steps, as a trace's
 * reports do.
 */
export class BridgeDevice implements AroraDevice {
  readonly ownClock = true;
  readonly client: BridgeClient;

  readonly #values = new Map<string, unknown>();
  /** The values each key `takeValues` follows was pushed since its last call. */
  readonly #taken = new Map<string, unknown[]>();
  /** The prefixes whose keys' values are kept from their first push (`keepValues`). */
  readonly #kept = new Set<string>();
  #stepped: (() => void)[] = [];
  #closedWith: string | null = null;

  /** The device behind `client`, once its keys and their values have arrived. */
  static async over(client: BridgeClient): Promise<BridgeDevice> {
    const device = new BridgeDevice(client);
    await device.#seed();
    return device;
  }

  private constructor(client: BridgeClient) {
    this.client = client;
    client.onValues((values) => this.#pushed(values));
    void client.closed.then(({ reason }) => {
      this.#closedWith = reason;
      for (const stepped of this.#stepped.splice(0)) stepped();
    });
  }

  async describeMethods(prefix?: string): Promise<string> {
    return JSON.stringify(await this.client.describeMethods(prefix));
  }

  async call(callJson: string): Promise<string> {
    // A call's integers keep their digits on their way to the device.
    return JSON.stringify(await this.client.call(parseExact(callJson) as Call));
  }

  async update(changesJson: string): Promise<void> {
    const changes = parseExact(changesJson) as Record<string, Value | null>;
    const unset = Object.keys(changes).filter((key) => changes[key] === null);
    if (unset.length) {
      throw new Error(`a bridge writes values and unsets no key: ${unset.join(", ")}`);
    }
    await this.client.writeValues(changes as Record<string, Value>);
  }

  read(key: string): Promise<string> {
    this.#check();
    return Promise.resolve(JSON.stringify(this.#values.get(key) ?? null));
  }

  keepValues(prefix: string): Promise<void> {
    this.#check();
    this.#kept.add(prefix);
    // Kept keys are given by `takeValues` alone: the store read and read
    // again at each step holds none, a retired trace's among them.
    for (const key of [...this.#values.keys()])
      if (key.startsWith(prefix)) this.#values.delete(key);
    return Promise.resolve();
  }

  takeValues(key: string): Promise<string> {
    this.#check();
    const taken = this.#taken.get(key);
    if (this.#isKept(key)) {
      this.#taken.delete(key);
      return Promise.resolve(JSON.stringify(taken ?? []));
    }
    this.#taken.set(key, []);
    if (taken) return Promise.resolve(JSON.stringify(taken));
    const now = this.#values.get(key);
    return Promise.resolve(JSON.stringify(now === undefined ? [] : [now]));
  }

  async listKeys(prefix?: string): Promise<string> {
    const keys = await this.client.listKeys(prefix);
    return JSON.stringify(keys.map((info) => [info.path, info.__meta ?? {}]));
  }

  async step(dtMs: number): Promise<void> {
    this.#check();
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined = undefined;
      const stepped = () => {
        clearTimeout(timer);
        this.#stepped = this.#stepped.filter((s) => s !== stepped);
        resolve();
      };
      timer = setTimeout(stepped, dtMs);
      this.#stepped.push(stepped);
    });
    await this.#reconcile();
  }

  #isKept(key: string): boolean {
    for (const prefix of this.#kept) if (key.startsWith(prefix)) return true;
    return false;
  }

  /**
   * Read every key the store holds again: the device pushes what it sets, not
   * what it unsets, so a key it no longer answers for is let go here. The
   * answer is newer than every push before it.
   */
  async #reconcile() {
    const keys = [...this.#values.keys()];
    if (!keys.length) return;
    const values = await this.client.readValues(keys);
    for (const key of keys) {
      if (Object.hasOwn(values, key)) this.#values.set(key, values[key]);
      else this.#values.delete(key);
    }
  }

  /** The device's keys and their values, as it holds them now. */
  async #seed() {
    const keys = (await this.client.listKeys()).map((info) => info.path);
    if (!keys.length) return;
    // The values seed the store as the answer arrives: a push right behind it
    // is newer, and must not be overwritten by them.
    const values = await this.client.readValues(keys);
    for (const [key, value] of Object.entries(values)) this.#values.set(key, value);
  }

  #check() {
    if (this.#closedWith !== null) throw new Error(this.#closedWith);
  }

  #pushed(values: Record<string, Value>) {
    for (const [key, value] of Object.entries(values)) {
      const kept = this.#isKept(key);
      if (!kept) this.#values.set(key, value);
      let taken = this.#taken.get(key);
      if (!taken && kept) {
        taken = [];
        this.#taken.set(key, taken);
        // The key kept longest goes: Map keeps keys in the order they came.
        if (this.#taken.size > TAKEN_KEYS) this.#taken.delete(this.#taken.keys().next().value!);
      }
      if (taken) {
        taken.push(value);
        if (taken.length > TAKEN_LIMIT) taken.shift();
      }
    }
    if (TIME_KEY in values) for (const stepped of [...this.#stepped]) stepped();
  }
}
