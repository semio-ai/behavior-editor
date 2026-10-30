import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Page, expect, test } from "@playwright/test";
import { type TestClient, testClient } from "./test-client";

/**
 * The demo in a browser, against a native Arora device carrying
 * `@arora/dataflow` (`e2e/device`), which the global setup starts. The
 * editor connects to the device's first bridge; the test's own client
 * (`testClient`) uses the second, to set the device up, to change it as
 * another client would, and to read what it runs and holds.
 */

/** The behavior calling `@arora/dataflow` the demo offers. */
const dataflow = readFileSync(join(__dirname, "..", "fixtures", "devices", "dataflow.bt"), "utf8");

let client: TestClient;

test.beforeEach(async () => {
  client = await testClient();
  // Each test, and each attempt of one, starts from a device running no
  // behavior, its inputs as the device seeds them.
  await client.session.stop();
  await client.session.write("sensor/distance", { f32: 0.3 });
  await client.session.write("face/smile_target", { f32: 1 });
});

test.afterEach(async ({ page }) => {
  // The editor lets go of the device, as a person leaving would.
  const disconnect = page.getByRole("button", { name: "Disconnect" });
  if (await disconnect.isVisible()) await disconnect.click();
  await client.close();
});

const runsOn = (page: Page) => page.getByRole("status", { name: "Runs on" });
const banner = (page: Page) => page.getByRole("region", { name: "Device's behavior" });
/** The device's tick, once the device has stated one. */
async function deviceTick(page: Page): Promise<number> {
  const readout = page.getByLabel("Device tick");
  await expect(readout).toHaveText(/^tick \d+$/);
  return Number((await readout.textContent())!.replace(/^tick /, ""));
}

/** Open the demo and connect it to the native device's editor bridge. */
async function connect(page: Page) {
  const url = process.env.E2E_DEVICE_URL!;
  await page.goto("/");
  await page.getByLabel("Device's bridge").fill(url);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText(`Connected to ${url}`)).toBeVisible();
}

/** Open the example titled `title` from the start screen. */
async function openExample(page: Page, title: RegExp) {
  await page.getByRole("button", { name: title }).click();
}

/** Replace the file's text as typed in the Text tab. */
async function typeText(page: Page, text: string) {
  await page.getByRole("tab", { name: "Text" }).click();
  await page.getByRole("textbox", { name: "Behavior text" }).fill(text);
  await page.getByRole("tab", { name: "Diagram" }).click();
}

/** Wait until the device's behavior revision passes `from`, and return it. */
async function revisionAfter(from: number): Promise<number> {
  let now = from;
  await expect.poll(async () => (now = await client.revision())).toBeGreaterThan(from);
  return now;
}

