// @vitest-environment jsdom
import "../../fixtures/dom";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GREET, ORDER } from "../../fixtures/examples";
import { loadLanguage } from "../../fixtures/language";
import { MockArora } from "../runtime/mock-arora";
import type { BehaviorText } from "../text/language";
import { BehaviorEditor, type BehaviorEditorProps } from "./BehaviorEditor";
import type { BehaviorExample } from "./StartScreen";

let language: BehaviorText;
beforeAll(async () => {
  language = await loadLanguage();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The examples a host offers: ORDER on a runtime of its own, GREET on the editor's. */
function examples() {
  const made: { runtime: MockArora; disposed: boolean }[] = [];
  const list: BehaviorExample[] = [
    {
      title: "Order",
      fileName: ORDER.file,
      text: ORDER.text,
      runtime: () => {
        const entry = { runtime: new MockArora({ store: ORDER.store }), disposed: false };
        made.push(entry);
        return { runtime: entry.runtime, dispose: () => (entry.disposed = true) };
      },
    },
    { title: "Greet", fileName: GREET.file, text: GREET.text },
  ];
  return { list, made };
}

function setup(props: Partial<BehaviorEditorProps> = {}) {
  const user = userEvent.setup();
  render(<BehaviorEditor language={language} autoPlay={false} {...props} />);
  return { user };
}

/** The text field, which stays mounted while another tab shows. */
const text = () =>
  screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Behavior text", hidden: true });

/** A handle to a file of `contents`, which the page may read once `allowed` says so. */
function handle(name: string, contents: string, allowed: PermissionState = "granted") {
  const asked: string[] = [];
  return {
    asked,
    handle: {
      name,
      kind: "file",
      getFile: () => Promise.resolve({ name, text: () => Promise.resolve(contents) }),
      isSameEntry: (other: { name: string }) => Promise.resolve(other.name === name),
      queryPermission: () => Promise.resolve(allowed),
      requestPermission: () => {
        asked.push(name);
        return Promise.resolve("granted" as PermissionState);
      },
    },
  };
}

describe("the start screen", () => {
  it("opens with no behavior, offering a new one, a file, and the host's examples", () => {
    const { list } = examples();
    setup({ examples: list });
    const start = screen.getByRole("region", { name: "Open a behavior" });
    expect(within(start).getByRole("button", { name: "New behavior" })).toBeTruthy();
    expect(within(start).getByRole("button", { name: "Open…" })).toBeTruthy();
    const shown = within(screen.getByRole("region", { name: "Examples" })).getAllByRole("button");
    expect(shown.map((b) => b.textContent)).toEqual([`Order${ORDER.file}`, `Greet${GREET.file}`]);
    expect(within(screen.getByRole("region", { name: "Recent" })).getByText(/are listed here/));
    expect(screen.queryByRole("tree")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("lists no examples when the host gives none", () => {
    setup();
    expect(screen.queryByRole("region", { name: "Examples" })).toBeNull();
  });

  it("opens the editor when there is a text to start from", () => {
    setup({ defaultText: ORDER.text, fileName: ORDER.file });
    expect(screen.queryByRole("region", { name: "Open a behavior" })).toBeNull();
    expect(screen.getByText(ORDER.file)).toBeTruthy();
  });

  it("opens an example from the keyboard, on the runtime it declares, and closes it", async () => {
    const { list, made } = examples();
    const { user } = setup({ examples: list });
    // New, Open, then the examples: every action is reached with Tab.
    await user.tab();
    expect(screen.getByRole("button", { name: "New behavior" })).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: /^Order/ })).toHaveFocus();
    await user.keyboard("{Enter}");
    await screen.findByRole("tree", { name: "Behavior diagram" });
    expect(text()).toHaveValue(ORDER.text);
    expect(screen.getByText(ORDER.file)).toBeTruthy();
    const opened = made.at(-1)!;
    await user.click(screen.getByRole("button", { name: "Step" }));
    await waitFor(async () => expect(await opened.runtime.read("v")).toEqual({ f64: 1 }));

    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: "Close" }));
    expect(screen.getByRole("heading", { name: "Open a behavior" })).toHaveFocus();
    await waitFor(() => expect(made.every((m) => m.disposed)).toBe(true));
  });

  it("starts a new behavior on the editor's runtime", async () => {
    const runtime = new MockArora();
    const { user } = setup({ runtime, fileName: "draft.bt" });
    await user.click(screen.getByRole("button", { name: "New behavior" }));
    expect(text()).toHaveValue("");
    expect(screen.getByText("draft.bt")).toBeTruthy();
  });

  it("asks before closing a file with unsaved changes", async () => {
    const { list } = examples();
    const { user } = setup({ examples: list });
    await user.click(screen.getByRole("button", { name: /^Greet/ }));
    await user.click(screen.getByRole("tab", { name: "Text" }));
    await user.type(text(), "# a comment\n");
    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: "Close" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Discard unsaved changes?");
    expect(screen.getByRole("button", { name: "Discard" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.getByRole("region", { name: "Open a behavior" })).toBeTruthy();
  });

  it("remembers a file opened, and opens it again from its handle, asking to read it", async () => {
    const greet = handle("greet.bt", GREET.text, "prompt");
    vi.stubGlobal("showOpenFilePicker", () => Promise.resolve([greet.handle]));
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Open…" }));
    await waitFor(() => expect(text()).toHaveValue(GREET.text));

    await user.click(screen.getByRole("button", { name: "File" }));
    const recent = screen.getByRole("group", { name: "Open recent" });
    expect(
      within(recent)
        .getAllByRole("menuitem")
        .map((m) => m.textContent),
    ).toEqual(["greet.bt"]);
    await user.click(screen.getByRole("menuitem", { name: "Close" }));

    vi.stubGlobal("showOpenFilePicker", () => Promise.reject(new Error("no picker expected")));
    const listed = within(screen.getByRole("region", { name: "Recent" }));
    await user.click(listed.getByRole("button", { name: /^greet\.bt/ }));
    await waitFor(() => expect(text()).toHaveValue(GREET.text));
    expect(greet.asked).toEqual(["greet.bt"]);
  });

  it("opens a recent file from the File menu", async () => {
    const order = handle("order.bt", ORDER.text);
    const greet = handle("greet.bt", GREET.text);
    let next = order.handle;
    vi.stubGlobal("showOpenFilePicker", () => Promise.resolve([next]));
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Open…" }));
    await waitFor(() => expect(text()).toHaveValue(ORDER.text));
    next = greet.handle;
    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: "Open…" }));
    await waitFor(() => expect(text()).toHaveValue(GREET.text));

    await user.click(screen.getByRole("button", { name: "File" }));
    const recent = screen.getByRole("group", { name: "Open recent" });
    expect(
      within(recent)
        .getAllByRole("menuitem")
        .map((m) => m.textContent),
    ).toEqual(["greet.bt", "order.bt"]);
    await user.click(within(recent).getByRole("menuitem", { name: "order.bt" }));
    await waitFor(() => expect(text()).toHaveValue(ORDER.text));
  });

  it("remembers a file saved without the File System Access API by its contents", async () => {
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const { createObjectURL, revokeObjectURL } = URL;
    URL.createObjectURL = () => "blob:behavior";
    URL.revokeObjectURL = () => undefined;
    try {
      const { user } = setup({ fileName: "mine.bt" });
      await user.click(screen.getByRole("button", { name: "New behavior" }));
      await user.click(screen.getByRole("tab", { name: "Text" }));
      await user.type(text(), "succeed\n");
      await user.click(screen.getByRole("button", { name: "File" }));
      await user.click(screen.getByRole("menuitem", { name: "Save" }));
      await waitFor(() => expect(screen.queryByText("(unsaved changes)")).toBeNull());
      await user.click(screen.getByRole("button", { name: "File" }));
      await user.click(screen.getByRole("menuitem", { name: "Close" }));
      const listed = within(screen.getByRole("region", { name: "Recent" }));
      await user.click(await listed.findByRole("button", { name: /^mine\.bt/ }));
      expect(text()).toHaveValue("succeed\n");
    } finally {
      Object.assign(URL, { createObjectURL, revokeObjectURL });
    }
  });

  it("removes a file from the recent files", async () => {
    vi.stubGlobal("showOpenFilePicker", () =>
      Promise.resolve([handle("greet.bt", GREET.text).handle]),
    );
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Open…" }));
    await waitFor(() => expect(text()).toHaveValue(GREET.text));
    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: "Remove greet.bt from the recent files" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^greet\.bt/ })).toBeNull());
  });

  it("opens a file on the editor's runtime only once the one it replaces stopped", async () => {
    const runtime = new MockArora({ store: ORDER.store });
    const calls: string[] = [];
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { start, step, stop } = runtime;
    runtime.start = (loaded) => {
      calls.push("start");
      return start.call(runtime, loaded);
    };
    runtime.stop = () => {
      calls.push("stop");
      return stop.call(runtime);
    };
    runtime.step = async (dt) => {
      calls.push("step");
      await held;
      return step.call(runtime, dt);
    };
    vi.stubGlobal("showOpenFilePicker", () =>
      Promise.resolve([handle("greet.bt", GREET.text).handle]),
    );
    const { user } = setup({ runtime, defaultText: ORDER.text, fileName: ORDER.file });
    await waitFor(() => expect(calls).toEqual(["start"]));
    await user.click(screen.getByRole("button", { name: "Step" }));
    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: "Open…" }));
    await waitFor(() => expect(text()).toHaveValue(GREET.text));
    // Long enough for the new file to have started, were it not waiting for the stop.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls).toEqual(["start", "step"]);
    release();
    await waitFor(() => expect(calls).toEqual(["start", "step", "stop", "start"]));
  });

  it("disposes an example's runtime once the behavior on it stopped", async () => {
    const order: string[] = [];
    const runtime = new MockArora({ store: ORDER.store });
    const { stop } = runtime;
    runtime.stop = () => {
      order.push("stop");
      return stop.call(runtime);
    };
    const { user } = setup({
      examples: [
        {
          title: "Order",
          fileName: ORDER.file,
          text: ORDER.text,
          runtime: () => ({ runtime, dispose: () => order.push("dispose") }),
        },
      ],
    });
    await user.click(screen.getByRole("button", { name: /^Order/ }));
    await screen.findByRole("tree", { name: "Behavior diagram" });
    order.length = 0;
    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: "Close" }));
    await waitFor(() => expect(order).toContain("dispose"));
    expect(order.indexOf("stop")).toBeLessThan(order.indexOf("dispose"));
  });

  it("opens nothing from a picker answered after another file replaced the one open", async () => {
    let pick: (handles: unknown[]) => void = () => {};
    vi.stubGlobal("showOpenFilePicker", () => new Promise((resolve) => (pick = resolve)));
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Open…" }));
    await user.click(screen.getByRole("button", { name: "New behavior" }));
    await user.click(screen.getByRole("tab", { name: "Text" }));
    await user.type(text(), "succeed\n");
    pick([handle("greet.bt", GREET.text).handle]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(text()).toHaveValue("succeed\n");
  });

  it("starts the behavior on a runtime the host switches to, a step of the previous still pending", async () => {
    const first = new MockArora({ store: ORDER.store });
    const second = new MockArora({ store: ORDER.store });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { step } = first;
    first.step = async (dt) => {
      await held;
      return step.call(first, dt);
    };
    const started: string[] = [];
    const { start } = second;
    second.start = (loaded) => {
      started.push("second");
      return start.call(second, loaded);
    };
    const user = userEvent.setup();
    const props = { language, autoPlay: false, defaultText: ORDER.text, fileName: ORDER.file };
    const { rerender } = render(<BehaviorEditor {...props} runtime={first} />);
    await user.click(await screen.findByRole("button", { name: "Step" }));
    rerender(<BehaviorEditor {...props} runtime={second} />);
    await waitFor(() => expect(started).toEqual(["second"]));
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await user.click(screen.getByRole("button", { name: "Step" }));
    await waitFor(async () => expect(await second.read("v")).toEqual({ f64: 1 }));
  });

  it("says why a recent file did not open", async () => {
    const gone = handle("gone.bt", "succeed");
    vi.stubGlobal("showOpenFilePicker", () => Promise.resolve([gone.handle]));
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Open…" }));
    await waitFor(() => expect(text()).toHaveValue("succeed"));
    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: "Close" }));
    gone.handle.getFile = () => Promise.reject(new DOMException("gone", "NotFoundError"));
    await user.click(screen.getByRole("button", { name: /^gone\.bt/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "gone.bt is no longer where it was saved",
    );
    expect(screen.getByRole("region", { name: "Open a behavior" })).toBeTruthy();
  });
});

