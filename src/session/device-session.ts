/**
 * A client's session with an Arora device: the connection, kept or found
 * again; the behavior the device runs, read and followed; and the changes the
 * client makes to it. Headless: an editor, a dashboard or a test drives it the
 * same way.
 */
import type { GraphDiff, Graph } from "../model/graph";
import type { MethodSignature } from "../model/signature";
import { type Value, valueNumber } from "../model/value";
import type { BridgeClient, BridgeClosure } from "../bridge/bridge-client";
import { BridgeDevice } from "../bridge/bridge-device";
import { DeviceRuntime, type FollowedBehavior, followed } from "../runtime/device-runtime";
import { TIME_KEY } from "../runtime/mock-arora";
import type { KeyInfo, TickReport } from "../runtime/runtime";
import type { BehaviorText, Loaded } from "../text/language";

/**
 * The revision of the behavior a device runs, a `u64` its interpreter
 * increases at each load and each edit it accepts: `arora-behavior`'s
 * `built_in::BEHAVIOR_REVISION`.
 */
export const REVISION_KEY = "arora/behavior/revision";

/** The nanoseconds the device's last step took: `arora-behavior`'s `built_in::DT`. */
export const DT_KEY = "arora/dt";

/** Where a session's connection stands. */
export type SessionState =
  /** Connecting for the first time. */
  | { status: "connecting" }
  | { status: "connected" }
  /** The connection dropped: the session connects again at `retryAt` (`Date.now()`'s clock). */
  | { status: "lost"; reason: string; retryAt: number }
  /**
   * Over. `reason` is `null` when the client closed it; `refused` says the
   * device ended it on purpose, as when another client took its one
   * connection, rather than not answering.
   */
  | { status: "closed"; reason: string | null; refused: boolean };

/** The behavior a device runs, as it answers a read of it. */
export interface DeviceBehavior {
  graph: Graph;
  /** Its revision: see `REVISION_KEY`. */
  revision: number;
}

/** What the device's clock and interpreter say, as of the session's last step. */
export interface DeviceStatus {
  /**
   * The interpreter's tick: the tick of the trace's last report, counted on
   * with each of the device's steps since. `null` while no trace reported.
   */
  tick: number | null;
  /** The device's clock, `arora/time`, in seconds. */
  time: number | null;
  /** The device's steps per second, from its last step's `arora/dt`. */
  rate: number | null;
  /** The behavior's revision; `null` on a device that keeps none. */
  revision: number | null;
}

/** One step of the session following the device. */
export interface SessionTick {
  /** What changed, and the nodes as the trace leaves them. */
  report: TickReport;
  status: DeviceStatus;
  /** The device's keys, each with what a person may do with it. */
  keys: KeyInfo[];
}

/** A change of the behavior the device runs. */
export interface BehaviorChange {
  revision: number;
  /**
   * Whether this session did not make it: another client did, or it was made
   * while the connection was lost.
   */
  external: boolean;
}

/** What a session tells the ones following it. */
export interface SessionEvents {
  state: SessionState;
  behaviorChanged: BehaviorChange;
  tick: SessionTick;
  /** Following the device failed at a step: it goes on at the next. */
  error: Error;
}

/** How a session waits before connecting again after a loss: doubling from `firstMs` up to `maxMs`. */
export interface Backoff {
  firstMs?: number;
  maxMs?: number;
}

/** The language's calls a session makes on the device's interpreter. */
export type SessionLanguage = Pick<
  BehaviorText,
  "loadCall" | "editCall" | "traceCall" | "traceHandle" | "traceReport" | "readCall" | "readResult"
>;

export interface DeviceSessionOptions {
  language: SessionLanguage;
  /** How many times a second the session follows the device: 30 by default. */
  rate?: number;
  /**
   * Whether to connect again when the connection drops, and how long to wait
   * between attempts: 0.5 s doubling up to 10 s by default. Only a session
   * given a way to connect can: see the constructor.
   */
  reconnect?: boolean | Backoff;
  /** What the session is connected to, in words, for a host to show: a URL, a device's name. */
  label?: string;
}