test("an example calling functions the device lacks says so, and nothing ticks in the page", async ({
  page,
}) => {
  await connect(page);
  const greet = page.getByRole("button", { name: /^Greet/ });
  await expect(greet).toContainText("Not on this device: calls truthy, mul, wait, identity");
  await expect(page.getByRole("button", { name: /^Dataflow/ })).toContainText("Runs on the device");

  await greet.click();
  await expect(banner(page)).toContainText(
    "This file calls functions this device doesn't have: truthy, mul, wait, identity.",
  );
  const run = banner(page).getByRole("button", { name: "Run this file on the device" });
  await expect(run).toBeDisabled();
  await expect(run).toHaveAccessibleDescription(/doesn't have: truthy, mul, wait, identity/);
  await expect(runsOn(page)).toHaveText(`Device ${process.env.E2E_DEVICE_URL}`);
  // The device's clock is what shows: nothing plays in the page.
  await expect(page.getByRole("group", { name: "Playback" })).toHaveCount(0);
  await expect(page.getByRole("group", { name: "Device" })).toBeVisible();
  const first = await deviceTick(page);
  await expect.poll(() => deviceTick(page)).toBeGreaterThan(first);
  // Nothing was loaded on the device.
  expect((await client.session.deviceBehavior())?.graph.nodes ?? []).toEqual([]);
});

test("runs the dataflow example on the device, then sends live edits and applies held ones", async ({
  page,
}) => {
  await client.session.run(await client.resolve("running\n"));
  await connect(page);
  await openExample(page, /^Dataflow/);
  await expect(banner(page)).toContainText("The device runs another behavior than this file.");
  await banner(page).getByRole("button", { name: "Compare" }).click();
  await expect(page.getByRole("region", { name: "Comparison" })).toContainText("Only in this file");

  const before = await client.revision();
  await banner(page).getByRole("button", { name: "Run this file on the device" }).click();
  await expect(banner(page)).toHaveCount(0);
  const ran = await revisionAfter(before);
  await expect(page.getByRole("switch", { name: "Live edits" })).toBeChecked();
  await expect(page.getByRole("treeitem", { name: /^parallel, running/ })).toBeVisible();
  const tick = await deviceTick(page);
  await expect.poll(() => deviceTick(page)).toBeGreaterThan(tick);
  await expect.poll(() => client.number("face/level")).toBeCloseTo(31, 3);

  // The damp eased slowly, from 1 toward a target of 0: a restart would jump
  // to its target.
  const slow = dataflow.replace("param.half_life: 0.05f32", "param.half_life: 20f32");
  await typeText(page, slow);
  const slowed = await revisionAfter(ran);
  await client.session.write("face/smile_target", { f32: 0 });
  await expect.poll(() => client.number("face/smile")).toBeLessThan(0.97);
  const eased = await client.number("face/smile");

  // An edit of another node keeps the damp's state.
  const edited = slow.replace("operand_1: 1f32", "operand_1: 2f32");
  await typeText(page, edited);
  const live = await revisionAfter(slowed);
  await expect.poll(() => client.number("face/level")).toBeCloseTo(32, 3);
  const after = await client.number("face/smile");
  expect(after).toBeLessThanOrEqual(eased);
  expect(after).toBeGreaterThan(0.5);

  // With live edits off, a change waits for Apply, which counts it.
  await page.getByRole("switch", { name: "Live edits" }).click();
  await typeText(page, edited.replace("operand_1: 2f32", "operand_1: 3f32"));
  const apply = page.getByRole("button", { name: "Apply 1 change" });
  await expect(apply).toBeEnabled();
  expect(await client.revision()).toBe(live);
  await apply.click();
  await revisionAfter(live);
  await expect.poll(() => client.number("face/level")).toBeCloseTo(33, 3);
  await expect(page.getByRole("button", { name: "Apply 0 changes" })).toBeDisabled();
});

test("tells another client's change, and reloads the device's behavior", async ({ page }) => {
  await connect(page);
  await openExample(page, /^Dataflow/);
  await banner(page).getByRole("button", { name: "Run this file on the device" }).click();
  await expect(page.getByRole("switch", { name: "Live edits" })).toBeChecked();

  // Another client loads a different behavior.
  await client.session.run(await client.resolve(dataflow.replace("operand_1: 1f32", "operand_1: 5f32")));
  await expect(banner(page)).toContainText("Another client changed the device's behavior");
  await banner(page).getByRole("button", { name: "Reload from the device" }).click();
  await expect(page.getByText("device.bt")).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Live edits" })).toBeChecked();
  await page.getByRole("tab", { name: "Text" }).click();
  await expect(page.getByRole("textbox", { name: "Behavior text" })).toHaveValue(/5f32/);
});

test("opens the device's behavior from the start screen, and from the header with its names", async ({
  page,
}) => {
  await client.session.run(await client.resolve(dataflow.replace("operand_1: 1f32", "operand_1: 5f32")));
  await connect(page);
  await page.getByRole("button", { name: "Open the device's behavior" }).click();
  await expect(page.getByText("device.bt", { exact: true })).toBeVisible();
  await expect(banner(page)).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Live edits" })).toBeChecked();
  await expect(page.getByRole("treeitem", { name: /^parallel, running/ })).toBeVisible();
  await page.getByRole("tab", { name: "Text" }).click();
  await expect(page.getByRole("textbox", { name: "Behavior text" })).toHaveValue(/5f32/);

  // The file the editor ran on the device opens as it ran, with its names.
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Close" }).click();
  await openExample(page, /^Dataflow/);
  await banner(page).getByRole("button", { name: "Run this file on the device" }).click();
  await expect(page.getByRole("switch", { name: "Live edits" })).toBeChecked();
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "New" }).click();
  await expect(banner(page)).toContainText("The device runs another behavior than this file.");
  await page.getByRole("button", { name: "Device's behavior", exact: true }).click();
  await expect(page.getByText("dataflow.bt", { exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Behavior text" })).toHaveValue(dataflow);
  await expect(page.getByRole("switch", { name: "Live edits" })).toBeChecked();
});

test("disconnecting leaves the device running, and the editor back on its simulated runtime", async ({
  page,
}) => {
  await connect(page);
  await openExample(page, /^Dataflow/);
  await banner(page).getByRole("button", { name: "Run this file on the device" }).click();
  await expect(page.getByRole("switch", { name: "Live edits" })).toBeChecked();
  await expect.poll(() => client.number("face/level")).toBeCloseTo(31, 3);
  const revision = await client.revision();

  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(runsOn(page)).toHaveText("Simulated");
  await expect(page.getByRole("group", { name: "Playback" })).toBeVisible();
  await expect(banner(page)).toHaveCount(0);

  // The device runs on, its behavior as it was.
  const time = await client.number("arora/time");
  await expect.poll(() => client.number("arora/time")).toBeGreaterThan(time);
  expect(await client.revision()).toBe(revision);
  expect((await client.session.deviceBehavior())?.graph.nodes?.length).toBeGreaterThan(0);
  expect(await client.number("face/level")).toBeCloseTo(31, 3);
});

test.describe("with no device", () => {
  test.beforeEach(async ({ page }) => {
    // The pickers' fallbacks: a file input to open, a download to save.
    await page.addInitScript(() => {
      const w = window as { showOpenFilePicker?: unknown; showSaveFilePicker?: unknown };
      delete w.showOpenFilePicker;
      delete w.showSaveFilePicker;
    });
    await page.goto("/");
  });

  test("the start screen opens an example, simulated, its diagram showing outputs and values", async ({
    page,
  }) => {
    await expect(page.getByRole("heading", { name: "Open a behavior" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New behavior" })).toBeVisible();
    await openExample(page, /^Smile mapping/);
    await expect(page.getByText("smile.bt")).toBeVisible();
    await expect(runsOn(page)).toHaveText("Simulated");
    // Playing, the editor's tick advances and the nodes report values.
    const tick = page.getByRole("status", { name: "Tick" });
    await expect
      .poll(async () => Number((await tick.textContent())!.replace(/^tick /, "")))
      .toBeGreaterThan(5);
    const mouth = page.getByRole("treeitem", { name: /^mouth/ });
    await expect(mouth).toHaveAccessibleDescription(/rig\/mouth_corner/);
    await expect(page.locator(".be-output").first()).toBeVisible();

    await page.getByRole("tab", { name: "Text" }).click();
    await expect(page.getByRole("textbox", { name: "Behavior text" })).toHaveValue(/^# Smile mapping/);
  });

  /** A behavior every format holds, Groot included: a tree alone, its bindings values and keys. */
  const TREE = [
    "sequence",
    "  sequence_star",
    "    truthy(x: {person/visible})",
    '    set_string(variable: {face/mood}, value: "near")',
    "  {rig/arm_raise} = damp(target: 1, half_life: 0.12, state: none, initial: {rig/arm_raise})",
    "  wait(seconds: 2, now: {arora/time}, since: none)",
    "",
  ].join("\n");

  for (const [label, file, shape] of [
    ["Graph, JSON", "behavior.json", /"nodes"/],
    ["Graph, YAML", "behavior.yaml", /nodes:/],
    ["Groot XML", "behavior.xml", /<root/],
  ] as const) {
    test(`saves as ${label} and opens it again`, async ({ page }) => {
      await page.getByRole("button", { name: "New behavior" }).click();
      await typeText(page, TREE);
      await expect(page.getByRole("treeitem", { name: /^wait/ })).toBeVisible();
      await page.getByRole("button", { name: "File", exact: true }).click();
      await page.getByRole("menuitem", { name: "Save as…" }).click();
      const downloading = page.waitForEvent("download");
      await page.getByRole("group", { name: "Save as" }).getByRole("button", { name: label }).click();
      const download = await downloading;
      expect(download.suggestedFilename()).toBe(file);
      const path = await download.path();
      expect(await readFile(path, "utf8")).toMatch(shape);

      await page.getByRole("button", { name: "File", exact: true }).click();
      await page.getByRole("menuitem", { name: "New" }).click();
      await expect(page.getByRole("treeitem", { name: /^wait/ })).toHaveCount(0);
      await page.getByRole("button", { name: "File", exact: true }).click();
      const choosing = page.waitForEvent("filechooser");
      await page.getByRole("menuitem", { name: "Open…" }).click();
      await (await choosing).setFiles({
        name: file,
        mimeType: "text/plain",
        buffer: await readFile(path),
      });
      await expect(page.getByText(file, { exact: true })).toBeVisible();
      await expect(page.getByRole("treeitem", { name: /^wait/ })).toBeVisible();
    });
  }
});
