// @vitest-environment jsdom
import "../../fixtures/dom";
import { act, cleanup, configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Example, GREET, ORDER } from "../../fixtures/examples";
import { FAKE_CALLS, FakeDevice } from "../../fixtures/fake-device";
import { MATH_FUNCTIONS, loadLanguage } from "../../fixtures/language";
import { type Graph, isEmptyDiff } from "../model/graph";
import { MATH_MODULE_ID } from "../runtime/math-module";
import { DeviceSession } from "../session/device-session";
import type { BehaviorText } from "../text/language";
import { BehaviorEditor } from "./BehaviorEditor";
import { reopenPageStore } from "./recent-files";

// The device steps on its own clock, and this host is loaded: wait for it longer.
configure({ asyncUtilTimeout: 5000 });

let language: BehaviorText;
beforeAll(async () => {
  language = await loadLanguage();
});

const sessions: DeviceSession[] = [];
const timers: ReturnType<typeof setInterval>[] = [];
afterEach(async () => {
  cleanup();
  for (const timer of timers.splice(0)) clearInterval(timer);
  for (const session of sessions.splice(0)) await session.close();
  vi.unstubAllGlobals();
  reopenPageStore();
});

/** The graph `text` resolves to against the math module. */
const graphOf = (text: string): Graph =>
  language.resolve(language.parse(text).document, MATH_FUNCTIONS).graph;

const same = (a: Graph, b: Graph) => isEmptyDiff(language.diff(a, b));

/**
 * The editor over `example`, controlled, attached to a device running
 * `running`, stepping every 10 ms while the test runs.
 */
async function setup(example: Example, running: Graph, prepare?: (device: FakeDevice) => void) {
  const device = new FakeDevice({ graph: running, revision: 3 });
  prepare?.(device);
  const session = new DeviceSession(() => device.connect(), {
    language: FAKE_CALLS,
    rate: 100,
    reconnect: { firstMs: 20, maxMs: 40 },
  });
  sessions.push(session);
  timers.push(setInterval(() => device.step(), 10));
  let typeText: (text: string) => void = () => {};
  function Host() {
    const [text, setText] = useState(example.text);
    typeText = setText;
    return (
      <BehaviorEditor
        language={language}
        session={session}
        text={text}
        onTextChange={setText}
        fileName={example.file}
        moduleNames={{ [MATH_MODULE_ID]: "math" }}
      />
    );
  }
  const user = userEvent.setup();
  render(<Host />);
  await screen.findByRole("group", { name: "Device" });
  return { device, session, user, type: (text: string) => act(() => typeText(text)) };
}

const loads = (device: FakeDevice) => device.calls.filter((c) => c.id === "load");
const edits = (device: FakeDevice) => device.calls.filter((c) => c.id === "edit");
const banner = () => screen.queryByRole("region", { name: "Device's behavior" });

