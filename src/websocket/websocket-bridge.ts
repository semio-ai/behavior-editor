/**
 * The open local bridge of an Arora device, `arora-bridge-ws`: the JSON
 * messages a device built with `arora` serves on `ws://127.0.0.1:9000` by
 * default. See the bridge's README, "Messages" and "Who may do what".
 */
import type {
  BridgeClient,
  BridgeClosure,
  BridgeKey,
  Call,
  CallResult,
} from "../bridge/bridge-client";
import type { MethodSignature } from "../model/signature";
import type { Value } from "../model/value";
import { parseExact } from "../runtime/exact-json";

/** The bridge's address on a device that serves it with its defaults. */
export const LOCAL_BRIDGE_URL = "ws://127.0.0.1:9000";

/** The WebSocket the bridge talks through: the browser's, or any of its shape. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface WebSocketBridgeOptions {
  /** How long the connection's opening, and each answer, is waited for, in milliseconds: 10 s by default. */
  timeoutMs?: number;
  /** Opens the socket; the global `WebSocket` by default. */
  open?(url: string): WebSocketLike;
}

/** A message of the bridge, as far as the client reads it. */
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

/** A listener to the values the device pushes, and the prefixes it narrows them to. */
interface Listener {
  listener(values: Record<string, Value>): void;
  prefixes: readonly string[] | undefined;
}

const OPEN = 1;

/**
 * A bridge client over the device's open local bridge.
 *
 * A request is answered in the order it was sent, as the bridge answers its
 * messages one at a time; a request with no answer within the timeout, or
 * pending when the connection closes, rejects, and a request with no answer
 * closes the connection as lost: every later answer would be misplaced. The
 * bridge serves one client at a time: another connecting closes this one,
 * which `closed` reports as refused. Values are parsed with `parseExact`.
 */
export class WebSocketBridge implements BridgeClient {
  readonly url: string;
  readonly closed: Promise<BridgeClosure>;

  readonly #socket: WebSocketLike;
  readonly #timeoutMs: number;
  readonly #waiting: Waiting[] = [];
  readonly #listeners = new Set<Listener>();
  #closedWith: string | null = null;
  /** The messages received and not yet handled. */
  readonly #inbox: unknown[] = [];
  #draining = false;
  /** Why this side is closing the connection, once it is. */
  #closing: "closed" | "lost" | null = null;
  #requests = 0;

  /** Connect to the bridge at `url`: the client, once the connection is open. */
  static async connect(
    url: string = LOCAL_BRIDGE_URL,
    options: WebSocketBridgeOptions = {},
  ): Promise<WebSocketBridge> {
    const open = options.open ?? ((at: string) => new WebSocket(at) as unknown as WebSocketLike);
    const socket = open(url);
    const timeoutMs = options.timeoutMs ?? 10_000;
    await new Promise<void>((resolve, reject) => {
      // A device that accepts the connection and never opens it is not answering.
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error(`no device answers at ${url}`));
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
    return new WebSocketBridge(url, socket, timeoutMs);
  }

  private constructor(url: string, socket: WebSocketLike, timeoutMs: number) {
    this.url = url;
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
    let settle: (closure: BridgeClosure) => void = () => {};
    this.closed = new Promise((resolve) => (settle = resolve));
    socket.onmessage = (event) => {
      this.#inbox.push(event.data);
      if (!this.#draining) this.#drain();
    };
    socket.onerror = () => {};
    socket.onclose = (event) => {
      const reason =
        this.#closing === "lost"
          ? `the device at ${url} stopped answering`
          : `the device at ${url} closed the connection${event.reason ? `: ${event.reason}` : ""}`;
      this.#closedWith = reason;
      for (const waiting of this.#waiting.splice(0)) {
        clearTimeout(waiting.timer);
        waiting.reject(new Error(reason));
      }
      // A device that closes the connection saying why ended it on purpose,
      // as the bridge does when another client takes it; one that drops it
      // without a word may be found again.
      const cause = this.#closing ?? (event.reason ? "refused" : "lost");
      settle({ reason, cause });
    };
  }

  async describeMethods(prefix?: string): Promise<MethodSignature[]> {
    const answer = await this.#request(
      { type: "describe_methods", path: prefix },
      "describe_methods_resp",
    );
    return (answer.methods ?? []) as MethodSignature[];
  }

  async call(call: Call): Promise<CallResult> {
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
    return { ret: (answer.ret ?? null) as Value | null, mutated: (answer.mutated ?? []) as unknown[] };
  }

  async readValues(keys: readonly string[]): Promise<Record<string, Value>> {
    const answer = await this.#request({ type: "read_values", keys }, "read_values_resp");
    return (answer.values ?? {}) as Record<string, Value>;
  }

  async writeValues(values: Record<string, Value>): Promise<void> {
    const answer = await this.#request({ type: "write_values", values }, "write_values_resp");
    if (answer.success !== true) {
      throw new Error(
        typeof answer.message === "string" ? answer.message : "the device refused the write",
      );
    }
  }

  async listKeys(prefix?: string): Promise<BridgeKey[]> {
    const answer = await this.#request({ type: "list_keys", path: prefix }, "list_keys_resp");
    return (answer.keys ?? []) as BridgeKey[];
  }

  onValues(
    listener: (values: Record<string, Value>) => void,
    prefixes?: readonly string[],
  ): () => void {
    const entry = { listener, prefixes };
    this.#listeners.add(entry);
    return () => this.#listeners.delete(entry);
  }

  /** Close the connection. The device goes on running its behavior. */
  close() {
    this.#closing ??= "closed";
    this.#socket.close(1000, "closed by the client");
  }

  #request(message: Message, answer: string): Promise<Message> {
    return new Promise((resolve, reject) => {
      if (this.#closedWith !== null || this.#socket.readyState !== OPEN) {
        reject(new Error(this.#closedWith ?? `the connection to ${this.url} is not open`));
        return;
      }
      const timer = setTimeout(() => {
        // The bridge answers in order: one answer missing leaves every later one misplaced.
        this.#closing ??= "lost";
        this.close();
        reject(new Error(`the device at ${this.url} did not answer ${message.type}`));
      }, this.#timeoutMs);
      this.#waiting.push({ answer, resolve, reject, timer });
      this.#socket.send(JSON.stringify(message));
    });
  }

  /**
   * Handle the messages received, in order. What follows an answer waits for
   * a task of its own: whoever awaited the answer goes on first, as the
   * contract of `BridgeClient` says, even where several messages arrive in
   * one task.
   */
  #drain() {
    this.#draining = true;
    while (this.#inbox.length) {
      if (this.#receive(this.#inbox.shift())) {
        setTimeout(() => this.#drain(), 0);
        return;
      }
    }
    this.#draining = false;
  }

  /** Handle one message; `true` when it answered a request. */
  #receive(data: unknown): boolean {
    let message: Message;
    try {
      // A value's integers keep their digits on their way to Rust.
      message = parseExact(String(data)) as Message;
    } catch {
      return false;
    }
    if (message.type === "values_changed") {
      const values = (message.values ?? {}) as Record<string, Value>;
      for (const { listener, prefixes } of [...this.#listeners]) {
        if (!prefixes) {
          listener(values);
          continue;
        }
        const narrowed = Object.fromEntries(
          Object.entries(values).filter(([key]) => prefixes.some((p) => key.startsWith(p))),
        );
        if (Object.keys(narrowed).length) listener(narrowed);
      }
      return false;
    }
    const waiting = this.#waiting.shift();
    if (!waiting) return false;
    clearTimeout(waiting.timer);
    if (message.type === waiting.answer) {
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
    return true;
  }
}
