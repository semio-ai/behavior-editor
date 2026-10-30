// @vitest-environment jsdom
import "../../fixtures/dom";
import { act, cleanup, configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode, useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Example, GREET, ORDER } from "../../fixtures/examples";
import { FAKE_CALLS, FakeDevice } from "../../fixtures/fake-device";
import { loadLanguage } from "../../fixtures/language";
import { DATAFLOW_FUNCTIONS, loadDevice } from "../../fixtures/local-arora";
import { type Graph, isEmptyDiff } from "../model/graph";
import { valueNumber } from "../model/value";
import { DeviceSession } from "../session/device-session";
import { DATAFLOW_MODULE_ID, type DeviceModule, createLocalArora } from "../local-arora/local-arora";
import type { BehaviorText } from "../text/language";
import { BehaviorEditor } from "./BehaviorEditor";
import { reopenPageStore } from "./recent-files";
import type { BehaviorExample } from "./StartScreen";

// The device steps on its own clock, and this host is loaded: wait for it longer.
configure({ asyncUtilTimeout: 5000 });

let language: BehaviorText;
let localDevice: DeviceModule;
beforeAll(async () => {
  language = await loadLanguage();
  localDevice = await loadDevice();
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

/**
 * A way to start a local Arora seeded as ORDER is, paused so that only the
 * editor steps it: each one it makes is in `made`, the last the one kept.
 */
function localAroras() {
  const made: DeviceSession[] = [];
  const start = () => {
    const session = createLocalArora(localDevice, language, {
      inputs: ORDER.inputs,
      values: ORDER.values,
      playing: false,
    });
    made.push(session);
    sessions.push(session);
    return session;
  };
  return { made, start };
}

/** The graph `text` resolves to against `@arora/dataflow`'s functions. */
const graphOf = (text: string): Graph =>
  language.resolve(language.parse(text).document, DATAFLOW_FUNCTIONS).graph;

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
        moduleNames={{ [DATAFLOW_MODULE_ID]: "dataflow" }}
      />
    );
  }
  const user = userEvent.setup();
  // In Strict Mode, as a host's development build renders it.
  render(
    <StrictMode>
      <Host />
    </StrictMode>,
  );
  await screen.findByRole("group", { name: "Device" });
  return { device, session, user, type: (text: string) => act(() => typeText(text)) };
}

