/**
 * A device for tests, reached through bridge clients held in memory: its
 * store, its behavior interpreter, and its steps, each pushing what it
 * changed to the clients connected. Independent of any transport.
 *
 * Its interpreter takes the calls `FAKE_CALLS` writes, the graph or the diff
 * in plain JSON beside the call, so it reads them without decoding Arora's
 * `Value`: it loads, edits and reads its behavior, keeps its revision in
 * `arora/behavior/revision`, and traces it.
 */
import type {
  BridgeClient,
  BridgeClosure,
  BridgeKey,
  Call,
  CallResult,
} from "../src/bridge/bridge-client";
import { type Graph, type GraphDiff, applyDiff } from "../src/model/graph";
import type { MethodSignature } from "../src/model/signature";
import type { Value } from "../src/model/value";
import { mathModule } from "../src/runtime/math-module";
import type { TraceReport, TraceStatus } from "../src/runtime/trace";
import { DT_KEY, REVISION_KEY, type SessionLanguage } from "../src/session/device-session";

const MODULE = "interpreter";

const ret = (value: unknown): CallResult => ({ ret: { str: JSON.stringify(value) }, mutated: [] });
const unpack = <T>(result: string) =>
  JSON.parse((JSON.parse(result) as { ret: { str: string } }).ret.str) as T;

/** The interpreter's calls as the fake device reads them. */
export const FAKE_CALLS: SessionLanguage = {
  loadCall: (graph: Graph) => JSON.stringify({ module_id: MODULE, id: "load", args: [], graph }),
  editCall: (diff: GraphDiff) => JSON.stringify({ module_id: MODULE, id: "edit", args: [], diff }),
  traceCall: (options) =>
    JSON.stringify({ module_id: MODULE, id: "trace", args: [], values: options.values ?? [] }),
  traceHandle: (resultJson: string) => unpack(resultJson),
  traceReport: (valueJson: string) =>
    JSON.parse((JSON.parse(valueJson) as { str: string }).str) as TraceReport,
  readCall: () => JSON.stringify({ module_id: MODULE, id: "read", args: [] }),
  readResult: (resultJson: string) => unpack(resultJson),
};

/** `FAKE_CALLS` without the read: a language built before interpreters had one. */
export const FAKE_CALLS_WITHOUT_READ: SessionLanguage = {
  loadCall: FAKE_CALLS.loadCall,
  editCall: FAKE_CALLS.editCall,
  traceCall: FAKE_CALLS.traceCall,
  traceHandle: FAKE_CALLS.traceHandle,
  traceReport: FAKE_CALLS.traceReport,
};

/** A trace the device runs: where it reports, and the tick of its last report. */
interface Trace {
  feedback: string;
  last: number | null;
}

/** The step the device's clock takes, in nanoseconds: 50 steps a second. */
const DT_NS = 20_000_000;

export class FakeDevice {
  graph: Graph;
  revision: number;
  /** Whether its interpreter answers a read; one that does not refuses the call. */
  reads = true;
  /** Whether its interpreter keeps a revision key. */
  revises = true;
  /** Whether a connection can be opened to it now. */
  reachable = true;
  /** Each node's status, as the next trace report states it. */
  statuses: Record<string, TraceStatus> = {};
  /** The interpreter's tick. */
  tick = 0;
  readonly values: Record<string, Value> = {
    "arora/time": { u64: 0 },
    [DT_KEY]: { u64: DT_NS },
    "sensor/distance": { f32: 0.5 },
  };
  readonly meta: Record<string, BridgeKey["__meta"]> = {
    "arora/time": { ty: "u64" },
    [DT_KEY]: { ty: "u64" },
    "sensor/distance": { ty: "f32", editable: true, min: 0, max: 2 },
  };
  /** Every call its interpreter was sent, from any client. */
  readonly calls: Call[] = [];
  readonly traces = new Map<string, Trace>();
  readonly clients = new Set<FakeBridgeClient>();
  /** Called with each connection as it opens. */
  connected?: (client: FakeBridgeClient) => void;
  #runs = 0;
  #shown: number | null = null;
  #reported: Record<string, TraceStatus> = {};

  constructor({ graph = {}, revision = 1 }: { graph?: Graph; revision?: number } = {}) {
    this.graph = graph;
    this.revision = revision;
    this.#show();
  }

  /** A connection to the device, as a transport opens one; refused while it is not reachable. */
  async connect(): Promise<FakeBridgeClient> {
    await Promise.resolve();
    if (!this.reachable) throw new Error("no device answers at fake://device");
    const client = new FakeBridgeClient(this);
    this.clients.add(client);
    this.connected?.(client);
    return client;
  }

  /** A change another client makes: `graph` loaded, the revision moved on. */
  loadedByAnother(graph: Graph) {
    this.graph = graph;
    this.revision += 1;
  }

