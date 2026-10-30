import { afterEach, describe, expect, it } from "vitest";
import { type WebSocket as Socket, WebSocketServer } from "ws";
import { ORDER } from "../../fixtures/examples";
import type { Value } from "../model/value";
import { DeviceRuntime } from "./device-runtime";
import { MATH, mathModule } from "./math-module";
import type { TraceReport } from "./trace";
import { WebSocketDevice } from "./websocket-device";

type Message = Record<string, unknown> & { type: string };

/**
 * A device's open local bridge, as `arora-bridge-ws` serves it: the device's
 * keys with their meta and values, its methods, the calls and writes it is
 * sent, and its steps, each pushing what it changed with the clock.
 */
class FakeBridge {
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
              .filter((k) => k in this.values)
              .map((k) => [k, this.values[k]]),
          ),
        };
      case "describe_methods":
        return {
          type: "describe_methods_resp",
          methods: mathModule()
            .functions.map((f) => f.signature)
            .filter((m) => !message.path || m.name.startsWith(message.path as string)),
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

const bridges: FakeBridge[] = [];
const devices: WebSocketDevice[] = [];
afterEach(async () => {
  for (const device of devices.splice(0)) device.close();
  for (const bridge of bridges.splice(0)) await bridge.close();
});

async function connect(timeoutMs?: number) {
  const bridge = new FakeBridge();
  bridges.push(bridge);
  const device = await WebSocketDevice.connect(await bridge.url(), { timeoutMs });
  devices.push(device);
  return { bridge, device };
}

describe("WebSocketDevice", () => {
  it("reads the device's keys and their values as it connects", async () => {
    const { bridge, device } = await connect();
    expect(bridge.received.map((m) => m.type)).toEqual(["list_keys", "read_values"]);
    expect(JSON.parse(await device.read("sensor/distance"))).toEqual({ f32: 0.5 });
    expect(JSON.parse(await device.read("face/none"))).toBeNull();
    expect(JSON.parse(await device.listKeys())).toEqual([
      ["arora/time", { ty: "u64" }],
      ["sensor/distance", { ty: "f32", editable: true, min: 0, max: 2 }],
    ]);
  });

  it("describes the device's methods, under a prefix", async () => {
    const { bridge, device } = await connect();
    const methods = JSON.parse(await device.describeMethods("ad")) as {
      name: string;
      id: string;
    }[];
    expect(bridge.received.at(-1)).toEqual({ type: "describe_methods", path: "ad" });
    expect(methods.map((m) => [m.name, m.id])).toEqual([["add", MATH.add.id]]);
  });

  it("calls a function by ids, and rejects with the device's reason", async () => {
    const { bridge, device } = await connect();
    const call = { module_id: "m", id: "f", args: [{ id: "x", value: { f64: 2 } }] };
    expect(JSON.parse(await device.call(JSON.stringify(call)))).toEqual({
      ret: { str: "run" },
      mutated: [],
    });
    expect(bridge.received.at(-1)).toEqual({ ...call, type: "call", request_id: "call-1" });
    bridge.callResult = { success: false, message: "call failed: unknown function" };
    await expect(device.call(JSON.stringify(call))).rejects.toThrow(
      "call failed: unknown function",
    );
  });

  it("writes values, rejects a refused write, and unsets nothing", async () => {
    const { bridge, device } = await connect();
    await device.update(JSON.stringify({ "sensor/distance": { f32: 1 } }));
    expect(bridge.received.at(-1)).toEqual({
      type: "write_values",
      values: { "sensor/distance": { f32: 1 } },
    });
    bridge.writeResult = { success: false, message: "face/smile is not open to writes" };
    await expect(device.update(JSON.stringify({ "face/smile": { f32: 1 } }))).rejects.toThrow(
      "face/smile is not open to writes",
    );
    await expect(device.update(JSON.stringify({ "sensor/distance": null }))).rejects.toThrow(
      /unsets no key: sensor\/distance/,
    );
  });

  it("follows the device's steps: a step answers at the next push carrying its clock", async () => {
    const { bridge, device } = await connect();
    let stepped = false;
    const step = Promise.resolve(device.step(5_000)).then(() => (stepped = true));
    bridge.push({ "face/smile": { f64: 0.2 } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stepped).toBe(false);
    bridge.step({ "face/smile": { f64: 0.4 } });
    await step;
    expect(JSON.parse(await device.read("face/smile"))).toEqual({ f64: 0.4 });
  });

  it("answers a step after its time when the device does not step", async () => {
    const { device } = await connect();
    const started = Date.now();
    await device.step(40);
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  });

  it("rejects a request the device answers with an error, and keeps the order of the next", async () => {
    const { bridge, device } = await connect();
    const answer = bridge.answer;
    bridge.answer = (m) =>
      m.type === "describe_methods"
        ? { type: "error", message: "Invalid message format" }
        : answer(m);
    const refused = device.describeMethods();
    const listed = device.listKeys();
    await expect(refused).rejects.toThrow("Invalid message format");
    expect(JSON.parse(await listed)).toHaveLength(2);
  });

  it("closes when an answer does not come, rejecting what waits", async () => {
    const { bridge, device } = await connect(100);
    const answer = bridge.answer;
    bridge.answer = (m) => (m.type === "describe_methods" ? null : answer(m));
    await expect(device.describeMethods()).rejects.toThrow("did not answer describe_methods");
    expect(await device.closed).toMatch(/closed the connection/);
    await expect(device.listKeys()).rejects.toThrow(/closed the connection/);
  });

  it("says why the connection closed, rejecting what waits", async () => {
    const { bridge, device } = await connect();
    bridge.answer = () => null;
    const waiting = device.listKeys();
    bridge.socket!.close(1000, "Another client connected");
    await expect(waiting).rejects.toThrow(/closed the connection: Another client connected/);
    expect(await device.closed).toMatch(/Another client connected/);
    expect(() => device.read("x")).toThrow(/Another client connected/);
  });

  it("closes the connection when the device's store cannot be read as it connects", async () => {
    const bridge = new FakeBridge();
    bridges.push(bridge);
    bridge.answer = (m) =>
      m.type === "read_values"
        ? { type: "error", message: "store unavailable" }
        : bridge.answerAsBridge(m);
    const closed = new Promise((resolve) =>
      bridge.server.once("connection", (socket) => socket.once("close", resolve)),
    );
    await expect(WebSocketDevice.connect(await bridge.url())).rejects.toThrow("store unavailable");
    await closed;
  });

  it("refuses to connect where no device answers", async () => {
    const bridge = new FakeBridge();
    const url = await bridge.url();
    await bridge.close();
    await expect(WebSocketDevice.connect(url)).rejects.toThrow(`no device answers at ${url}`);
  });

  it("runs a behavior through DeviceRuntime, on the device's own clock", async () => {
    const { bridge, device } = await connect();
    const runtime = new DeviceRuntime({
      device,
      loadCall: () => JSON.stringify({ module_id: "interpreter", id: "load", args: [] }),
      editCall: () => JSON.stringify({ module_id: "interpreter", id: "edit", args: [] }),
    });
    expect((await runtime.functions()).map((f) => f.name)).toContain("damp");
    await runtime.start(ORDER.loaded);
    expect(bridge.received.find((m) => m.type === "call")).toMatchObject({ id: "load" });
    const report = runtime.step(5_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    bridge.step({ v: { f64: 1 } });
    expect((await report).changes).toEqual([
      { key: "arora/time", value: { u64: 10_000_000 } },
      { key: "v", value: { f64: 1 } },
    ]);
    expect(await runtime.keys()).toContainEqual({
      key: "sensor/distance",
      editable: true,
      ty: "f32",
      min: 0,
      max: 2,
    });
    await runtime.write("sensor/distance", { f32: 1.5 });
    expect(bridge.received.at(-1)).toMatchObject({ type: "write_values" });
  });

  it("keeps every value a key was pushed since it last took them", async () => {
    const { bridge, device } = await connect();
    expect(JSON.parse(await device.takeValues("sensor/distance"))).toEqual([{ f32: 0.5 }]);
    bridge.push({ "sensor/distance": { f32: 0.6 } });
    bridge.step({ "sensor/distance": { f32: 0.7 } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(JSON.parse(await device.takeValues("sensor/distance"))).toEqual([
      { f32: 0.6 },
      { f32: 0.7 },
    ]);
    expect(JSON.parse(await device.takeValues("sensor/distance"))).toEqual([]);
  });

  it("follows every report a trace writes between two of the editor's steps", async () => {
    const { bridge, device } = await connect();
    bridge.callResult = { success: true, ret: { u64: 1 }, mutated: [] };
    const root = ORDER.loaded.graph.root!;
    const runtime = new DeviceRuntime({
      device,
      loadCall: () => JSON.stringify({ module_id: "interpreter", id: "load", args: [] }),
      editCall: () => JSON.stringify({ module_id: "interpreter", id: "edit", args: [] }),
      trace: {
        traceCall: () => JSON.stringify({ module_id: "interpreter", id: "trace", args: [] }),
        traceHandle: () => ({ id: "t", stop: {}, status: "t/status", feedback: ["t/feedback"] }),
        traceReport: (json) => JSON.parse(json) as TraceReport,
      },
    });
    await runtime.start(ORDER.loaded);
    // The device ticks twice before the editor looks: two reports, each a change of the one before.
    bridge.step({ "t/feedback": { tick: 1, status: [[root, "running"]] } as unknown as Value });
    bridge.step({
      "t/feedback": { tick: 2, since: 1, status: [[root, "success"]] } as unknown as Value,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const report = runtime.step(5_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    bridge.step();
    expect((await report).root).toBe("S");
    expect(bridge.received.filter((m) => m.id === "trace")).toHaveLength(1);
  });
});