const loads = (device: FakeDevice) => device.calls.filter((c) => c.id === "load");
const edits = (device: FakeDevice) => device.calls.filter((c) => c.id === "edit");
const banner = () => screen.queryByRole("region", { name: "Device's behavior" });
/** The file's text, from the text field, which stays mounted while another tab shows. */
const textValue = () =>
  (screen.getByRole("textbox", { name: "Behavior text", hidden: true }) as HTMLTextAreaElement)
    .value;

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
    expect(screen.queryByRole("treeitem", { name: /, (running|succeeded|failed)/ })).toBeNull();

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
    // The file opened is the one the device runs: its changes go to it.
    expect(await screen.findByRole("switch", { name: "Live edits" })).toBeChecked();
    expect(banner()).toBeNull();
    const text = (screen.getByRole("textbox", { name: "Behavior text", hidden: true }) as HTMLTextAreaElement).value;
    expect(same(graphOf(text), graphOf(ORDER.text))).toBe(true);
  });

  it("opens the device's behavior from the header: a file run there with its names, else its graph", async () => {
    const { device, user } = await setup(GREET, graphOf(ORDER.text));
    const offer = await screen.findByRole("region", { name: "Device's behavior" });
    await user.click(within(offer).getByRole("button", { name: "Run this file on the device" }));
    await waitFor(() => expect(banner()).toBeNull());
    const header = () => screen.getByRole("button", { name: "Device's behavior" });
    expect(header()).toHaveAccessibleDescription(
      "Open the behavior the device runs, in place of this file.",
    );

    // A behavior the editor did not run opens as its graph, its nodes named by their ids.
    device.loadedByAnother(graphOf(ORDER.text));
    await screen.findByText(/Another client changed/);
    await user.click(header());
    await waitFor(() => expect(screen.getByText("device.bt")).toBeTruthy());
    expect(same(graphOf(textValue()), graphOf(ORDER.text))).toBe(true);
    expect(await screen.findByRole("switch", { name: "Live edits" })).toBeChecked();

    // The file the editor ran opens as it ran, with its names.
    device.loadedByAnother(graphOf(GREET.text));
    await screen.findByText(/Another client changed/);
    await user.click(header());
    await waitFor(() => expect(screen.getByText(GREET.file)).toBeTruthy());
    expect(textValue()).toBe(GREET.text);
  });

  it("disables the header's button while it reads the device's behavior", async () => {
    const { device, user } = await setup(GREET, graphOf(ORDER.text));
    await screen.findByRole("region", { name: "Device's behavior" });
    device.readDelayMs = 300;
    const header = screen.getByRole("button", { name: "Device's behavior" });
    await user.click(header);
    expect(header).toBeDisabled();
    expect(header).toHaveAccessibleDescription("Reading the device's behavior…");
    await waitFor(() => expect(screen.getByText("device.bt")).toBeTruthy());
  });

  it("opens nothing over changes made while it reads the device's behavior, and says so", async () => {
    const { device, user, type } = await setup(GREET, graphOf(ORDER.text));
    await screen.findByRole("region", { name: "Device's behavior" });
    device.readDelayMs = 300;
    await user.click(screen.getByRole("button", { name: "Device's behavior" }));
    type(`${GREET.text}# typed while it read\n`);
    expect(await screen.findByText(/the file changed while it was read/)).toBeTruthy();
    expect(screen.queryByText("device.bt")).toBeNull();
    expect(textValue()).toBe(`${GREET.text}# typed while it read\n`);
  });

  it("opens the device's behavior over changes made before the discard was confirmed", async () => {
    const { user, type } = await setup(GREET, graphOf(ORDER.text));
    const offer = await screen.findByRole("region", { name: "Device's behavior" });
    type(`${GREET.text}# first\n`);
    await user.click(within(offer).getByRole("button", { name: "View the device's behavior" }));
    type(`${GREET.text}# second\n`);
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.getByText("device.bt")).toBeTruthy());
    expect(same(graphOf(textValue()), graphOf(ORDER.text))).toBe(true);
  });

  it("asks before the header's button discards unsaved changes", async () => {
    const { user, type } = await setup(GREET, graphOf(ORDER.text));
    await screen.findByRole("region", { name: "Device's behavior" });
    type(`${GREET.text}# a comment\n`);
    await user.click(screen.getByRole("button", { name: "Device's behavior" }));
    expect(screen.getByRole("button", { name: "Discard" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(textValue()).toBe(`${GREET.text}# a comment\n`);

    await user.click(screen.getByRole("button", { name: "Device's behavior" }));
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.getByText("device.bt")).toBeTruthy());
    expect(same(graphOf(textValue()), graphOf(ORDER.text))).toBe(true);
  });

  it("sends each change as an edit, or keeps it for Apply with live edits off", async () => {
    const { device, user, type } = await setup(ORDER, graphOf(ORDER.text));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Live edits" })).toBeTruthy());
    const next = ORDER.text.replace("operand_1: 10f32)", "operand_1: 20f32)");
    expect(next).not.toBe(ORDER.text);
    type(next);
    await waitFor(() => expect(edits(device)).toHaveLength(1));
    expect(same(device.graph, graphOf(next))).toBe(true);

    await user.click(screen.getByRole("switch", { name: "Live edits" }));
    const later = next.replace("operand_1: 20f32)", "operand_1: 30f32)");
    type(later);
    const apply = await screen.findByRole("button", { name: "Apply 1 change" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(edits(device)).toHaveLength(1);
    await user.click(apply);
    await waitFor(() => expect(edits(device)).toHaveLength(2));
    expect(same(device.graph, graphOf(later))).toBe(true);
    expect(screen.getByRole("button", { name: "Apply 0 changes" })).toBeDisabled();
  });

  it("sends no change that keeps the file from running, and says why", async () => {
    const { device, type } = await setup(ORDER, graphOf(ORDER.text));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Live edits" })).toBeTruthy());
    type(`${ORDER.text}\nextra: nope(x: 1)\n`);
    const offer = await screen.findByRole("region", { name: "Device's behavior" });
    expect(offer).toHaveTextContent("This file calls functions this device doesn't have: nope.");
    expect(within(offer).getByRole("status").textContent).toBe(
      "The device goes on running this file as it last ran: your changes are not sent.",
    );
    // A text the parse cannot read whole does not run either.
    type(`${ORDER.text}\n)(\n`);
    await waitFor(() =>
      expect(banner()).toHaveTextContent(
        "The text has errors: the file runs on the device once they are fixed.",
      ),
    );
    type(ORDER.text);
    await waitFor(() => expect(banner()).toBeNull());
    expect(edits(device)).toEqual([]);
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

  it("opens nothing it read for a reload once another file replaced this one", async () => {
    const { device, user } = await setup(ORDER, graphOf(ORDER.text));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Live edits" })).toBeTruthy());
    device.loadedByAnother(graphOf(GREET.text));
    const alert = await screen.findByText(/Another client changed/);
    device.readDelayMs = 300;
    await user.click(
      within(alert.closest("section")!).getByRole("button", { name: "Reload from the device" }),
    );
    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: "New" }));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(screen.queryByText("device.bt")).toBeNull();
    const text = (
      screen.getByRole("textbox", { name: "Behavior text", hidden: true }) as HTMLTextAreaElement
    ).value;
    expect(text).toBe("");
  });

  it("on a device that does not report its behavior, still runs and stops the file", async () => {
    const { device, user } = await setup(ORDER, graphOf(GREET.text), (d) => {
      d.reads = false;
    });
    const offer = await screen.findByRole("region", { name: "Device's behavior" });
    expect(within(offer).getByRole("status").textContent).toBe(
      "This device doesn't report its behavior: the editor cannot show what it runs.",
    );
    const header = screen.getByRole("button", { name: "Device's behavior" });
    expect(header).toBeDisabled();
    expect(header).toHaveAccessibleDescription("This device doesn't report its behavior.");
    await user.click(within(offer).getByRole("button", { name: "Run this file on the device" }));
    await waitFor(() => expect(banner()).toBeNull());
    expect(same(device.graph, graphOf(ORDER.text))).toBe(true);
    expect(header).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Stop on device" }));
    await waitFor(() => expect(device.graph).toEqual({}));
  });

  it("says why following the device failed, until it follows again", async () => {
    const { device } = await setup(ORDER, graphOf(ORDER.text));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Live edits" })).toBeTruthy());
    device.refusesKeys = "the store is unavailable";
    expect(await screen.findByRole("alert")).toHaveTextContent("the store is unavailable");
    device.refusesKeys = null;
    await waitFor(() =>
      expect(screen.queryByText("the store is unavailable")).toBeNull(),
    );
  });

  it("leaves the device running when the session closes, and runs nothing with no Arora left", async () => {
    const { device, session } = await setup(ORDER, graphOf(ORDER.text));
    await waitFor(() => expect(screen.getByRole("switch", { name: "Live edits" })).toBeTruthy());
    await act(() => session.close());
    await waitFor(() =>
      expect(screen.getByRole("status", { name: "Runs on" })).toHaveTextContent("No Arora"),
    );
    expect(screen.queryByRole("group", { name: "Playback" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Device" })).toBeNull();
    expect(banner()).toBeNull();
    expect(loads(device)).toEqual([]);
    expect(same(device.graph, graphOf(ORDER.text))).toBe(true);
  });
});

/**
 * The uncontrolled editor on its start screen, offering ORDER and GREET,
 * attached to a device running `running` whose functions are
 * `@arora/dataflow`'s but for `lacks`. With `local`, it starts a local Arora
 * as it mounts, and the device is attached only once `attach` is called.
 */
async function startOn(
  running: Graph,
  { lacks = [], local = false }: { lacks?: readonly string[]; local?: boolean } = {},
) {
  const device = new FakeDevice({ graph: running, revision: 3 });
  device.functions = device.functions.filter((f) => !lacks.includes(f.name));
  const session = new DeviceSession(() => device.connect(), {
    language: FAKE_CALLS,
    rate: 100,
    reconnect: { firstMs: 20, maxMs: 40 },
    label: "the test robot",
  });
  sessions.push(session);
  timers.push(setInterval(() => device.step(), 10));
  const examples: BehaviorExample[] = [
    { title: "Order", fileName: ORDER.file, text: ORDER.text },
    { title: "Greet", fileName: GREET.file, text: GREET.text },
  ];
  const locals = localAroras();
  let attachHost: (attached: boolean) => void = () => {};
  function Host() {
    const [attached, setAttached] = useState(!local);
    attachHost = setAttached;
    return (
      <BehaviorEditor
        language={language}
        session={attached ? session : null}
        localArora={local ? locals.start : undefined}
        startLocalArora={local}
        examples={examples}
        moduleNames={{ [DATAFLOW_MODULE_ID]: "dataflow" }}
      />
    );
  }
  const user = userEvent.setup();
  render(
    <StrictMode>
      <Host />
    </StrictMode>,
  );
  await waitFor(() => expect(session.state.status).toBe("connected"));
  return {
    device,
    session,
    user,
    /** The local Arora the editor keeps. */
    local: () => locals.made.at(-1)!,
    attach: () => act(() => attachHost(true)),
    detach: () => act(() => attachHost(false)),
  };
}

const runsOn = () => screen.getByRole("status", { name: "Runs on" }).textContent;

describe("BehaviorEditor on a device, opening an example", () => {
  it("opens the device's behavior from the start screen", async () => {
    const { user } = await startOn(graphOf(GREET.text));
    const start = screen.getByRole("region", { name: "Open a behavior" });
    await user.click(within(start).getByRole("button", { name: "Open the device's behavior" }));
    await waitFor(() => expect(screen.getByText("device.bt")).toBeTruthy());
    expect(same(graphOf(textValue()), graphOf(GREET.text))).toBe(true);
    // The file opened is the one the device runs: its changes go to it.
    expect(await screen.findByRole("switch", { name: "Live edits" })).toBeChecked();
    expect(banner()).toBeNull();
  });

  it("opens nothing a device let go of answers, and shows none of its failures", async () => {
    const { device, user, detach } = await startOn(graphOf(GREET.text));
    device.readDelayMs = 300;
    await user.click(screen.getByRole("button", { name: "Open the device's behavior" }));
    detach();
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(screen.getByRole("region", { name: "Open a behavior" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("says so when the device does not say what it runs, staying on the start screen", async () => {
    const { device, user } = await startOn(graphOf(GREET.text));
    device.reads = false;
    await user.click(screen.getByRole("button", { name: "Open the device's behavior" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The device does not say what it runs");
    expect(screen.getByRole("region", { name: "Open a behavior" })).toBeTruthy();
  });


  it("marks the examples the device cannot run on the start screen", async () => {
    await startOn(graphOf(ORDER.text), { lacks: ["oscillator", "slew"] });
    const greet = await screen.findByRole("button", { name: /^Greet/ });
    await waitFor(() =>
      expect(greet).toHaveTextContent("Not on this device: calls oscillator, slew"),
    );
    expect(greet).toHaveClass("be-start-foreign");
    const order = screen.getByRole("button", { name: /^Order/ });
    expect(order).toHaveTextContent("Runs on the device");
    expect(order).not.toHaveClass("be-start-foreign");
  });

  it("works on the device, and nothing ticks in the page", async () => {
    const { user } = await startOn(graphOf(GREET.text));
    await user.click(await screen.findByRole("button", { name: /^Order/ }));
    const offer = await screen.findByRole("region", { name: "Device's behavior" });
    expect(within(offer).getByRole("status").textContent).toBe(
      "The device runs another behavior than this file.",
    );
    expect(runsOn()).toBe("Device the test robot");
    expect(screen.getByRole("group", { name: "Device" })).toBeTruthy();
    // The device steps itself: the page has no clock to play.
    expect(screen.queryByRole("group", { name: "Playback" })).toBeNull();
    const tick = () => screen.getByLabelText("Device tick").textContent!;
    await waitFor(() => expect(tick()).toMatch(/^tick \d+$/));
    expect(within(offer).getByRole("button", { name: "Run this file on the device" })).toBeEnabled();
  });

  it("says which functions the device lacks, and does not run the file", async () => {
    const { user } = await startOn(graphOf(ORDER.text), { lacks: ["oscillator", "slew"] });
    await user.click(await screen.findByRole("button", { name: /^Greet/ }));
    const reason = await screen.findByText(
      "This file calls functions this device doesn't have: oscillator, slew.",
    );
    const offer = screen.getByRole("region", { name: "Device's behavior" });
    expect(offer).toContainElement(reason);
    const run = within(offer).getByRole("button", { name: "Run this file on the device" });
    expect(run).toBeDisabled();
    expect(run).toHaveAccessibleDescription(
      "This file calls functions this device doesn't have: oscillator, slew.",
    );
    // The diagnostics point at the calls.
    const diagnostics = screen.getByRole("list", { name: "Diagnostics", hidden: true });
    expect(within(diagnostics).getByText(/no function is named `slew`/, { exact: false })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "Playback" })).toBeNull();
  });

  it("hands the file to a device connected to, the local Arora keeping its behavior and store", async () => {
    const { user, attach, local } = await startOn(graphOf(GREET.text), { local: true });
    // The start screen offers the attached Arora's behavior once the local one is.
    await screen.findByRole("button", { name: "Open the device's behavior" });
    await user.click(screen.getByRole("button", { name: /^Order/ }));
    expect(runsOn()).toBe("Local Arora");
    // A file opened on the local Arora runs there at once.
    expect(await screen.findByRole("switch", { name: "Live edits" })).toBeChecked();
    expect(screen.getByRole("group", { name: "Playback" })).toBeTruthy();
    // A value written there, which the counter goes on from.
    await local().write("v", { f32: 100 });
    await user.click(screen.getByRole("button", { name: "Step" }));
    await waitFor(async () => expect(valueNumber(await local().read("v"))).toBeGreaterThan(100));

    attach();
    await waitFor(() => expect(runsOn()).toBe("Device the test robot"));
    expect(screen.queryByRole("group", { name: "Playback" })).toBeNull();
    // The device runs another behavior: the file waits to be run there.
    const offer = await screen.findByRole("region", { name: "Device's behavior" });
    expect(within(offer).getByRole("status").textContent).toBe(
      "The device runs another behavior than this file.",
    );
    const kept = await local().deviceBehavior();
    expect(same(kept!.graph, graphOf(ORDER.text))).toBe(true);
    expect(valueNumber(await local().read("v"))).toBeGreaterThan(100);
  });

  it("attaches the local Arora as it was left once the device is let go of, running nothing unasked", async () => {
    const { user, attach, detach, local } = await startOn(graphOf(GREET.text), { local: true });
    // The start screen offers the attached Arora's behavior once the local one is.
    await screen.findByRole("button", { name: "Open the device's behavior" });
    await user.click(screen.getByRole("button", { name: /^Order/ }));
    expect(runsOn()).toBe("Local Arora");
    expect(await screen.findByRole("switch", { name: "Live edits" })).toBeChecked();
    await local().write("v", { f32: 100 });
    await user.click(screen.getByRole("button", { name: "Step" }));
    await waitFor(async () => expect(valueNumber(await local().read("v"))).toBeGreaterThan(100));

    // On the device, another file opens: it does not run there unasked.
    attach();
    await waitFor(() => expect(runsOn()).toBe("Device the test robot"));
    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: "Close" }));
    await user.click(await screen.findByRole("button", { name: /^Greet/ }));
    await screen.findByRole("switch", { name: "Live edits" });

    // Let go of the device: the local Arora is back, its behavior and store as they were.
    detach();
    await waitFor(() => expect(runsOn()).toBe("Local Arora"));
    const offer = await screen.findByRole("region", { name: "Device's behavior" });
    expect(within(offer).getByRole("status").textContent).toBe(
      "The device runs another behavior than this file.",
    );
    expect(within(offer).getByRole("button", { name: "Run this file on the device" })).toBeEnabled();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const kept = await local().deviceBehavior();
    expect(same(kept!.graph, graphOf(ORDER.text))).toBe(true);
    // Its store too: the counter goes on from the value written there.
    expect(valueNumber(await local().read("v"))).toBeGreaterThan(100);
  });
});