/** A connection the session holds: the bridge client, the device behind it, and the runtime following it. */
interface Connection {
  client: BridgeClient;
  device: BridgeDevice;
  runtime: DeviceRuntime;
}

/**
 * The behavior `read` says the device runs, as the session follows it: its
 * root and nodes, the detached ones' outputs watched. Nothing when the
 * device did not say.
 */
function deviceFollowed(read: DeviceBehavior | null): FollowedBehavior {
  const nodes = read?.graph.nodes ?? [];
  const held = new Set(nodes.flatMap((n) => n.children ?? []));
  return {
    ...(read?.graph.root === undefined ? {} : { root: read.graph.root }),
    nodes: nodes.map((n) => n.id),
    watched: nodes.filter((n) => n.id !== read?.graph.root && !held.has(n.id)).map((n) => n.id),
  };
}

/** Close `client`, settling once it is closed. */
async function shut(client: BridgeClient) {
  client.close();
  await client.closed;
}

const FIRST_MS = 500;
const MAX_MS = 10_000;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * A session with an Arora device.
 *
 * Connecting attaches without changing what the device runs: the session
 * follows it, step by step, at its `rate`, telling `tick` what changed, the
 * nodes as a trace reports them, and the device's tick, clock, step rate and
 * behavior revision. `deviceBehavior` reads the behavior the device runs. The
 * session changes it only when asked: `run` loads a behavior, `edit` applies
 * a diff to it, `stop` loads the empty one. Closing the session, or losing
 * the connection, leaves the device running whatever it runs.
 *
 * A device keeping a behavior revision tells the session of every change of
 * its behavior; `behaviorChanged` says whether this session made it.
 *
 * Every operation on the device waits for the one before it, the steps the
 * session takes to follow it among them.
 */
export class DeviceSession {
  /** What the session is connected to, in words, when its host said. */
  readonly label: string | undefined;

