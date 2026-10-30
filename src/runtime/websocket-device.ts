/**
 * An Arora device reached over its open local bridge, `arora-bridge-ws`: the
 * JSON messages a device built with `arora` serves on `ws://127.0.0.1:9000`
 * by default. See the bridge's README, "Messages" and "Who may do what".
 */
import type { AroraDevice } from "./device-runtime";
import { TIME_KEY } from "./mock-arora";

/** The bridge's address on a device that serves it with its defaults. */
export const LOCAL_BRIDGE_URL = "ws://127.0.0.1:9000";

/** The WebSocket the device talks through: the browser's, or any of its shape. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
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
  resolve(message: Message): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

const OPEN = 1;

/**
 * An Arora device behind its open local bridge.
 *
 * The device runs on its own clock (`ownClock`): it steps whether the editor
 * follows it or not, and pushes what each step changed. `step` waits for the
 * next push carrying the device's clock, `arora/time`, or answers after
 * `dtMs` when none comes. The store is read from what the device pushed,
 * which starts as what it held when the connection opened: a read is as
 * current as the device's last step. `takeValues` gives every value a key was
 * pushed, for a key that changes at each of the device's steps, as a trace's
 * reports do.
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
    const open = options.open ?? ((at: string) => new WebSocket(at) as unknown as WebSocketLike);
    const socket = open(url);
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve();
      socket.onerror = () => reject(new Error(`no device answers at ${url}`));
      socket.onclose = (event) =>
        reject(new Error(`no device answers at ${url}${event.reason ? `: ${event.reason}` : ""}`));
    });
    const device = new WebSocketDevice(url, socket, options.timeoutMs ?? 10_000);
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

  takeValues(key: string): Promise<string> {
    this.#check();
    const taken = this.#taken.get(key);
    this.#taken.set(key, []);
    if (taken) return Promise.resolve(JSON.stringify(taken));
    const now = this.#values.get(key);
    return Promise.resolve(JSON.stringify(now === undefined ? [] : [now]));
  }

  async listKeys(prefix?: string): Promise<string> {
    const answer = await this.#request({ type: "list_keys", path: prefix }, "list_keys_resp");
    const keys = (answer.keys ?? []) as { path: string; __meta?: unknown }[];
    return JSON.stringify(keys.map((info) => [info.path, info.__meta ?? {}]));
  }

  step(dtMs: number): Promise<void> {
    this.#check();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined = undefined;
      const stepped = () => {
        clearTimeout(timer);
        this.#stepped = this.#stepped.filter((s) => s !== stepped);
        resolve();
      };
      timer = setTimeout(stepped, dtMs);
      this.#stepped.push(stepped);
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
    const read = await this.#request({ type: "read_values", keys }, "read_values_resp");
    for (const [key, value] of Object.entries((read.values ?? {}) as Record<string, unknown>)) {
      this.#values.set(key, value);
    }
  }

  #check() {
    if (this.#closedWith !== null) throw new Error(this.#closedWith);
  }

  #request(message: Message, answer: string): Promise<Message> {
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
      this.#waiting.push({ answer, resolve, reject, timer });
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
      for (const [key, value] of Object.entries(values)) {
        this.#values.set(key, value);
        this.#taken.get(key)?.push(value);
      }
      if (TIME_KEY in values) for (const stepped of [...this.#stepped]) stepped();
      return;
    }
    const waiting = this.#waiting.shift();
    if (!waiting) return;
    clearTimeout(waiting.timer);
    if (message.type === waiting.answer) waiting.resolve(message);
    else if (message.type === "error") {
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
