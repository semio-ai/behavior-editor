import { afterEach, describe, expect, it } from "vitest";
import { DATAFLOW } from "../../fixtures/examples";
import { loadLanguage } from "../../fixtures/language";
import { loadDevice, loadedOf, localArora, stepped } from "../../fixtures/local-arora";
import { createLocalArora } from "../local-arora/local-arora";
import { PageBridge } from "../local-arora/page-bridge";
import { valueNumber } from "../model/value";
import { DeviceSession, type SessionTick } from "../session/device-session";

/**
 * The local Arora: a real Arora device in the page behind a bridge client,
 * whose clock its session drives, as a remote device's is its own.
 */

const sessions: DeviceSession[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
});

async function local(options: Parameters<typeof localArora>[1] = {}) {
  const session = await localArora(DATAFLOW, options);
  sessions.push(session);
  return session;
}

const seconds = async (session: DeviceSession) => valueNumber(await session.read("arora/time"))! / 1e9;

/** The ticks `session` tells within `ms`. */
async function ticksWithin(session: DeviceSession, ms: number): Promise<SessionTick[]> {
  const ticks: SessionTick[] = [];
  const stop = session.on("tick", (tick) => ticks.push(tick));
  await new Promise((resolve) => setTimeout(resolve, ms));
  stop();
  return ticks;
}

describe("the local Arora", () => {
  it("is driven by its session: paused it holds, and each step lasts one period of the rate", async () => {
    const session = await local({ rate: 50 });
    expect(session.clock).toBe("driven");
    expect(session.clockState).toEqual({ playing: false, rate: 50 });
    await session.run(await loadedOf(DATAFLOW));
    const before = await seconds(session);
    expect(await ticksWithin(session, 100)).toEqual([]);
    expect(await seconds(session)).toBe(before);

    const tick = await stepped(session);
    expect(tick.status.rate).toBeCloseTo(50, 6);
    expect(await seconds(session)).toBeCloseTo(before + 0.02, 9);
    expect(valueNumber(await session.read("face/level"))).toBeCloseTo(31, 4);

    session.setRate(10);
    await stepped(session);
    expect(await seconds(session)).toBeCloseTo(before + 0.12, 9);
    for (const rate of [0, -1, Infinity, NaN]) expect(() => session.setRate(rate)).toThrow(/invalid rate/);
    expect(session.clockState.rate).toBe(10);
    const [device, language] = await Promise.all([loadDevice(), loadLanguage()]);
    expect(() => createLocalArora(device, language, { rate: Infinity })).toThrow(/invalid rate/);
  });

  it("steps at its rate while it plays, and tells each change of its clock", async () => {
    const session = await local({ rate: 50 });
    const told: unknown[] = [];
    session.on("clock", (clock) => told.push(clock));
    session.play();
    const ticks = await ticksWithin(session, 300);
    expect(ticks.length).toBeGreaterThan(2);
    session.pause();
    expect(told).toEqual([
      { playing: true, rate: 50 },
      { playing: false, rate: 50 },
    ]);
  });

  it("refuses a value to start from that no input opens", async () => {
    const [device, language] = await Promise.all([loadDevice(), loadLanguage()]);
    expect(() =>
      createLocalArora(device, language, { values: { "sensor/x": { f32: 1 } } }),
    ).toThrow(/refused/);
  });

  it("is a device on its own clock behind a bridge that steps itself", async () => {
    const [device, language] = await Promise.all([loadDevice(), loadLanguage()]);
    const made = new device.DataflowDevice("self", "{}");
    const bridge = new PageBridge(made, { namespace: "self", periodMs: 20 });
    void bridge.closed.then(() => made.free());
    const session = new DeviceSession(bridge, { language, reconnect: false });
    sessions.push(session);
    await new Promise<void>((resolve) => {
      if (session.state.status === "connected") resolve();
      else session.on("state", (state) => state.status === "connected" && resolve());
    });
    expect(session.clock).toBe("self");
    await expect(session.step()).rejects.toThrow(/own clock/);
    expect((await ticksWithin(session, 200)).length).toBeGreaterThan(0);
  });
});
