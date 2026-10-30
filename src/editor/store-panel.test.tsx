// @vitest-environment jsdom
import "../../fixtures/dom";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GREET, SMILE } from "../../fixtures/examples";
import { loadLanguage } from "../../fixtures/language";
import { localArora } from "../../fixtures/local-arora";
import type { DeviceSession } from "../session/device-session";
import type { BehaviorText } from "../text/language";
import { BehaviorEditor } from "./BehaviorEditor";
import { keySliderRange } from "./StorePanel";

let language: BehaviorText;
beforeAll(async () => {
  language = await loadLanguage();
});

const sessions: DeviceSession[] = [];
afterEach(async () => {
  cleanup();
  for (const session of sessions.splice(0)) await session.close();
});

/** A local Arora seeded as `example` or `options` say, paused, closed after the test. */
async function arora(example: Parameters<typeof localArora>[0]) {
  const session = await localArora(example);
  sessions.push(session);
  return session;
}

/** The editor over `text`, on `session`, which runs it at once. */
function renderEditor(text: string, session: DeviceSession) {
  const user = userEvent.setup();
  const view = render(<BehaviorEditor language={language} session={session} defaultText={text} />);
  return { user, view };
}

/** Step the Arora from the header, and wait for its tick to show. */
async function step(user: ReturnType<typeof userEvent.setup>) {
  await screen.findByRole("switch", { name: "Live edits" });
  const before = screen.getByLabelText("Device tick").textContent;
  await user.click(screen.getByRole("button", { name: "Step" }));
  await waitFor(() => expect(screen.getByLabelText("Device tick").textContent).not.toBe(before));
}

const openStore = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole("tab", { name: "Store" }));
  return screen.getByRole("region", { name: "Store" });
};

