// @vitest-environment jsdom
import "../../fixtures/dom";
import { act, cleanup, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GREET, ORDER } from "../../fixtures/examples";
import { MATH_FUNCTIONS, loadLanguage } from "../../fixtures/language";
import type { Graph } from "../model/graph";
import type { MethodSignature } from "../model/signature";
import { MockArora } from "../runtime/mock-arora";
import type { BehaviorText } from "../text/language";
import { BehaviorEditor, type BehaviorEditorProps } from "./BehaviorEditor";
import { reopenPageStore } from "./recent-files";
import { usePlayback } from "./use-playback";
import type { BehaviorExample } from "./StartScreen";

let language: BehaviorText;
beforeAll(async () => {
  language = await loadLanguage();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  // Each test starts as a new page: no recent file.
  reopenPageStore();
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

  it("shows nothing a runtime the host switched away from answers late", async () => {
    const first = new MockArora({ store: ORDER.store });
    const second = new MockArora({ store: ORDER.store });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    first.step = async () => {
      await held;
      throw new Error("the first runtime's step failed");
    };
    const user = userEvent.setup();
    const props = { language, autoPlay: false, defaultText: ORDER.text, fileName: ORDER.file };
    const { rerender } = render(<BehaviorEditor {...props} runtime={first} />);
    await user.click(await screen.findByRole("button", { name: "Step" }));
    rerender(<BehaviorEditor {...props} runtime={second} />);
    await user.click(screen.getByRole("button", { name: "Step" }));
    await waitFor(() => expect(screen.getByLabelText("Tick")).toHaveTextContent("tick 1"));
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText("the first runtime's step failed")).toBeNull();
    expect(screen.getByLabelText("Tick")).toHaveTextContent("tick 1");
  });

  it("runs a behavior on a runtime switched to only once resolved against its own functions", async () => {
    const first = new MockArora({ store: ORDER.store });
    // Another catalogue: the same functions under other ids, said late.
    const renamed = MATH_FUNCTIONS.map((f) => ({ ...f, id: `${f.id.slice(0, -4)}beef` }));
    let say: (functions: MethodSignature[]) => void = () => {};
    const second = new MockArora({ store: ORDER.store });
    second.functions = () => new Promise((resolve) => (say = resolve));
    const started: Graph[] = [];
    second.start = (loaded) => {
      started.push(loaded.graph);
      return Promise.resolve();
    };
    const props = { language, autoPlay: false, defaultText: ORDER.text, fileName: ORDER.file };
    const { rerender } = render(<BehaviorEditor {...props} runtime={first} />);
    await screen.findByRole("tree", { name: "Behavior diagram" });
    rerender(<BehaviorEditor {...props} runtime={second} />);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(started).toEqual([]);
    say(renamed);
    await waitFor(() => expect(started).toHaveLength(1));
    const ids = new Set(renamed.map((f) => f.id));
    const calls = (started[0]!.nodes ?? []).map((n) => n.function);
    expect(calls.some((id) => ids.has(id))).toBe(true);
    expect(calls.some((id) => MATH_FUNCTIONS.some((f) => f.id === id))).toBe(false);
  });

  it("shows no failure of an open that something else replaced", async () => {
    let fail: (error: Error) => void = () => {};
    vi.stubGlobal("showOpenFilePicker", () => new Promise((_, reject) => (fail = reject)));
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "Open…" }));
    await user.click(screen.getByRole("button", { name: "New behavior" }));
    fail(new Error("the picker failed"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: "Close" }));
    expect(screen.queryByText("the picker failed")).toBeNull();
  });

  it("keeps the recent files for the page, across editors", async () => {
    vi.stubGlobal("showOpenFilePicker", () =>
      Promise.resolve([handle("greet.bt", GREET.text).handle]),
    );
    const user = userEvent.setup();
    const first = render(<BehaviorEditor language={language} autoPlay={false} />);
    await user.click(screen.getByRole("button", { name: "Open…" }));
    await waitFor(() => expect(text()).toHaveValue(GREET.text));
    first.unmount();
    render(<BehaviorEditor language={language} autoPlay={false} />);
    expect(await screen.findByRole("button", { name: /^greet\.bt/ })).toBeTruthy();
  });

  it("shows nothing a step on a runtime switched away from reads after the switch", async () => {
    const first = new MockArora({ store: ORDER.store });
    const second = new MockArora({ store: ORDER.store });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { read } = first;
    let holding = false;
    first.read = async (key) => {
      if (holding) await held;
      return read.call(first, key);
    };
    const diff = (a: Graph, b: Graph) =>
      JSON.stringify(a) === JSON.stringify(b) ? {} : { remove: [] };
    const { result, rerender } = renderHook(
      ({ runtime }) => usePlayback(runtime, ORDER.loaded, false, diff),
      { initialProps: { runtime: first } },
    );
    await waitFor(() => expect(result.current.store.size).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    act(() => result.current.write("written", { f64: 9 }));
    await waitFor(() => expect(result.current.pending.has("written")).toBe(true));
    holding = true;
    act(() => result.current.step());
    await new Promise((resolve) => setTimeout(resolve, 50));
    rerender({ runtime: second });
    await waitFor(() => expect(result.current.pending.size).toBe(0));
    act(() => result.current.write("mine", { f64: 1 }));
    await waitFor(() => expect(result.current.pending.has("mine")).toBe(true));
    release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(result.current.pending.has("mine")).toBe(true);
    expect(result.current.store.has("written")).toBe(false);
  });

  it("disposes an example's runtime only once it answered for its functions", async () => {
    const order: string[] = [];
    const runtime = new MockArora({ store: ORDER.store });
    let answer: () => void = () => {};
    const { functions } = runtime;
    runtime.functions = async () => {
      await new Promise<void>((resolve) => (answer = resolve));
      order.push("functions");
      return functions.call(runtime);
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
    await user.click(await screen.findByRole("button", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: "Close" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual([]);
    answer();
    await waitFor(() => expect(order).toEqual(["functions", "dispose"]));
  });

  it("opens on a controlled text that arrives after it mounted, and stays closed once closed", async () => {
    const props = { language, autoPlay: false, fileName: ORDER.file, onTextChange: () => {} };
    const user = userEvent.setup();
    const { rerender } = render(<BehaviorEditor {...props} />);
    expect(screen.getByRole("region", { name: "Open a behavior" })).toBeTruthy();
    rerender(<BehaviorEditor {...props} text={ORDER.text} />);
    await waitFor(() => expect(text()).toHaveValue(ORDER.text));
    expect(screen.queryByText("(unsaved changes)")).toBeNull();
    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: "Close" }));
    rerender(<BehaviorEditor {...props} text={ORDER.text} />);
    expect(screen.getByRole("region", { name: "Open a behavior" })).toBeTruthy();
  });

  it("shows no failure of a step from before the host switched away and back", async () => {
    const first = new MockArora({ store: ORDER.store });
    const second = new MockArora({ store: ORDER.store });
    let fail: () => void = () => {};
    const held = new Promise<void>((resolve) => (fail = resolve));
    const { step } = first;
    let steps = 0;
    first.step = async (dt) => {
      if (steps++ > 0) return step.call(first, dt);
      await held;
      throw new Error("a step from before");
    };
    const diff = (a: Graph, b: Graph) =>
      JSON.stringify(a) === JSON.stringify(b) ? {} : { remove: [] };
    const { result, rerender } = renderHook(
      ({ runtime }) => usePlayback(runtime, ORDER.loaded, true, diff),
      { initialProps: { runtime: first } },
    );
    await waitFor(() => expect(result.current.store.size).toBeGreaterThan(0));
    act(() => result.current.step());
    await new Promise((resolve) => setTimeout(resolve, 50));
    rerender({ runtime: second });
    await new Promise((resolve) => setTimeout(resolve, 50));
    rerender({ runtime: first });
    fail();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(result.current.error).toBeNull();
    expect(result.current.playing).toBe(true);
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
