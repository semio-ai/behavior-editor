// @vitest-environment jsdom
import "../../fixtures/dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GREET, SMILE } from "../../fixtures/examples";
import { MATH_FUNCTIONS, loadLanguage } from "../../fixtures/language";
import type { Graph } from "../model/graph";
import type { Value } from "../model/value";
import { type AroraDevice, DeviceRuntime } from "../runtime/device-runtime";
import { MockArora } from "../runtime/mock-arora";
import type { BehaviorText } from "../text/language";
import { BehaviorEditor } from "./BehaviorEditor";

let language: BehaviorText;
beforeAll(async () => {
  language = await loadLanguage();
});
afterEach(cleanup);

/**
 * A device as the World offers it: device-relative keys, each key's meta, an
 * update applied at the next step, and every call recorded.
 */
class FakeDevice implements AroraDevice {
  store = new Map<string, Value>();
  meta = new Map<string, Record<string, unknown>>();
  calls: string[] = [];
  pending: Record<string, Value | null>[] = [];
  describeMethods() {
    return JSON.stringify(MATH_FUNCTIONS);
  }
  call(callJson: string) {
    this.calls.push(callJson);
    return JSON.stringify({ ret: "unit", mutated: [] });
  }
  update(changesJson: string) {
    this.pending.push(JSON.parse(changesJson) as Record<string, Value | null>);
  }
  read(key: string) {
    return JSON.stringify(this.store.get(key.slice("D/".length)) ?? null);
  }
  listKeys() {
    const keys = [...new Set([...this.store.keys(), ...this.meta.keys()])].sort();
    return JSON.stringify(keys.map((key) => [key, this.meta.get(key) ?? {}]));
  }
  step() {
    for (const changes of this.pending.splice(0)) {
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) this.store.delete(key);
        else this.store.set(key, value);
      }
    }
  }
}

/** A runtime over `device` whose loads it can tell apart: the graph's root, or `empty`. */
function deviceRuntime(device: FakeDevice) {
  return new DeviceRuntime({
    device,
    deviceId: "D",
    loadCall: (graph: Graph) => JSON.stringify({ load: graph.root ?? "empty" }),
  });
}

function renderEditor(text: string, runtime: MockArora | DeviceRuntime) {
  const user = userEvent.setup();
  const view = render(
    <BehaviorEditor language={language} runtime={runtime} defaultText={text} autoPlay={false} />,
  );
  return { user, view };
}

const openStore = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole("tab", { name: "Store" }));
  return screen.getByRole("region", { name: "Store" });
};

describe("the store panel", () => {
  it("shows a key the behavior publishes every tick as a value, not a control", async () => {
    const { user } = renderEditor(SMILE.text, new MockArora({ store: SMILE.store }));
    await user.click(await screen.findByRole("button", { name: "Step" }));
    const store = await openStore(user);
    await waitFor(() =>
      expect(within(store).getByRole("status", { name: "rig/mouth_corner" })).toBeInTheDocument(),
    );
    expect(within(store).queryByRole("slider", { name: "rig/mouth_corner" })).toBeNull();
    expect(
      within(store).getByRole("status", { name: "rig/mouth_corner" }),
    ).toHaveAccessibleDescription("published by the behavior every tick");
    // The key the behavior reads is an input.
    expect(within(store).getByRole("slider", { name: "face/smile" })).toBeInTheDocument();
    // The runtime's clock is its own.
    expect(within(store).queryByRole("slider", { name: "arora/time" })).toBeNull();
  });

  it("keeps a key a tree node writes editable, and says the behavior writes it", async () => {
    const { user } = renderEditor(GREET.text, new MockArora({ store: GREET.store }));
    const store = await openStore(user);
    const greeted = await within(store).findByRole("switch", { name: "social/greeted" });
    expect(greeted).toHaveAccessibleDescription("written by the behavior when its node ticks");
  });

  it("offers no control for a device key its meta closes, and lists what the behavior reads", async () => {
    const device = new FakeDevice();
    device.store.set("k.position", { f64: 0.25 });
    device.meta.set("k.position", { ty: "f64", editable: false });
    device.meta.set("face/smile", { ty: "f64", editable: true });
    // Open to a person's writes, but published by a sink after every tick.
    device.meta.set("rig/mouth_corner", { ty: "f64", editable: true });
    const { user } = renderEditor(
      `${SMILE.text}\nnudge: {rig/nudge} = add(a: {sensor/unlisted}, b: 1)\n`,
      deviceRuntime(device),
    );
    const store = await openStore(user);
    await within(store).findByRole("status", { name: "k.position" });
    expect(within(store).queryByRole("slider", { name: "k.position" })).toBeNull();
    expect(within(store).getByRole("status", { name: "k.position" })).toHaveAccessibleDescription(
      "written by the runtime, not by a person",
    );
    expect(within(store).queryByRole("slider", { name: "rig/mouth_corner" })).toBeNull();
    expect(
      within(store).getByRole("status", { name: "rig/mouth_corner" }),
    ).toHaveAccessibleDescription("published by the behavior every tick");
    // Open but holding nothing yet: it can be set.
    expect(within(store).getByRole("slider", { name: "face/smile" })).toBeInTheDocument();
    // Read by the behavior, unknown to the device: shown, and why it cannot be written.
    expect(
      within(store).getByRole("status", { name: "sensor/unlisted" }),
    ).toHaveAccessibleDescription("not listed by the runtime: it cannot be written");
  });

  it("shows a device write as pending until the next step", async () => {
    const device = new FakeDevice();
    device.meta.set("face/smile", { ty: "f64", editable: true });
    device.store.set("face/smile", { f64: 0.2 });
    const { user } = renderEditor(SMILE.text, deviceRuntime(device));
    const store = await openStore(user);
    const slider = await within(store).findByRole("slider", { name: "face/smile" });
    fireEvent.change(slider, { target: { value: "0.5" } });
    await waitFor(() => expect(slider).toHaveAccessibleDescription("applies at the next step"));
    // The written value shows; the device still holds the old one.
    const written = Number((slider as HTMLInputElement).value);
    expect(written).toBe(0.5);
    expect(device.store.get("face/smile")).toEqual({ f64: 0.2 });
    await user.click(screen.getByRole("tab", { name: "Diagram" }));
    await user.click(screen.getByRole("button", { name: "Step" }));
    await user.click(screen.getByRole("tab", { name: "Store" }));
    const after = await within(screen.getByRole("region", { name: "Store" })).findByRole("slider", {
      name: "face/smile",
    });
    await waitFor(() => expect(after).not.toHaveAccessibleDescription("applies at the next step"));
    expect(Number((after as HTMLInputElement).value)).toBeCloseTo(written, 6);
    expect(device.store.get("face/smile")).toEqual({ f64: written });
  });

  it("stops the behavior after it started, however soon the editor unmounts", async () => {
    const device = new FakeDevice();
    const { view } = renderEditor(SMILE.text, deviceRuntime(device));
    await new Promise((resolve) => setTimeout(resolve, 0));
    view.unmount();
    await waitFor(() => expect(device.calls.at(-1)).toBe(JSON.stringify({ load: "empty" })));
    const loads = device.calls.map((c) => (JSON.parse(c) as { load: string }).load);
    expect(loads.at(-1)).toBe("empty");
    expect(loads.filter((l) => l !== "empty").length).toBeGreaterThanOrEqual(1);
    expect(loads.lastIndexOf("empty")).toBeGreaterThan(loads.findLastIndex((l) => l !== "empty"));
  });
});