describe("BehaviorEditor on a device", () => {
  it("attaches without changing what the device runs, and shows its tick and nodes", async () => {
    const { device } = await setup(GREET, graphOf(GREET.text), (d) => {
      d.statuses = { [graphOf(GREET.text).root!]: "running" };
    });
    // The device steps itself: its clock shows where Play and Step would.
    expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
    await waitFor(() => expect(screen.getByLabelText("Step rate").textContent).toBe("50 Hz"));
    const tick = () => screen.getByLabelText("Device tick").textContent!;
    await waitFor(() => expect(tick()).toMatch(/^tick \d+$/));
    const first = Number(tick().slice(5));
    await waitFor(() => expect(Number(tick().slice(5))).toBeGreaterThan(first));
    await waitFor(() => expect(screen.getByRole("treeitem", { name: /^fallback, running/ })).toBeTruthy());
    expect(banner()).toBeNull();
    expect(screen.getByRole("switch", { name: "Live edits" })).toBeChecked();
    expect(loads(device)).toEqual([]);
    expect(edits(device)).toEqual([]);
  });

  it("offers to view, run or compare when the device runs another behavior", async () => {
    const { device, user } = await setup(GREET, graphOf(ORDER.text));
    const offer = await screen.findByRole("region", { name: "Device's behavior" });
    expect(within(offer).getByRole("status").textContent).toBe(
      "The device runs another behavior than this file.",
    );
    // Its nodes are not this file's: none shows a state.
    expect(screen.queryByRole("treeitem", { name: /running|succeeded|failed/ })).toBeNull();

    await user.click(within(offer).getByRole("button", { name: "Compare" }));
    const comparison = screen.getByRole("region", { name: "Comparison" });
    expect(within(comparison).getByRole("heading", { name: /^Only in this file/ })).toBeTruthy();
    expect(within(comparison).getByRole("heading", { name: /^Only on the device/ })).toBeTruthy();
    const added = within(comparison).getAllByRole("button");
    await user.click(added.find((b) => b.textContent!.startsWith("fresh"))!);
    expect(screen.getByRole("treeitem", { name: /^fresh: not/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.click(within(offer).getByRole("button", { name: "Run this file on the device" }));
    await waitFor(() => expect(banner()).toBeNull());
    expect(same(device.graph, graphOf(GREET.text))).toBe(true);
    expect(loads(device)).toHaveLength(1);
  });

  it("opens the device's behavior, its nodes named by their ids", async () => {
    const { user } = await setup(GREET, graphOf(ORDER.text));
    const offer = await screen.findByRole("region", { name: "Device's behavior" });
    await user.click(within(offer).getByRole("button", { name: "View the device's behavior" }));
    await waitFor(() => expect(screen.getByText("device.bt")).toBeTruthy());
    await waitFor(() => expect(banner()).toBeNull());
    const text = (screen.getByRole("textbox", { name: "Behavior text", hidden: true }) as HTMLTextAreaElement).value;
    expect(same(graphOf(text), graphOf(ORDER.text))).toBe(true);
  });

  it("sends each change as an edit, or keeps it for Apply with live edits off", async () => {
    const { device, user, type } = await setup(ORDER, graphOf(ORDER.text));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Live edits" })).toBeTruthy());
    const next = ORDER.text.replace("b: 10)", "b: 20)");
    expect(next).not.toBe(ORDER.text);
    type(next);
    await waitFor(() => expect(edits(device)).toHaveLength(1));
    expect(same(device.graph, graphOf(next))).toBe(true);

    await user.click(screen.getByRole("switch", { name: "Live edits" }));
    const later = next.replace("b: 20)", "b: 30)");
    type(later);
    const apply = await screen.findByRole("button", { name: "Apply 1 change" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(edits(device)).toHaveLength(1);
    await user.click(apply);
    await waitFor(() => expect(edits(device)).toHaveLength(2));
    expect(same(device.graph, graphOf(later))).toBe(true);
    expect(screen.getByRole("button", { name: "Apply 0 changes" })).toBeDisabled();
  });

  it("tells a change another client made, and reloads or overwrites it", async () => {
    const { device, user } = await setup(ORDER, graphOf(ORDER.text));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Live edits" })).toBeTruthy());
    device.loadedByAnother(graphOf(GREET.text));
    const alert = await screen.findByText(/Another client changed the device's behavior \(revision 4\)/);
    const offer = alert.closest("section");
    await user.click(within(offer!).getByRole("button", { name: "Overwrite with mine" }));
    await waitFor(() => expect(banner()).toBeNull());
    expect(same(device.graph, graphOf(ORDER.text))).toBe(true);

    device.loadedByAnother(graphOf(GREET.text));
    const again = await screen.findByText(/Another client changed/);
    await user.click(
      within(again.closest("section")!).getByRole("button", {
        name: "Reload from the device",
      }),
    );
    await waitFor(() => expect(screen.getByText("device.bt")).toBeTruthy());
    const text = (screen.getByRole("textbox", { name: "Behavior text", hidden: true }) as HTMLTextAreaElement).value;
    expect(same(graphOf(text), graphOf(GREET.text))).toBe(true);
  });

  it("on a device that does not report its behavior, still runs and stops the file", async () => {
    const { device, user } = await setup(ORDER, graphOf(GREET.text), (d) => {
      d.reads = false;
    });
    const offer = await screen.findByRole("region", { name: "Device's behavior" });
    expect(within(offer).getByRole("status").textContent).toBe(
      "This device doesn't report its behavior: the editor cannot show what it runs.",
    );
    await user.click(within(offer).getByRole("button", { name: "Run this file on the device" }));
    await waitFor(() => expect(banner()).toBeNull());
    expect(same(device.graph, graphOf(ORDER.text))).toBe(true);
    await user.click(screen.getByRole("button", { name: "Stop on device" }));
    await waitFor(() => expect(device.graph).toEqual({}));
  });

  it("leaves the device running when the session closes, and goes back to its own runtime", async () => {
    const { device, session } = await setup(ORDER, graphOf(ORDER.text));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Live edits" })).toBeTruthy());
    await act(() => session.close());
    expect(await screen.findByRole("button", { name: "Play" })).toBeTruthy();
    expect(loads(device)).toEqual([]);
    expect(same(device.graph, graphOf(ORDER.text))).toBe(true);
  });
});