describe("the store panel", () => {
  it("shows a key the behavior publishes every tick as a value, not a control", async () => {
    const { user } = renderEditor(SMILE.text, await arora(SMILE));
    await step(user);
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
    // The Arora's clock is its own.
    expect(within(store).queryByRole("slider", { name: "arora/time" })).toBeNull();
  });

  it("keeps a key a tree node writes editable, and says the behavior writes it", async () => {
    const { user } = renderEditor(GREET.text, await arora(GREET));
    await step(user);
    const store = await openStore(user);
    const greeted = await within(store).findByRole("switch", { name: "social/greeted" });
    expect(greeted).toHaveAccessibleDescription("written by the behavior when its node ticks");
  });

  it("offers no control for a device key its meta closes, and lists what the behavior reads", async () => {
    const session = await arora({
      inputs: {
        ...SMILE.inputs,
        // Open to a person's writes, but published by a sink after every tick.
        "rig/mouth_corner": { ty: "f32", editable: true },
        // Open, and holding nothing.
        "face/blush": { ty: "f32", editable: true },
      },
      values: SMILE.values,
    });
    const { user } = renderEditor(
      `${SMILE.text}\nnudge: {rig/nudge} = add(operand_0: {sensor/unlisted}, operand_1: 1f32)\n`,
      session,
    );
    await step(user);
    const store = await openStore(user);
    // The Arora's step length is its own.
    await within(store).findByRole("status", { name: "arora/dt" });
    expect(within(store).queryByRole("slider", { name: "arora/dt" })).toBeNull();
    expect(within(store).getByRole("status", { name: "arora/dt" })).toHaveAccessibleDescription(
      "written by the runtime, not by a person",
    );
    expect(within(store).queryByRole("slider", { name: "rig/mouth_corner" })).toBeNull();
    expect(
      within(store).getByRole("status", { name: "rig/mouth_corner" }),
    ).toHaveAccessibleDescription("published by the behavior every tick");
    // Open but holding nothing yet: it can be set.
    expect(within(store).getByRole("slider", { name: "face/blush" })).toBeInTheDocument();
    // Read by the behavior, unknown to the Arora: shown, and why it cannot be written.
    expect(
      within(store).getByRole("status", { name: "sensor/unlisted" }),
    ).toHaveAccessibleDescription("not listed by the runtime: it cannot be written");
  });

  it("shows a write as pending until the Arora's next step", async () => {
    const session = await arora(SMILE);
    const { user } = renderEditor(SMILE.text, session);
    await step(user);
    const store = await openStore(user);
    const slider = await within(store).findByRole("slider", { name: "face/smile" });
    fireEvent.change(slider, { target: { value: "0.5" } });
    await waitFor(() => expect(slider).toHaveAccessibleDescription("applies at the next step"));
    // The written value shows; the Arora still holds the old one.
    expect(Number((slider as HTMLInputElement).value)).toBe(0.5);
    expect(await session.read("face/smile")).toEqual({ f32: 0.2 });
    await user.click(screen.getByRole("tab", { name: "Diagram" }));
    await step(user);
    await user.click(screen.getByRole("tab", { name: "Store" }));
    const after = await within(screen.getByRole("region", { name: "Store" })).findByRole("slider", {
      name: "face/smile",
    });
    await waitFor(() => expect(after).not.toHaveAccessibleDescription("applies at the next step"));
    expect(Number((after as HTMLInputElement).value)).toBeCloseTo(0.5, 6);
    expect(await session.read("face/smile")).toEqual({ f32: 0.5 });
  });

  it("shows another Arora's store without the writes pending on the last one", async () => {
    const a = await arora({ ...SMILE, values: { "face/smile": { f32: 0.2 } } });
    const b = await arora({ ...SMILE, values: { "face/smile": { f32: 0.3 } } });
    const { user, view } = renderEditor(SMILE.text, a);
    await step(user);
    const store = await openStore(user);
    const slider = await within(store).findByRole("slider", { name: "face/smile" });
    fireEvent.change(slider, { target: { value: "0.8" } });
    await waitFor(() => expect(slider).toHaveAccessibleDescription("applies at the next step"));
    view.rerender(<BehaviorEditor language={language} session={b} defaultText={SMILE.text} />);
    await user.click(screen.getByRole("tab", { name: "Diagram" }));
    await user.click(await screen.findByRole("button", { name: "Run this file on the device" }));
    await step(user);
    await user.click(screen.getByRole("tab", { name: "Store" }));
    const shown = () =>
      within(screen.getByRole("region", { name: "Store" })).getByRole("slider", { name: "face/smile" });
    await waitFor(() => expect(Number((shown() as HTMLInputElement).value)).toBeCloseTo(0.3, 6));
    expect(shown()).not.toHaveAccessibleDescription("applies at the next step");
  });

  it("spans a key's declared bounds, and types a value past the slider", async () => {
    const session = await arora({
      inputs: { "face/smile": { ty: "f32", editable: true, min: 0, max: 2 } },
      values: { "face/smile": { f32: 0.3 } },
    });
    const { user } = renderEditor(SMILE.text, session);
    await step(user);
    const store = await openStore(user);
    const slider = await within(store).findByRole("slider", { name: "face/smile" });
    expect([slider.getAttribute("min"), slider.getAttribute("max")]).toEqual(["0", "2"]);
    const field = within(store).getByRole("spinbutton", { name: "face/smile value" });
    await user.clear(field);
    await user.type(field, "7{Enter}");
    // Brought within the declared bounds, and applied at the Arora's next step.
    await waitFor(() => expect(slider).toHaveAccessibleDescription("applies at the next step"));
    await user.click(screen.getByRole("tab", { name: "Diagram" }));
    await step(user);
    expect(await session.read("face/smile")).toEqual({ f32: 2 });
  });

  it("describes a key holding a space by its note", async () => {
    const { user } = renderEditor(
      'running\n\nx: {"face/a key"} = add(operand_0: 1f32, operand_1: 1f32)\n',
      await arora({}),
    );
    await step(user);
    const store = await openStore(user);
    await waitFor(() =>
      expect(within(store).getByRole("status", { name: "face/a key" })).toHaveAccessibleDescription(
        "published by the behavior every tick",
      ),
    );
  });
});

describe("a key's slider", () => {
  it("keeps within its type's limits and its declared bounds", () => {
    expect(keySliderRange("u8", undefined, [200])).toEqual([0, 255]);
    expect(keySliderRange("f64", { key: "k", editable: true, min: 0, max: 2 }, [0.3])).toEqual([
      0, 2,
    ]);
    expect(keySliderRange("f64", { key: "k", editable: true, min: -5 }, [0.3])).toEqual([-5, 10]);
    expect(keySliderRange("i8", undefined, [-3])).toEqual([-10, 10]);
    // One bound declared: the other side spans it and the values seen.
    expect(keySliderRange("f64", { key: "k", editable: true, min: 5 }, [0.3])).toEqual([5, 10]);
  });
});
