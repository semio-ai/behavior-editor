/**
 * A device's open local bridge, for tests: a WebSocket server answering as
 * `arora-bridge-ws` does.
 */
import { type WebSocket as Socket, WebSocketServer } from "ws";
import type { Value } from "../src/model/value";
import { DATAFLOW_FUNCTIONS } from "./local-arora";

export type Message = Record<string, unknown> & { type: string };

/**
 * A device's open local bridge, as `arora-bridge-ws` serves it: the device's
 * keys with their meta and values, its methods, the calls and writes it is
 * sent, and its steps, each pushing what it changed with the clock.
 */
export class FakeBridge {
  readonly server: WebSocketServer;
  socket: Socket | null = null;
  keys: { path: string; __meta: Record<string, unknown> }[] = [
    { path: "arora/time", __meta: { ty: "u64" } },
    { path: "sensor/distance", __meta: { ty: "f32", editable: true, min: 0, max: 2 } },
  ];
  values: Record<string, Value> = { "arora/time": { u64: 0 }, "sensor/distance": { f32: 0.5 } };
  received: Message[] = [];
  /** How the device answers a message: as the bridge does, unless a test says otherwise. */
  answer: (message: Message) => Message | null = (message) => this.#answer(message);
  /** The answer the bridge itself gives. */
  answerAsBridge = (message: Message) => this.#answer(message);
  /** What a call answers. */
  callResult: Record<string, unknown> = { success: true, ret: { str: "run" }, mutated: [] };
  /** What a write answers. */
  writeResult: Record<string, unknown> = { success: true };
  #time = 0;

  constructor() {
    this.server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    this.server.on("connection", (socket) => {
      // The bridge serves one client: the one connecting takes it.
      this.socket?.close(1000, "Another client connected");
      this.socket = socket;
      socket.on("message", (data: Buffer) => {
        const message = JSON.parse(data.toString()) as Message;
        this.received.push(message);
        const answer = this.answer(message);
        if (answer) socket.send(JSON.stringify(answer));
      });
    });
  }

  async url() {
    await new Promise<void>((resolve) => {
      if (this.server.address()) resolve();
      else this.server.once("listening", () => resolve());
    });
    const address = this.server.address() as { port: number };
    return `ws://127.0.0.1:${address.port}`;
  }

  /** Push `values` as a step's changes, unsolicited. */
  push(values: Record<string, Value>) {
    Object.assign(this.values, values);
    for (const path of Object.keys(values)) {
      if (!this.keys.some((k) => k.path === path)) this.keys.push({ path, __meta: {} });
    }
    this.socket!.send(JSON.stringify({ type: "values_changed", values }));
  }

  /** A step of the device: its clock moves, and `values` change with it. */
  step(values: Record<string, Value> = {}) {
    this.#time += 10_000_000;
    this.push({ "arora/time": { u64: this.#time }, ...values });
  }

  #answer(message: Message): Message | null {
    switch (message.type) {
      case "list_keys":
        return { type: "list_keys_resp", keys: this.keys };
      case "read_values":
        return {
          type: "read_values_resp",
          values: Object.fromEntries(
            (message.keys as string[])
              .filter((k) => Object.hasOwn(this.values, k))
              .map((k) => [k, this.values[k]]),
          ),
        };
      case "describe_methods":
        return {
          type: "describe_methods_resp",
          methods: DATAFLOW_FUNCTIONS.filter((m) => !message.path || m.name.startsWith(message.path as string)),
        };
      case "call":
        return { request_id: message.request_id, ...this.callResult, type: "call_resp" };
      case "write_values":
        return { ...this.writeResult, type: "write_values_resp" };
      default:
        return { type: "error", message: `unknown message ${message.type}` };
    }
  }

  close() {
    return new Promise((resolve) => this.server.close(resolve));
  }
}

