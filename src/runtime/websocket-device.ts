/**
 * An Arora device reached over its open local bridge, `arora-bridge-ws`: the
 * JSON messages a device built with `arora` serves on `ws://127.0.0.1:9000`
 * by default. See the bridge's README, "Messages" and "Who may do what".
 */
import type { AroraDevice } from "./device-runtime";
import { parseExact } from "./exact-json";
import { TIME_KEY } from "./mock-arora";

/** The bridge's address on a device that serves it with its defaults. */
export const LOCAL_BRIDGE_URL = "ws://127.0.0.1:9000";

/** The WebSocket the device talks through: the browser's, or any of its shape. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
}

export interface WebSocketDeviceOptions {
  /** How long an answer is waited for, in milliseconds: 10 s by default. */
  timeoutMs?: number;
  /** Opens the socket; the global `WebSocket` by default. */
  open?(url: string): WebSocketLike;
}

/** A message of the bridge, as far as the device reads it. */
interface Message {
  type: string;
  [field: string]: unknown;
}

/** A request waiting for its answer: the bridge answers each in the order it came. */
interface Waiting {
  answer: string;
  /** Run as the answer arrives, before any message after it. */
  received?(message: Message): void;
  resolve(message: Message): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const OPEN = 1;

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
 * An Arora device behind its open local bridge.
 *
 * The device runs on its own clock (`ownClock`): it steps whether the editor
 * follows it or not, and pushes what each step changed. `step` waits for the
 * next push carrying the device's clock, `arora/time`, or answers after
 * `dtMs` when none comes. The store is read from what the device pushed,
 * which starts as what it held when the connection opened, and which each
 * step reads again whole, as the device pushes what it sets and not what it
 * unsets: a read is as current as the device's last step. `takeValues` gives
 * every value a key was pushed, the last `TAKEN_LIMIT` of them, for a key that
 * changes at each of the device's steps, as a trace's reports do.
 *
 * A request is answered in the order it was sent, as the bridge answers its
 * messages one at a time; a request with no answer within the timeout, or
 * pending when the connection closes, rejects. The bridge serves one client at
 * a time: another connecting closes this one, which `closed` reports.
 */
export class WebSocketDevice implements AroraDevice {
  readonly ownClock = true;
  readonly url: string;
  /** Settles when the connection closes, with why. */
  readonly closed: Promise<string>;

  readonly #socket: WebSocketLike;
  readonly #timeoutMs: number;
  readonly #waiting: Waiting[] = [];
  readonly #values = new Map<string, unknown>();
  /** The values each key `takeValues` follows was pushed since its last call. */
  readonly #taken = new Map<string, unknown[]>();
  /** The prefixes whose keys' values are kept from their first push (`keepValues`). */
  readonly #kept = new Set<string>();
  #stepped: (() => void)[] = [];
  #closedWith: string | null = null;
  #requests = 0;