  /** A step: the clock, the revision when it changed, and each trace's report, pushed. */
  step(values: Record<string, Value> = {}) {
    this.tick += 1;
    const pushed: Record<string, Value> = {
      "arora/time": { u64: this.tick * DT_NS },
      [DT_KEY]: { u64: DT_NS },
      ...values,
    };
    if (this.revises && this.#shown !== this.revision) {
      this.#shown = this.revision;
      pushed[REVISION_KEY] = { u64: this.revision };
    }
    const changed = Object.entries(this.statuses).filter(([n, s]) => this.#reported[n] !== s);
    for (const trace of this.traces.values()) {
      if (trace.last !== null && !changed.length) continue;
      const report: TraceReport =
        trace.last === null
          ? { tick: this.tick, status: Object.entries(this.statuses) }
          : { tick: this.tick, since: trace.last, status: changed };
      trace.last = this.tick;
      pushed[trace.feedback] = { str: JSON.stringify(report) };
    }
    this.#reported = { ...this.statuses };
    Object.assign(this.values, pushed);
    for (const client of this.clients) client.push(pushed);
  }

  /** The device's interpreter answering `call`. */
  call(call: Call & Record<string, unknown>): CallResult {
    this.calls.push(call);
    switch (call.id) {
      case "load":
        this.graph = call.graph as Graph;
        this.revision += 1;
        return ret(null);
      case "edit":
        this.graph = applyDiff(this.graph, call.diff as GraphDiff);
        this.revision += 1;
        return ret(null);
      case "read":
        if (!this.reads) throw new Error("no such function: read");
        return ret({ graph: this.graph, revision: this.revision });
      case "trace": {
        this.#runs += 1;
        const run = String(this.#runs);
        const feedback = `arora/tasks/${MODULE}/trace/${run}/feedback`;
        this.traces.set(run, { feedback, last: null });
        return ret({
          id: run,
          stop: { module_id: MODULE, id: "halt", args: [], run },
          status: `arora/tasks/${MODULE}/trace/${run}/status`,
          feedback: [feedback],
        });
      }
      case "halt":
        this.traces.delete(call.run as string);
        return ret(null);
      default:
        throw new Error(`no such function: ${call.id}`);
    }
  }

  /** The revision as the store holds it from the start. */
  #show() {
    if (!this.revises) return;
    this.#shown = this.revision;
    this.values[REVISION_KEY] = { u64: this.revision };
    this.meta[REVISION_KEY] = { ty: "u64" };
  }
}

/** One connection to a `FakeDevice`. */
export class FakeBridgeClient implements BridgeClient {
  readonly closed: Promise<BridgeClosure>;
  readonly #device: FakeDevice;
  readonly #listeners = new Set<(values: Record<string, Value>) => void>();
  #end: (closure: BridgeClosure) => void = () => {};
  #over: string | null = null;

  constructor(device: FakeDevice) {
    this.#device = device;
    this.closed = new Promise((resolve) => (this.#end = resolve));
  }

  /** The connection ends as `cause` says: the device dropped it, refused it, or this side closed it. */
  end(cause: BridgeClosure["cause"], reason = `the fake device ${cause} the connection`) {
    if (this.#over !== null) return;
    this.#over = reason;
    this.#device.clients.delete(this);
    this.#end({ reason, cause });
  }

  push(values: Record<string, Value>) {
    if (this.#over === null) for (const listener of this.#listeners) listener(values);
  }

  describeMethods(prefix?: string): Promise<MethodSignature[]> {
    return this.#answer(() =>
      mathModule()
        .functions.map((f) => f.signature)
        .filter((m) => !prefix || m.name.startsWith(prefix)),
    );
  }

  call(call: Call): Promise<CallResult> {
    return this.#answer(() => this.#device.call(call as Call & Record<string, unknown>));
  }

  readValues(keys: readonly string[]): Promise<Record<string, Value>> {
    return this.#answer(() =>
      Object.fromEntries(
        keys.filter((k) => Object.hasOwn(this.#device.values, k)).map((k) => [k, this.#device.values[k]!]),
      ),
    );
  }

  writeValues(values: Record<string, Value>): Promise<void> {
    return this.#answer(() => {
      const closed = Object.keys(values).filter((k) => !this.#device.meta[k]?.editable);
      if (closed.length) throw new Error(`closed to clients: ${closed.join(", ")}`);
      Object.assign(this.#device.values, values);
    });
  }

  listKeys(prefix?: string): Promise<BridgeKey[]> {
    return this.#answer(() =>
      Object.keys(this.#device.values)
        .filter((path) => !prefix || path.startsWith(prefix))
        .map((path) => ({ path, __meta: this.#device.meta[path] ?? {} })),
    );
  }

  onValues(listener: (values: Record<string, Value>) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  close() {
    this.end("closed", "closed by the client");
  }

  /** Answer as a transport does, a task later; refused once the connection ended. */
  #answer<T>(answer: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) =>
      setTimeout(() => {
        if (this.#over !== null) reject(new Error(this.#over));
        else {
          try {
            resolve(answer());
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
      }, 0),
    );
  }
}
