import { afterEach, describe, expect, it } from "vitest";
import { ORDER } from "../../fixtures/examples";
import { FAKE_CALLS, FAKE_CALLS_WITHOUT_READ, FakeDevice } from "../../fixtures/fake-device";
import type { Graph } from "../model/graph";
import {
  type BehaviorChange,
  DeviceSession,
  type DeviceSessionOptions,
  type SessionState,
  type SessionTick,
} from "./device-session";

const sessions: DeviceSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
});

const GRAPH: Graph = ORDER.loaded.graph;

/** A device running `graph` at revision 4, and a session connecting to it, again after a loss. */
function setup(options: Partial<DeviceSessionOptions> & { graph?: Graph } = {}) {
  const device = new FakeDevice({ graph: options.graph ?? GRAPH, revision: 4 });
  const session = new DeviceSession(() => device.connect(), {
    language: FAKE_CALLS,
    reconnect: { firstMs: 20, maxMs: 40 },
    rate: 100,
    ...options,
  });
  sessions.push(session);
  const states: SessionState[] = [];
  const changes: BehaviorChange[] = [];
  const ticks: SessionTick[] = [];
  session.on("state", (state) => states.push(state));
  session.on("behaviorChanged", (change) => changes.push(change));
  session.on("tick", (tick) => ticks.push(tick));
  return { device, session, states, changes, ticks };
}