  /**
   * Connect to the bridge at `url`, and read the device's store as it is: the
   * device, once its keys and their values have arrived.
   */
  static async connect(
    url: string = LOCAL_BRIDGE_URL,
    options: WebSocketDeviceOptions = {},
  ): Promise<WebSocketDevice> {
    const open = options.open ?? ((at: string): WebSocketLike => new WebSocket(at));
    const timeoutMs = options.timeoutMs ?? 10_000;
    const socket = open(url);
    await new Promise<void>((resolve, reject) => {
      // A connection not open within the timeout is let go: it would take the
      // bridge's one client slot whenever it did open.
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`no device answered at ${url} within ${timeoutMs} ms`));
      }, timeoutMs);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error(`no device answers at ${url}`));
      };
      socket.onclose = (event) => {
        clearTimeout(timer);
        reject(new Error(`no device answers at ${url}${event.reason ? `: ${event.reason}` : ""}`));
      };
    });
    const device = new WebSocketDevice(url, socket, timeoutMs);
    try {
      await device.#seed();
    } catch (error) {
      // The bridge serves one client: a device not handed back lets it go.
      device.close();
      throw error;
    }
    return device;
  }

  private constructor(url: string, socket: WebSocketLike, timeoutMs: number) {
    this.url = url;
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
    let settle: (reason: string) => void = () => {};
    this.closed = new Promise((resolve) => (settle = resolve));
    socket.onmessage = (event) => this.#receive(event.data);
    socket.onerror = () => {};
    socket.onclose = (event) => {
      const reason = `the device at ${url} closed the connection${event.reason ? `: ${event.reason}` : ""}`;
      this.#closedWith = reason;
      for (const waiting of this.#waiting.splice(0)) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error(reason));
      }
      for (const stepped of this.#stepped.splice(0)) stepped();
      settle(reason);
    };
  }

  async describeMethods(prefix?: string): Promise<string> {
    const answer = await this.#request(
      { type: "describe_methods", path: prefix },
      "describe_methods_resp",
    );
    return JSON.stringify(answer.methods ?? []);
  }

  async call(callJson: string): Promise<string> {
    const call = JSON.parse(callJson) as Record<string, unknown>;
    this.#requests += 1;
    const answer = await this.#request(
      { ...call, type: "call", request_id: `call-${this.#requests}` },
      "call_resp",
    );
    if (answer.success !== true) {
      throw new Error(
        typeof answer.message === "string" ? answer.message : "the device refused the call",
      );
    }
    return JSON.stringify({ ret: answer.ret ?? null, mutated: answer.mutated ?? [] });
  }

  async update(changesJson: string): Promise<void> {
    const changes = JSON.parse(changesJson) as Record<string, unknown>;
    const unset = Object.keys(changes).filter((key) => changes[key] === null);
    if (unset.length) {
      throw new Error(`the bridge writes values and unsets no key: ${unset.join(", ")}`);
    }
    const answer = await this.#request(
      { type: "write_values", values: changes },
      "write_values_resp",
    );
    if (answer.success !== true) {
      throw new Error(
        typeof answer.message === "string" ? answer.message : "the device refused the write",
      );
    }
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
    this.#taken.delete(key);
    this.#keep(key);
    if (taken) return Promise.resolve(JSON.stringify(taken));
    const now = this.#values.get(key);
    return Promise.resolve(JSON.stringify(now === undefined ? [] : [now]));
  }

  /** Start keeping `key`'s values, past `TAKEN_KEYS` letting go of the key kept longest. */
  #keep(key: string): unknown[] {
    const taken: unknown[] = [];
    this.#taken.set(key, taken);
    // Map keeps keys in the order they came: the first is the one kept longest.
    if (this.#taken.size > TAKEN_KEYS) this.#taken.delete(this.#taken.keys().next().value!);
    return taken;
  }

  #isKept(key: string): boolean {
    for (const prefix of this.#kept) if (key.startsWith(prefix)) return true;
    return false;
  }

  async listKeys(prefix?: string): Promise<string> {
    const answer = await this.#request({ type: "list_keys", path: prefix }, "list_keys_resp");
    const keys = (answer.keys ?? []) as { path: string; __meta?: unknown }[];
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

  /**
   * Read every key the store holds again: the device pushes what it sets, not
   * what it unsets, so a key it no longer answers for is let go here. The
   * answer is applied as it arrives, after every push before it.
   */
  async #reconcile() {
    const keys = [...this.#values.keys()];
    if (!keys.length) return;
    await this.#request({ type: "read_values", keys }, "read_values_resp", (read) => {
      const values = (read.values ?? {}) as Record<string, unknown>;
      for (const key of keys) {
        if (Object.hasOwn(values, key)) this.#values.set(key, values[key]);
        else this.#values.delete(key);
      }
    });
  }

  /** Close the connection. */
  close() {
    this.#socket.close(1000, "closed by the editor");
  }

  /** The device's keys and their values, as it holds them now. */
  async #seed() {
    const listed = await this.#request({ type: "list_keys" }, "list_keys_resp");
    const keys = ((listed.keys ?? []) as { path: string }[]).map((info) => info.path);
    if (!keys.length) return;
    // The values seed the store as the answer arrives: a push right behind it
    // is newer, and must not be overwritten by them.
    await this.#request({ type: "read_values", keys }, "read_values_resp", (read) => {
      for (const [key, value] of Object.entries((read.values ?? {}) as Record<string, unknown>)) {
        this.#values.set(key, value);
      }
    });
  }

  #check() {
    if (this.#closedWith !== null) throw new Error(this.#closedWith);
  }

  #request(
    message: Message,
    answer: string,
    received?: (message: Message) => void,
  ): Promise<Message> {
    return new Promise((resolve, reject) => {
      if (this.#closedWith !== null || this.#socket.readyState !== OPEN) {
        reject(new Error(this.#closedWith ?? `the connection to ${this.url} is not open`));
        return;
      }
      const timer = setTimeout(() => {
        // The bridge answers in order: one answer missing leaves every later one misplaced.
        this.close();
        reject(new Error(`the device at ${this.url} did not answer ${message.type}`));
      }, this.#timeoutMs);
      this.#waiting.push({ answer, received, resolve, reject, timer });
      this.#socket.send(JSON.stringify(message));
    });
  }

  #receive(data: unknown) {
    let message: Message;
    try {
      message = JSON.parse(String(data)) as Message;
    } catch {
      return;
    }
    if (message.type === "values_changed") {
      const values = (message.values ?? {}) as Record<string, unknown>;
      // A kept value goes on to Rust: its integers keep their digits.
      let exact: Record<string, unknown> | null = null;
      for (const [key, value] of Object.entries(values)) {
        const kept = this.#isKept(key);
        if (!kept) this.#values.set(key, value);
        let taken = this.#taken.get(key);
        if (!taken && kept) taken = this.#keep(key);
        if (taken) {
          exact ??= ((parseExact(String(data)) as Message).values ?? {}) as Record<string, unknown>;
          taken.push(exact[key]);
          if (taken.length > TAKEN_LIMIT) taken.shift();
        }
      }
      if (TIME_KEY in values) for (const stepped of [...this.#stepped]) stepped();
      return;
    }
    const waiting = this.#waiting.shift();
    if (!waiting) return;
    clearTimeout(waiting.timer);
    if (message.type === waiting.answer) {
      waiting.received?.(message);
      waiting.resolve(message);
    } else if (message.type === "error") {
      waiting.reject(
        new Error(
          typeof message.message === "string" ? message.message : "the device answered an error",
        ),
      );
    } else {
      waiting.reject(
        new Error(`the device answered ${message.type} to a request for ${waiting.answer}`),
      );
    }
  }
}