describe("the File menu", () => {
  it("opens from the keyboard, moves with the arrows, and gives the focus back on Escape", async () => {
    const { user } = setup({ defaultText: ORDER.text, fileName: ORDER.file });
    const file = screen.getByRole("button", { name: "File" });
    expect(file).toHaveAttribute("aria-haspopup", "menu");
    expect(file).toHaveAttribute("aria-expanded", "false");
    file.focus();
    await user.keyboard("{ArrowDown}");
    const menu = screen.getByRole("menu", { name: "File" });
    expect(file).toHaveAttribute("aria-expanded", "true");
    const items = within(menu).getAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["New", "Open…", "Save", "Save as…", "Close"]);
    expect(items[0]).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(items.at(-1)).toHaveFocus();
    await user.keyboard("{Home}{ArrowDown}");
    expect(items[1]).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(file).toHaveFocus();
  });

  it("asks the format to save as, and takes the focus to it", async () => {
    const { user } = setup({ defaultText: ORDER.text, fileName: ORDER.file });
    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: "Save as…" }));
    const formats = screen.getByRole("group", { name: "Save as" });
    expect(within(formats).getAllByRole("button")[0]).toHaveFocus();
    await user.click(within(formats).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("group", { name: "Save as" })).toBeNull();
  });

  it("closes when the focus leaves it", async () => {
    const { user } = setup({ defaultText: ORDER.text, fileName: ORDER.file });
    await user.click(screen.getByRole("button", { name: "File" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    await user.click(screen.getByRole("tab", { name: "Text" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