  readonly #connect: () => Promise<BridgeClient>;
  readonly #options: DeviceSessionOptions;
  readonly #backoff: Required<Backoff> | null;
  #state: SessionState;
  #connection: Connection | null = null;
  #listeners: { [K in keyof SessionEvents]: Set<(event: SessionEvents[K]) => void> } = {
    state: new Set(),
    behaviorChanged: new Set(),
    tick: new Set(),
    error: new Set(),
  };
  #queue: Promise<unknown> = Promise.resolve();
  /** Whether the client closed the session. */
  #closing = false;
  #closed: Promise<void> | null = null;
  /** Settles once the session connects no more: an attempt under way has ended, its connection closed. */
  #ended: Promise<void>;
  /** Wakes a wait for the next attempt to connect, when the session closes. */
  #wake: (() => void) | null = null;
  #revision: number | null = null;
  /** The changes this session made or is making whose revision the device has not shown yet. */
  #own = 0;
  #status: DeviceStatus = { tick: null, time: null, rate: null, revision: null };
  /** The trace tick the device's tick was last set from. */
  #traced: number | null = null;
  /**
   * What the session follows: a behavior its client said, or `null` for the
   * one the device runs, read anew as it changes.
   */
  #followed: FollowedBehavior | null = null;
  /** The stop calls of the traces a lost connection left running. */
  #orphans: string[] = [];
  #functions: Promise<MethodSignature[]> | null = null;

  /**
   * A session over `bridge`, a connection to a device; or over the
   * connection `bridge()` opens, each time the session connects: after a
   * loss, it connects again with it unless `reconnect` is `false`. The
   * session owns what it is given: closing it closes the connection.
   */
  constructor(
    bridge: BridgeClient | (() => Promise<BridgeClient>),
    options: DeviceSessionOptions,
  ) {
    this.#options = options;
    this.label = options.label;
    const connects = typeof bridge === "function";
    this.#connect = connects ? bridge : () => Promise.resolve(bridge);
    const reconnect = connects ? (options.reconnect ?? true) : false;
    this.#backoff = reconnect
      ? {
          firstMs: (reconnect === true ? undefined : reconnect.firstMs) ?? FIRST_MS,
          maxMs: (reconnect === true ? undefined : reconnect.maxMs) ?? MAX_MS,
        }
      : null;
    this.#state = { status: "connecting" };
    this.#ended = this.#run();
  }

  get state(): SessionState {
    return this.#state;
  }

  /** The device's tick, clock, step rate and revision, as of the last step. */
  get status(): DeviceStatus {
    return this.#status;
  }

  /** Listen to `type`; the function returned stops listening. */
  on<K extends keyof SessionEvents>(
    type: K,
    listener: (event: SessionEvents[K]) => void,
  ): () => void {
    const listeners = this.#listeners[type] as Set<(event: SessionEvents[K]) => void>;
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** The module functions the device offers. */
  functions(): Promise<MethodSignature[]> {
    this.#functions ??= this.#enqueue(({ runtime }) => runtime.functions()).catch(
      (error: unknown) => {
        this.#functions = null;
        throw error;
      },
    );
    return this.#functions;
  }

  /**
   * The behavior the device runs, and its revision; `null` when the device
   * does not answer for it: its interpreter has no read, or the language
   * cannot ask.
   */
  deviceBehavior(): Promise<DeviceBehavior | null> {
    return this.#enqueue((connection) => this.#read(connection));
  }

  /**
   * Follow `behavior` as the one the device runs: the trace watches its
   * nodes, and the reports state them. `null`, as a session starts, follows
   * the behavior the device answers it runs, its detached nodes' outputs
   * watched, and follows it anew at each change; a device that does not
   * answer is followed by its clock and store alone.
   */
  follow(behavior: FollowedBehavior | Loaded | null): Promise<void> {
    const next = behavior && "graph" in behavior ? followed(behavior) : behavior;
    this.#followed = next;
    // Without a connection, the next one follows it.
    if (!this.#connection) return Promise.resolve();
    return this.#enqueue((connection) => this.#followOn(connection));
  }

  /** Follow what the session follows, on `connection`. */
  async #followOn(connection: Connection, read?: DeviceBehavior | null) {
    const behavior =
      this.#followed ??
      deviceFollowed(read === undefined ? await this.#read(connection) : read);
    await connection.runtime.follow(behavior);
  }

  /** Load `loaded` as the device's behavior, every node starting afresh, and follow it. */
  run(loaded: Loaded): Promise<void> {
    return this.#change(async ({ runtime }) => {
      await runtime.start(loaded);
      this.#followed = followed(loaded);
    });
  }

  /**
   * Apply `diff` to the behavior the device runs: the nodes it sets or binds
   * restart, and every other keeps its state. `next` is the behavior it makes,
   * whose nodes the session follows from then on.
   */
  edit(diff: GraphDiff, next?: Loaded): Promise<void> {
    const empty =
      !diff.remove?.length &&
      !diff.set?.length &&
      !diff.unbind?.length &&
      !diff.bind?.length &&
      diff.root === undefined;
    const apply = async ({ runtime }: Connection) => {
      await runtime.edit(diff, next);
      if (next) this.#followed = followed(next);
    };
    return empty ? this.#enqueue(apply) : this.#change(apply);
  }

  /** Stop the device's behavior: load the empty one. */
  stop(): Promise<void> {
    return this.#change(async (connection) => {
      await connection.runtime.stop();
      this.#followed = null;
      await this.#followOn(connection, { graph: {}, revision: 0 });
    });
  }

  /** Write a key of the device, applied at its next step. */
  write(key: string, value: Value | null): Promise<void> {
    return this.#enqueue(({ runtime }) => runtime.write(key, value));
  }

  read(key: string): Promise<Value | null> {
    return this.#enqueue(({ runtime }) => runtime.read(key));
  }

  /**
   * End the session: its trace halted, the connection closed. The device goes
   * on running its behavior. Settles once the connection is closed, and an
   * attempt to connect under way has ended and closed its own: a bridge
   * serving one client would otherwise give it the next session's place.
   */
  close(): Promise<void> {
    if (this.#closed) return this.#closed;
    this.#closing = true;
    this.#wake?.();
    const connection = this.#connection;
    this.#connection = null;
    this.#setState({ status: "closed", reason: null, refused: false });
    const released = connection
      ? this.#queue
          .then(() => connection.runtime.release())
          .catch(() => undefined)
          .then(() => shut(connection.client))
      : Promise.resolve();
    this.#closed = Promise.all([released, this.#ended]).then(() => undefined);
    return this.#closed;
  }

  /** Connect, follow the device while connected, and connect again after a loss. */
  async #run() {
    let attempts = 0;
    let connectedOnce = false;
    while (!this.#closing) {
      let client: BridgeClient;
      try {
        client = await this.#connect();
      } catch (error) {
        if (this.#closing) return;
        if (!connectedOnce || !this.#backoff) {
          this.#setState({ status: "closed", reason: message(error), refused: false });
          return;
        }
        attempts += 1;
        await this.#waitToRetry(message(error), attempts);
        continue;
      }
      if (this.#closing) {
        await shut(client);
        return;
      }
      let connection: Connection;
      try {
        const device = await BridgeDevice.over(client);
        connection = {
          client,
          device,
          runtime: new DeviceRuntime({
            device,
            loadCall: (graph) => this.#options.language.loadCall(graph),
            editCall: (diff) => this.#options.language.editCall(diff),
            trace: this.#options.language,
          }),
        };
        await this.#attach(connection);
      } catch (error) {
        await shut(client);
        if (this.#closing) return;
        if (!this.#backoff) {
          this.#setState({ status: "closed", reason: message(error), refused: false });
          return;
        }
        attempts += 1;
        await this.#waitToRetry(message(error), attempts);
        continue;
      }
      if (this.#closing) {
        await connection.runtime.release().catch(() => undefined);
        await shut(client);
        return;
      }
      connectedOnce = true;
      attempts = 0;
      this.#connection = connection;
      this.#setState({ status: "connected" });
      const closure = await Promise.race([client.closed, this.#follow(connection)]);
      if (this.#connection === connection) this.#connection = null;
      if (this.#closing) return;
      // The trace this connection followed runs on: the next one halts it.
      const stop = connection.runtime.traceStop;
      if (stop) this.#orphans.push(stop);
      if (closure.cause === "refused" || !this.#backoff) {
        this.#setState({
          status: "closed",
          reason: closure.reason,
          refused: closure.cause === "refused",
        });
        return;
      }
      attempts += 1;
      await this.#waitToRetry(closure.reason, attempts);
    }
  }

  /** Wait before the next attempt, the session lost meanwhile; the session closing ends the wait. */
  async #waitToRetry(reason: string, attempts: number) {
    const { firstMs, maxMs } = this.#backoff!;
    const delay = Math.min(maxMs, firstMs * 2 ** (attempts - 1));
    this.#setState({ status: "lost", reason, retryAt: Date.now() + delay });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      this.#wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
    this.#wake = null;
  }

  /**
   * Take up the device on a new connection: halt the traces a lost one left,
   * read the revision, and follow what the session followed. A revision that
   * moved while the connection was lost is another's change.
   */
  async #attach(connection: Connection) {
    const { device, runtime } = connection;
    for (const stop of this.#orphans.splice(0)) {
      try {
        await device.call(stop);
      } catch {
        // The trace ended with the device, or with its behavior.
      }
    }
    this.#own = 0;
    this.#traced = null;
    this.#status = { tick: null, time: null, rate: null, revision: null };
    this.#functions = null;
    const read = await this.#read(connection);
    const revision = read?.revision ?? (await this.#readRevision(runtime));
    if (revision !== null) {
      const known = this.#revision;
      this.#revision = revision;
      this.#status = { ...this.#status, revision };
      if (known !== null && known !== revision) {
        this.#emit("behaviorChanged", { revision, external: true });
      }
    }
    await this.#followOn(connection, read);
  }

  /**
   * Follow the device at the session's rate until the connection is let go
   * of, or drops: a step that fails as the connection closes ends it.
   */
  async #follow(connection: Connection): Promise<BridgeClosure> {
    const period = 1000 / (this.#options.rate ?? 30);
    while (this.#connection === connection) {
      const started = Date.now();
      try {
        await this.#enqueue((at) => this.#step(at), connection);
      } catch (error) {
        // A step fails as the connection closes: the closure, which comes
        // with it, ends the loop rather than the failure being reported.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (this.#connection !== connection) break;
        this.#emit("error", error instanceof Error ? error : new Error(String(error)));
      }
      const rest = period - (Date.now() - started);
      if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest));
    }
    // Let go of: the closure, when it comes, is the one the race takes.
    return new Promise<BridgeClosure>(() => {});
  }

  /** One step of following the device. */
  async #step(connection: Connection) {
    const { device, runtime } = connection;
    const report = await runtime.step(1000 / (this.#options.rate ?? 30));
    const keys = await runtime.keys();
    // The device may step several times between two of the session's: each
    // value its clock took is a step.
    const steps = (JSON.parse(await device.takeValues(TIME_KEY)) as unknown[]).length;
    const [time, dt, revision] = await Promise.all([
      runtime.read(TIME_KEY),
      runtime.read(DT_KEY),
      this.#readRevision(runtime),
    ]);
    const traced = runtime.deviceTick;
    let tick = this.#status.tick;
    if (traced !== null && traced !== this.#traced) tick = traced;
    else if (tick !== null) tick += steps;
    this.#traced = traced;
    const ns = valueNumber(dt);
    const seconds = valueNumber(time);
    this.#status = {
      tick,
      time: seconds === undefined ? null : seconds / 1e9,
      rate: ns ? 1e9 / ns : null,
      revision,
    };
    if (revision !== null) this.#revised(revision);
    this.#emit("tick", { report, status: this.#status, keys });
  }

  /** Take in the revision the device shows: a change this session did not make is another's. */
  #revised(revision: number) {
    const known = this.#revision;
    if (known === revision) return;
    this.#revision = revision;
    const ahead = known === null ? 0 : revision - known;
    const ours = known !== null && ahead > 0 && ahead <= this.#own;
    if (ours) this.#own -= ahead;
    else this.#own = 0;
    if (known === null) return;
    // Following what the device runs, the session follows its change; a
    // behavior the client said is followed until the client says otherwise.
    if (!ours && this.#followed === null) {
      const connection = this.#connection;
      if (connection) void this.#enqueue((at) => this.#followOn(at), connection).catch(() => {});
    }
    this.#emit("behaviorChanged", { revision, external: !ours });
  }

  async #readRevision(runtime: DeviceRuntime): Promise<number | null> {
    return valueNumber(await runtime.read(REVISION_KEY)) ?? null;
  }

  async #read({ device }: Connection): Promise<DeviceBehavior | null> {
    const { readCall, readResult } = this.#options.language;
    if (!readCall || !readResult) return null;
    let answer: string;
    try {
      answer = await device.call(readCall());
    } catch {
      // An interpreter without a read refuses the call.
      return null;
    }
    return readResult(answer);
  }

  /** Make a change of the device's behavior, counted as this session's when its revision shows. */
  #change(change: (connection: Connection) => Promise<void>): Promise<void> {
    return this.#enqueue(async (connection) => {
      this.#own += 1;
      try {
        await change(connection);
      } catch (error) {
        this.#own -= 1;
        throw error;
      }
    });
  }

  /** Run `task` on the connection once every operation before it ran; refused while there is none. */
  #enqueue<T>(task: (connection: Connection) => Promise<T>, on?: Connection): Promise<T> {
    const next = this.#queue.then(() => {
      const connection = on ?? this.#connection;
      if (!connection || this.#connection !== connection) {
        throw new Error(this.#unavailable());
      }
      return task(connection);
    });
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #unavailable(): string {
    const state = this.#state;
    switch (state.status) {
      case "connecting":
        return "the session is still connecting to the device";
      case "lost":
        return `the connection to the device is lost: ${state.reason}`;
      case "closed":
        return state.reason ?? "the session is closed";
      case "connected":
        return "the session is between two connections";
    }
  }

  #setState(state: SessionState) {
    this.#state = state;
    this.#emit("state", state);
  }

  #emit<K extends keyof SessionEvents>(type: K, event: SessionEvents[K]) {
    for (const listener of [...this.#listeners[type]]) listener(event);
  }
}