/** Wait for `check` to hold, `step` stepping the device meanwhile. */
async function until(check: () => boolean, step?: () => void, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    step?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const status = (session: DeviceSession) => session.state.status;
const client = (device: FakeDevice) => [...device.clients][0]!;

describe("DeviceSession", () => {
  it("connects and attaches without changing what the device runs", async () => {
    const { device, session, states } = setup();
    expect(session.state).toEqual({ status: "connecting" });
    await until(() => status(session) === "connected");
    expect(states.map((s) => s.status)).toEqual(["connected"]);
    expect(await session.deviceBehavior()).toEqual({ graph: GRAPH, revision: 4 });
    expect(device.calls.filter((c) => c.id === "load" || c.id === "edit")).toEqual([]);
    expect(device.graph).toEqual(GRAPH);
  });

  it("reports the device's tick, clock, step rate and revision, and its behavior's nodes", async () => {
    const { device, session, ticks } = setup();
    await until(() => status(session) === "connected");
    device.tick = 40;
    device.statuses = { [GRAPH.root!]: "running" };
    await until(
      () => (ticks.at(-1)?.status.tick ?? 0) >= 45,
      () => device.step(),
    );
    const last = ticks.at(-1)!;
    expect(last.status.rate).toBe(50);
    expect(last.status.time).toBeCloseTo(device.tick * 0.02, 1);
    expect(last.status.revision).toBe(4);
    // The session follows the behavior the device runs, read as it attached.
    expect(last.report.root).toBe("R");
    // The trace reported once, at tick 41: each step pushed since counts on
    // from it, steps the session did not poll between included.
    expect(device.traces.size).toBe(1);
    for (let i = 0; i < 5; i += 1) device.step();
    await until(() => ticks.at(-1)!.status.tick === device.tick);
  });

  it("says a device whose interpreter has no read does not report its behavior", async () => {
    const refusing = setup();
    refusing.device.reads = false;
    await until(() => status(refusing.session) === "connected");
    expect(await refusing.session.deviceBehavior()).toBeNull();
    const unasked = setup({ language: FAKE_CALLS_WITHOUT_READ });
    await until(() => status(unasked.session) === "connected");
    expect(await unasked.session.deviceBehavior()).toBeNull();
    expect(unasked.device.calls.some((c) => c.id === "read")).toBe(false);
  });

  it("runs, edits and stops the behavior, each change its own", async () => {
    const { device, session, changes } = setup({ graph: {} });
    await until(() => status(session) === "connected");
    await session.run(ORDER.loaded);
    expect(device.graph).toEqual(GRAPH);
    await session.edit({ root: GRAPH.nodes![1]!.id });
    expect(device.graph.root).toBe(GRAPH.nodes![1]!.id);
    // An empty diff changes nothing on the device.
    const sent = device.calls.length;
    await session.edit({});
    expect(device.calls.length).toBe(sent);
    await session.stop();
    expect(device.graph).toEqual({});
    await until(
      () => changes.at(-1)?.revision === 7,
      () => device.step(),
    );
    expect(changes.every((c) => !c.external)).toBe(true);
  });

  it("tells a change of the device's behavior another client made", async () => {
    const { device, session, changes } = setup();
    await until(() => status(session) === "connected");
    await session.run(ORDER.loaded);
    await until(
      () => changes.length === 1,
      () => device.step(),
    );
    expect(changes).toEqual([{ revision: 5, external: false }]);
    device.loadedByAnother({});
    await until(
      () => changes.length === 2,
      () => device.step(),
    );
    expect(changes[1]).toEqual({ revision: 6, external: true });
  });

  it("connects again after the connection drops, and tells a change made meanwhile", async () => {
    const { device, session, states, changes } = setup();
    await until(() => status(session) === "connected");
    await until(
      () => device.traces.size === 1,
      () => device.step(),
    );
    device.reachable = false;
    client(device).end("lost", "the link dropped");
    await until(() => status(session) === "lost");
    const lost = session.state as Extract<SessionState, { status: "lost" }>;
    expect(lost.reason).toBe("the link dropped");
    expect(lost.retryAt).toBeGreaterThan(Date.now() - 1000);
    // Attempts go on, each failing, while the device does not answer.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(status(session)).toBe("lost");
    expect((session.state as { reason: string }).reason).toMatch(/no device answers/);
    device.loadedByAnother({});
    device.reachable = true;
    await until(() => status(session) === "connected");
    expect(states.map((s) => s.status).filter((s, i, all) => s !== all[i - 1])).toEqual([
      "connected",
      "lost",
      "connected",
    ]);
    expect(changes).toEqual([{ revision: 5, external: true }]);
    // The trace the lost connection left is halted, and a new one follows.
    expect(device.calls.filter((c) => c.id === "halt")).toHaveLength(1);
    expect(device.traces.size).toBe(1);
  });

  it("is refused when the device ends the connection on purpose, and does not connect again", async () => {
    const { device, session } = setup();
    await until(() => status(session) === "connected");
    client(device).end("refused", "Another client connected");
    await until(() => status(session) === "closed");
    expect(session.state).toEqual({
      status: "closed",
      reason: "Another client connected",
      refused: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(device.clients.size).toBe(0);
  });

  it("is refused as it takes the device up again, and does not connect again", async () => {
    const { device, session } = setup();
    await until(() => status(session) === "connected");
    // Another client takes the bridge as the session reads the device's keys.
    device.connected = (taken) => taken.end("refused", "Another client connected");
    client(device).end("lost");
    await until(() => status(session) === "closed");
    expect(session.state).toEqual({
      status: "closed",
      reason: "Another client connected",
      refused: true,
    });
  });

  it("does not connect where no device answers", async () => {
    const device = new FakeDevice();
    device.reachable = false;
    const session = new DeviceSession(() => device.connect(), { language: FAKE_CALLS });
    sessions.push(session);
    await until(() => status(session) === "closed");
    expect(session.state).toEqual({
      status: "closed",
      reason: "no device answers at fake://device",
      refused: false,
    });
  });

  it("connects again by default when it is given a way to connect", async () => {
    const device = new FakeDevice({ graph: GRAPH });
    const session = new DeviceSession(() => device.connect(), { language: FAKE_CALLS });
    sessions.push(session);
    await until(() => status(session) === "connected");
    client(device).end("lost");
    await until(() => status(session) === "lost");
    await until(() => status(session) === "connected");
  });

  it("over a connection it is given, does not connect again", async () => {
    const device = new FakeDevice({ graph: GRAPH });
    const session = new DeviceSession(await device.connect(), {
      language: FAKE_CALLS,
      reconnect: true,
    });
    sessions.push(session);
    await until(() => status(session) === "connected");
    client(device).end("lost");
    await until(() => status(session) === "closed");
    expect(session.state).toMatchObject({ refused: false });
  });

  it("closes once an attempt to connect under way has ended, its connection closed", async () => {
    const device = new FakeDevice({ graph: GRAPH });
    let open: (() => void) | null = null;
    const session = new DeviceSession(
      () => new Promise((resolve) => (open = () => resolve(device.connect()))),
      { language: FAKE_CALLS },
    );
    sessions.push(session);
    let closed = false;
    const closing = session.close().then(() => (closed = true));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    open!();
    await closing;
    expect(device.clients.size).toBe(0);
  });

  it("closes without stopping the behavior, its trace halted", async () => {
    const { device, session } = setup();
    await until(() => status(session) === "connected");
    await session.follow(ORDER.loaded);
    await session.close();
    expect(device.calls.some((c) => c.id === "load")).toBe(false);
    expect(device.traces.size).toBe(0);
    expect(device.graph).toEqual(GRAPH);
    expect(device.clients.size).toBe(0);
    await expect(session.deviceBehavior()).rejects.toThrow("the session is closed");
  });
});
