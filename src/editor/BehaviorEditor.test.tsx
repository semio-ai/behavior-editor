// @vitest-environment jsdom
import "../../fixtures/dom";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Example, GREET, ORDER, SMILE } from "../../fixtures/examples";
import { MATH_FUNCTIONS, loadLanguage } from "../../fixtures/language";
import type { MethodSignature } from "../model/signature";
import type { BehaviorDocument, SourceNode } from "../text/ast";
import type { BehaviorText } from "../text/language";
import { MATH_MODULE_ID } from "../runtime/math-module";
import { MockArora } from "../runtime/mock-arora";
import type { BehaviorRuntime } from "../runtime/runtime";
import { BehaviorEditor, type BehaviorEditorProps, REPARSE_DELAY_MS } from "./BehaviorEditor";
import { reopenPageStore } from "./recent-files";

let language: BehaviorText;
beforeAll(async () => {
  language = await loadLanguage();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  reopenPageStore();
});

/**
 * The editor over `example`, controlled: the text lives in the test's state,
 * and every change the editor makes is recorded in `texts`.
 */
function setup(example: Example, props: Partial<BehaviorEditorProps> = {}) {
  const runtime = new MockArora({ store: example.store });
  const texts: string[] = [];
  function Host() {
    const [text, setText] = useState(example.text);
    return (
      <BehaviorEditor
        language={language}
        runtime={runtime}
        text={text}
        onTextChange={(next) => {
          texts.push(next);
          setText(next);
        }}
        fileName={example.file}
        moduleNames={{ [MATH_MODULE_ID]: "math" }}
        autoPlay={false}
        {...props}
      />
    );
  }
  const user = userEvent.setup();
  render(<Host />);
  /** The document of the text the editor's last change wrote. */
  const written = (): BehaviorDocument => language.parse(texts.at(-1)!).document;
  return { runtime, texts, user, written };
}

/** Choose `entry` from the File menu. */
async function fileMenu(user: ReturnType<typeof userEvent.setup>, entry: string) {
  await user.click(screen.getByRole("button", { name: "File" }));
  await user.click(screen.getByRole("menuitem", { name: entry }));
}

const item = (name: RegExp | string) => screen.getByRole("treeitem", { name });
const names = (nodes: readonly SourceNode[]) => nodes.map((n) => n.call.function.name.text);

describe("BehaviorEditor", () => {
  it("draws the tree, and the detached nodes beside it, as a tree of items", async () => {
    setup(GREET);
    const tree = await screen.findByRole("tree", { name: "Behavior diagram" });
    const items = within(tree).getAllByRole("treeitem");
    expect(items).toHaveLength(13);
    expect(items[0]).toHaveAttribute("aria-level", "1");
    expect(item(/^sequence/)).toHaveAttribute("aria-level", "2");
    expect(item(/^fresh: not, detached/)).toBeTruthy();
    expect(item(/^fallback/)).toHaveAttribute("aria-expanded", "true");
  });

  it("describes a node by its outputs", async () => {
    setup(SMILE);
    const mouth = await screen.findByRole("treeitem", { name: /^mouth: / });
    expect(mouth).toHaveAccessibleDescription("{rig/mouth_corner} ← _ret state");
  });

  it("steps the behavior and shows what each node did", async () => {
    const { user, runtime } = setup(ORDER);
    await user.click(await screen.findByRole("button", { name: "Step" }));
    await waitFor(() => expect(screen.getByLabelText("Tick")).toHaveTextContent("tick 1"));
    expect(screen.getByLabelText("Root status")).toHaveTextContent("Success");
    expect(item(/^sequence, succeeded/)).toBeTruthy();
    expect(item(/^inc: add, detached, called, value changed, value 1$/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Step" }));
    await waitFor(() => expect(screen.getByLabelText("Tick")).toHaveTextContent("tick 2"));
    expect(await runtime.read("v")).toEqual({ f64: 2 });
  });

  it("tells a detached node whose value changed from one that ran to the same value", async () => {
    const { user } = setup(SMILE);
    await user.click(await screen.findByRole("button", { name: "Step" }));
    await waitFor(() => expect(item(/^mouth: /)).toHaveAccessibleName(/value changed/));
    await user.click(screen.getByRole("button", { name: "Step" }));
    // The easing ran again, its state having changed, and returned the value it had.
    await waitFor(() =>
      expect(item(/^mouth: /)).toHaveAccessibleName(/called, same value, value 0\.04$/),
    );
    expect(item(/^cheeks: /)).toHaveAccessibleName(/cache hit, not called, value 0\.12$/);
  });

  it("opens the diagram on its root when the drawing is wider than its pane", async () => {
    const width = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")!;
    Object.defineProperty(Element.prototype, "clientWidth", {
      configurable: true,
      get(this: Element) {
        return this.classList.contains("be-canvas") ? 300 : 0;
      },
    });
    try {
      setup(GREET);
      // Once the runtime's functions arrive, the nodes take their final widths.
      await waitFor(() => expect(item(/^\{rig\/arm_wave\} = mul/)).toHaveAttribute("data-key"));
      await waitFor(() => {
        const root = item(/^fallback/);
        const canvas = root.closest(".be-canvas")!;
        const x = Number(/translate\(([\d.]+),/.exec(root.getAttribute("transform")!)![1]);
        const w = Number(root.querySelector(".be-box")!.getAttribute("width"));
        expect(canvas.scrollLeft).toBeGreaterThan(0);
        expect(x + w / 2 - canvas.scrollLeft).toBeCloseTo(150, 0);
      });
    } finally {
      Object.defineProperty(Element.prototype, "clientWidth", width);
    }
  });

  it("selects a node by click, and moves the selection with the arrow keys", async () => {
    const { user } = setup(ORDER);
    await user.click(await screen.findByRole("treeitem", { name: /^sequence/ }));
    const inspector = screen.getByRole("region", { name: "Selected node" });
    expect(within(inspector).getByText("sequence", { selector: "code" })).toBeTruthy();
    expect(item(/^sequence/)).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowRight}");
    expect(screen.getAllByRole("treeitem", { name: /^\{v\} = identity/ })[0]).toHaveFocus();
    expect(within(inspector).getByText("{v} = identity", { selector: "code" })).toBeTruthy();
    await user.keyboard("{ArrowLeft}");
    expect(item(/^sequence/)).toHaveFocus();
  });

  it("renames a node from the inspector, and its readers follow", async () => {
    const { user, written } = setup(GREET);
    await user.click(await screen.findByRole("treeitem", { name: /^fresh: not/ }));
    const name = screen.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "unseen{Enter}");
    const document = written();
    expect(document.nodes[1]?.name?.text).toBe("unseen");
    const reader = document.nodes[0]!.children[0]!.children[1]!;
    expect(reader.call.arguments[0]?.value.kind).toMatchObject({
      type: "port",
      node: { text: "unseen" },
    });
  });

  it("refuses a name another node has", async () => {
    const { user, texts } = setup(SMILE);
    await user.click(await screen.findByRole("treeitem", { name: /^cheeks: / }));
    const name = screen.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "amount{Enter}");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Another node has this name.")).toBeTruthy();
    expect(texts).toEqual([]);
  });

  it("edits a literal argument through the inspector", async () => {
    const { user, written } = setup(SMILE);
    await user.click(await screen.findByRole("treeitem", { name: /^cheeks: / }));
    const b = screen.getByRole("textbox", { name: "b" });
    expect(b).toHaveValue("0.6");
    await user.clear(b);
    await user.type(b, "0.9{Enter}");
    expect(written().nodes[4]?.call.arguments[1]?.value.kind).toEqual({
      type: "number",
      text: "0.9",
      suffix: null,
    });
  });

  it("feeds an argument from another node's output", async () => {
    const { user, written } = setup(SMILE);
    await user.click(await screen.findByRole("treeitem", { name: /^cheeks: / }));
    await user.selectOptions(screen.getByRole("combobox", { name: "b: source" }), "node");
    await user.selectOptions(screen.getByRole("combobox", { name: "b: node" }), "corner");
    expect(written().nodes[4]?.call.arguments[1]?.value.kind).toMatchObject({
      type: "port",
      node: { text: "corner" },
      parameter: { text: "_ret" },
    });
  });

  it("writes a store key `{key}` cannot hold in its quoted form", async () => {
    const { user, texts } = setup(SMILE);
    await user.click(await screen.findByRole("treeitem", { name: /^cheeks: / }));
    await user.selectOptions(screen.getByRole("combobox", { name: "b: source" }), "key");
    const key = screen.getByRole("combobox", { name: "b: store key" });
    await user.clear(key);
    await user.type(key, "face/a key{Enter}");
    expect(texts.at(-1)).toContain(
      'cheeks: {rig/cheek_raise} = mul(a: @amount._ret, b: {"face/a key"})',
    );
  });

  it("deletes the selected node with the Delete key, and moves it with Alt and an arrow", async () => {
    const { user, written } = setup(ORDER);
    await user.click((await screen.findAllByRole("treeitem", { name: /^truthy/ }))[0]!);
    await user.keyboard("{Delete}");
    expect(names(written().nodes[0]!.children)).toEqual(["identity", "identity", "truthy"]);
    await user.click(screen.getAllByRole("treeitem", { name: /^\{v\} = identity/ })[1]!);
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(names(written().nodes[0]!.children)).toEqual(["identity", "identity", "truthy"]);
  });

  it("adds a child from the palette, searching it by name", async () => {
    const { user, written } = setup(ORDER);
    await user.click(await screen.findByRole("treeitem", { name: /^sequence/ }));
    await user.click(screen.getByRole("button", { name: "Add child" }));
    const search = screen.getByRole("searchbox", { name: "Add child" });
    expect(search).toHaveFocus();
    await user.type(search, "succ");
    const group = screen.getByRole("region", { name: "Behavior tree" });
    await user.click(within(group).getByRole("button", { name: /^succeed/ }));
    expect(names(written().nodes[0]!.children)).toEqual([
      "identity",
      "truthy",
      "identity",
      "truthy",
      "succeed",
    ]);
  });

  it("folds a node, hiding its subtree", async () => {
    const { user } = setup(GREET);
    const before = (await screen.findAllByRole("treeitem")).length;
    const parallel = screen.getAllByRole("treeitem", { name: /^parallel/ })[0]!;
    expect(parallel).toHaveAttribute("aria-level", "3");
    expect(parallel).toHaveAttribute("aria-posinset", "3");
    expect(parallel).toHaveAttribute("aria-setsize", "4");
    await user.click(parallel);
    await user.keyboard("{ArrowLeft}");
    expect(screen.getAllByRole("treeitem")).toHaveLength(before - 3);
    expect(screen.getAllByRole("treeitem", { name: /^parallel/ })[0]).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await user.keyboard("{ArrowRight}");
    expect(screen.getAllByRole("treeitem")).toHaveLength(before);
  });

  it("parses the text again once typing pauses, and lists what it found", async () => {
    const { user, texts } = setup(ORDER);
    await user.click(screen.getByRole("tab", { name: "Text" }));
    const text = screen.getByRole("textbox", { name: "Behavior text" });
    expect(text).toHaveValue(ORDER.text);
    await user.type(text, "x(");
    // Every keystroke reaches the text; the parse waits for typing to pause.
    expect(texts).toEqual([`${ORDER.text}x`, `${ORDER.text}x(`]);
    expect(screen.queryByRole("list", { name: "Diagnostics" })).toBeNull();
    const diagnostics = await screen.findByRole("list", { name: "Diagnostics" });
    // `(` opens on line 11, the line after the file's last, at column 2.
    expect(within(diagnostics).getAllByRole("button")[0]).toHaveTextContent(/^11:2 error/);
    expect(text).toHaveAttribute("aria-invalid", "true");
  });

  it("edits nothing from the diagram while the text has errors", async () => {
    const { user, texts } = setup(ORDER);
    await user.click(screen.getByRole("tab", { name: "Text" }));
    await user.type(screen.getByRole("textbox", { name: "Behavior text" }), "x(");
    await user.click(screen.getByRole("tab", { name: "Diagram" }));
    expect(await screen.findByText(/^The text has errors/)).toBeVisible();
    await user.click((await screen.findAllByRole("treeitem", { name: /^truthy/ }))[0]!);
    await user.keyboard("{Delete}");
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(texts).toHaveLength(2);
  });

  it("ticks nothing while the text does not run, and runs it again once it does", async () => {
    const { user } = setup(ORDER, { autoPlay: true });
    const tick = () => Number(/\d+/.exec(screen.getByLabelText("Tick").textContent ?? "")![0]);
    await waitFor(() => expect(tick()).toBeGreaterThan(0));
    await user.click(screen.getByRole("tab", { name: "Text" }));
    const text = screen.getByRole("textbox", { name: "Behavior text" });
    await user.type(text, "x(");
    await screen.findByRole("list", { name: "Diagnostics" });
    const stopped = tick();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(tick()).toBe(stopped);
    await user.type(text, "{Backspace}{Backspace}");
    await waitFor(() => expect(screen.queryByRole("list", { name: "Diagnostics" })).toBeNull());
    await waitFor(() => expect(tick()).toBeGreaterThan(0));
  });

  it("keeps what was typed when the tab changes before the text is parsed", async () => {
    const { user, texts } = setup(ORDER);
    await user.click(screen.getByRole("tab", { name: "Text" }));
    await user.type(screen.getByRole("textbox", { name: "Behavior text" }), "# note");
    await user.click(screen.getByRole("tab", { name: "Diagram" }));
    await user.click(screen.getByRole("tab", { name: "Text" }));
    expect(screen.getByRole("textbox", { name: "Behavior text" })).toHaveValue(
      `${ORDER.text}# note`,
    );
    expect(texts.at(-1)).toBe(`${ORDER.text}# note`);
  });

  it("keeps the text's own field across tab changes, and its undo history with it", async () => {
    const { user } = setup(ORDER);
    await user.click(screen.getByRole("tab", { name: "Text" }));
    const field = screen.getByRole("textbox", { name: "Behavior text" });
    await user.click(screen.getByRole("tab", { name: "Diagram" }));
    expect(screen.queryByRole("textbox", { name: "Behavior text" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Text" }));
    expect(screen.getByRole("textbox", { name: "Behavior text" })).toBe(field);
  });

  it("parses a file replacing the text at once, whatever typing left waiting", async () => {
    const { user } = setup(ORDER);
    await user.click(screen.getByRole("tab", { name: "Text" }));
    await user.type(screen.getByRole("textbox", { name: "Behavior text" }), "x(");
    await fileMenu(user, "New");
    await user.click(await screen.findByRole("button", { name: /^Discard/ }));
    expect(screen.getByRole("textbox", { name: "Behavior text" })).toHaveValue("");
    await new Promise((resolve) => setTimeout(resolve, REPARSE_DELAY_MS * 2));
    expect(screen.getByRole("textbox", { name: "Behavior text" })).toHaveValue("");
    // What the typed `x(` on line 11 broke is no longer reported.
    expect(screen.queryByText(/^11:/)).toBeNull();
  });

  it("writes a store key from its control, through the runtime", async () => {
    const { user, runtime } = setup(GREET);
    await user.click(screen.getByRole("tab", { name: "Store" }));
    const visible = await screen.findByRole("switch", { name: "person/visible" });
    expect(visible).not.toBeChecked();
    await user.click(visible);
    await waitFor(() => expect(visible).toBeChecked());
    expect(await runtime.read("person/visible")).toEqual({ bool: true });
    expect(screen.getByRole("slider", { name: "rig/arm_raise" })).toHaveValue("0");
  });

  it("marks the file dirty, and asks before discarding the change", async () => {
    const { user } = setup(SMILE);
    expect(screen.queryByText("(unsaved changes)")).toBeNull();
    await user.click(await screen.findByRole("treeitem", { name: /^cheeks: / }));
    await user.click(screen.getByRole("button", { name: "Move up" }));
    expect(screen.getByText("(unsaved changes)")).toBeTruthy();
    await fileMenu(user, "New");
    expect(screen.getByRole("alert")).toHaveTextContent("Discard unsaved changes?");
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByText("(unsaved changes)")).toBeTruthy();
  });

  it("shows a refused edit until the text is back to the behavior running", async () => {
    const runtime = new MockArora({ store: SMILE.store });
    const calls: string[] = [];
    runtime.edit = () => {
      calls.push("edit");
      return Promise.reject(new Error("the device refused the edit"));
    };
    const { user } = setup(SMILE, { runtime });
    await user.click(await screen.findByRole("button", { name: "Step" }));
    await waitFor(() => expect(screen.getByLabelText("Tick")).toHaveTextContent("tick 1"));
    await user.click(screen.getByRole("treeitem", { name: /^cheeks: / }));
    const b = screen.getByRole("textbox", { name: "b" });
    await user.clear(b);
    await user.type(b, "0.9{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("the device refused the edit");
    await user.clear(screen.getByRole("textbox", { name: "b" }));
    await user.type(screen.getByRole("textbox", { name: "b" }), "0.6{Enter}");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(calls).toEqual(["edit"]);
  });

  it("keeps a tick's failure after a refused edit, when the text is back", async () => {
    const runtime = new MockArora({ store: SMILE.store });
    runtime.edit = () => Promise.reject(new Error("the device refused the edit"));
    const { user } = setup(SMILE, { runtime });
    await user.click(await screen.findByRole("button", { name: "Step" }));
    await waitFor(() => expect(screen.getByLabelText("Tick")).toHaveTextContent("tick 1"));
    await user.click(screen.getByRole("treeitem", { name: /^cheeks: / }));
    await user.clear(screen.getByRole("textbox", { name: "b" }));
    await user.type(screen.getByRole("textbox", { name: "b" }), "0.9{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("the device refused the edit");
    runtime.step = () => Promise.reject(new Error("the tick failed"));
    await user.click(screen.getByRole("button", { name: "Step" }));
    expect(await screen.findByText("the tick failed")).toBeTruthy();
    await user.clear(screen.getByRole("textbox", { name: "b" }));
    await user.type(screen.getByRole("textbox", { name: "b" }), "0.6{Enter}");
    await new Promise((resolve) => setTimeout(resolve, REPARSE_DELAY_MS));
    expect(screen.getByRole("alert")).toHaveTextContent("the tick failed");
  });

  it("shows what an edit wrote to the store without a tick", async () => {
    const runtime = new MockArora({ store: SMILE.store });
    const edit = runtime.edit.bind(runtime);
    // As a device applying the call with a step at zero dt.
    runtime.edit = async (diff) => {
      await edit(diff);
      await runtime.write("rig/cheek_raise", { f64: 0.42 });
    };
    const { user } = setup(SMILE, { runtime });
    await user.click(await screen.findByRole("button", { name: "Step" }));
    await waitFor(() => expect(screen.getByLabelText("Tick")).toHaveTextContent("tick 1"));
    await user.click(screen.getByRole("treeitem", { name: /^cheeks: / }));
    const b = screen.getByRole("textbox", { name: "b" });
    await user.clear(b);
    await user.type(b, "0.9{Enter}");
    await user.click(screen.getByRole("tab", { name: "Store" }));
    const store = screen.getByRole("region", { name: "Store" });
    await waitFor(() =>
      expect(within(store).getByRole("status", { name: "rig/cheek_raise" })).toHaveTextContent(
        "0.42",
      ),
    );
    expect(screen.getByLabelText("Tick")).toHaveTextContent("tick 1");
  });

  it("edits the behavior running when the text changes, and starts it afresh on Reset", async () => {
    const runtime = new MockArora({ store: SMILE.store });
    const calls: string[] = [];
    const start = runtime.start.bind(runtime);
    const edit = runtime.edit.bind(runtime);
    runtime.start = (loaded) => {
      calls.push("start");
      return start(loaded);
    };
    runtime.edit = (diff) => {
      calls.push(`edit ${JSON.stringify(Object.keys(diff))}`);
      return edit(diff);
    };
    const { user } = setup(SMILE, { runtime });
    await user.click(await screen.findByRole("button", { name: "Step" }));
    await waitFor(() => expect(screen.getByLabelText("Tick")).toHaveTextContent("tick 1"));
    await user.click(screen.getByRole("treeitem", { name: /^cheeks: / }));
    const b = screen.getByRole("textbox", { name: "b" });
    await user.clear(b);
    await user.type(b, "0.9{Enter}");
    await waitFor(() => expect(calls).toEqual(["start", 'edit ["bind"]']));
    // The edit goes on from the tick it reached.
    await user.click(screen.getByRole("button", { name: "Step" }));
    await waitFor(() => expect(screen.getByLabelText("Tick")).toHaveTextContent("tick 2"));
    await user.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(calls.at(-1)).toBe("start"));
  });

  it("opens a graph file as text, saves it as another format, and refuses one that cannot hold it", async () => {
    const greet = language.resolve(language.parse(GREET.text).document, MATH_FUNCTIONS);
    const json = language.writeFile(greet, "json", MATH_FUNCTIONS);
    if ("problems" in json) throw new Error("greet writes as JSON");
    const written: { name: string; text: string }[] = [];
    const handle = (name: string, text = "") => ({
      name,
      // jsdom's File reads no text: the file as the editor reads it.
      getFile: () => Promise.resolve({ name, text: () => Promise.resolve(text) }),
      createWritable: () =>
        Promise.resolve({
          write: (data: string) => {
            written.push({ name, text: data });
            return Promise.resolve();
          },
          close: () => Promise.resolve(),
        }),
    });
    vi.stubGlobal("showOpenFilePicker", () => Promise.resolve([handle("greet.json", json.text)]));
    vi.stubGlobal("showSaveFilePicker", (options: { suggestedName: string }) =>
      Promise.resolve(handle(options.suggestedName)),
    );
    const { user, texts } = setup(SMILE);
    await screen.findByRole("tree", { name: "Behavior diagram" });
    // The example's comments stay in its text: a graph file has none.
    await fileMenu(user, "Save as…");
    await user.click(screen.getByRole("button", { name: "Graph, JSON" }));
    await waitFor(() => expect(written.at(-1)?.name).toBe("smile.json"));
    expect(screen.getByText(/keeps no comments/)).toHaveAttribute("role", "status");

    await fileMenu(user, "Open…");
    await waitFor(() => expect(texts.at(-1)).toContain("fresh: not(x: {social/greeted})"));
    expect(screen.getByText("greet.json")).toBeTruthy();

    await fileMenu(user, "Save as…");
    await user.click(screen.getByRole("button", { name: "Graph, YAML" }));
    await waitFor(() => expect(written.at(-1)?.name).toBe("greet.yaml"));
    expect(written.at(-1)?.text).toContain("- id: fresh\n  function: not\n");
    expect(screen.queryByText(/keeps no comments/)).toBeNull();

    await fileMenu(user, "Save as…");
    await user.click(screen.getByRole("button", { name: "Groot XML" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Groot XML cannot hold this behavior: Groot holds no node outside the tree",
    );
    expect(written).toHaveLength(2);
  });

  it("saves a graph file from the text as typed, before it is parsed again", async () => {
    const written: string[] = [];
    vi.stubGlobal("showSaveFilePicker", (options: { suggestedName: string }) =>
      Promise.resolve({
        name: options.suggestedName,
        createWritable: () =>
          Promise.resolve({
            write: (data: string) => {
              written.push(data);
              return Promise.resolve();
            },
            close: () => Promise.resolve(),
          }),
      }),
    );
    const { user } = setup(SMILE);
    await user.click(screen.getByRole("tab", { name: "Text" }));
    await user.type(screen.getByRole("textbox", { name: "Behavior text" }), "late: not(x: true)\n");
    await fileMenu(user, "Save as…");
    await user.click(screen.getByRole("button", { name: "Graph, JSON" }));
    await waitFor(() => expect(written).toHaveLength(1));
    expect(written[0]).toContain('"id": "late"');
    expect(screen.queryByText("(unsaved changes)")).toBeNull();
  });

  it("downloads a file named without an extension under the extension of its format", async () => {
    const downloads: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download);
    });
    const { createObjectURL, revokeObjectURL } = URL;
    URL.createObjectURL = () => "blob:behavior";
    URL.revokeObjectURL = () => undefined;
    const { user } = setup(ORDER, { fileName: "draft" });
    await screen.findByRole("tree", { name: "Behavior diagram" });
    await fileMenu(user, "Save");
    await waitFor(() => expect(downloads).toEqual(["draft.bt"]));
    expect(screen.getByText("draft.bt")).toBeTruthy();
    click.mockRestore();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
  });

  it("opens a graph file with the functions the runtime says once the picker returns", async () => {
    const greet = language.resolve(language.parse(GREET.text).document, MATH_FUNCTIONS);
    const json = language.writeFile(greet, "json", MATH_FUNCTIONS);
    if ("problems" in json) throw new Error("greet writes as JSON");
    const runtime = new MockArora({ store: GREET.store });
    let said: (functions: MethodSignature[]) => void = () => {};
    const saying = new Promise<MethodSignature[]>((resolve) => (said = resolve));
    runtime.functions = () => saying;
    let pick: (handles: unknown[]) => void = () => {};
    vi.stubGlobal(
      "showOpenFilePicker",
      () => new Promise((resolve) => (pick = resolve)),
    );
    const { user, texts } = setup(SMILE, { runtime });
    await fileMenu(user, "Open…");
    said(MATH_FUNCTIONS);
    pick([
      {
        name: "greet.json",
        getFile: () =>
          Promise.resolve({ name: "greet.json", text: () => Promise.resolve(json.text) }),
      },
    ]);
    await waitFor(() => expect(texts.at(-1)).toContain("fresh: not(x: {social/greeted})"));
  });

  it("resolves a graph file opened against the functions the runtime said for it", async () => {
    const greet = language.resolve(language.parse(GREET.text).document, MATH_FUNCTIONS);
    const json = language.writeFile(greet, "json", MATH_FUNCTIONS);
    if ("problems" in json) throw new Error("greet writes as JSON");
    const runtime = new MockArora({ store: GREET.store });
    // Its first answer lists nothing; asked again, it lists its functions.
    let asked = 0;
    runtime.functions = () => Promise.resolve(asked++ === 0 ? [] : MATH_FUNCTIONS);
    vi.stubGlobal("showOpenFilePicker", () =>
      Promise.resolve([
        {
          name: "greet.json",
          getFile: () =>
            Promise.resolve({ name: "greet.json", text: () => Promise.resolve(json.text) }),
        },
      ]),
    );
    const { user, texts } = setup(SMILE, { runtime });
    await fileMenu(user, "Open…");
    await waitFor(() => expect(texts.at(-1)).toContain("fresh: not(x: {social/greeted})"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Step" })).toBeEnabled());
  });

  it("keeps the functions a file opened with when the first answer comes after", async () => {
    const greet = language.resolve(language.parse(GREET.text).document, MATH_FUNCTIONS);
    const json = language.writeFile(greet, "json", MATH_FUNCTIONS);
    if ("problems" in json) throw new Error("greet writes as JSON");
    const runtime = new MockArora({ store: GREET.store });
    // The first answer comes late, and lists nothing; asked again, it lists its functions.
    let first: (functions: MethodSignature[]) => void = () => {};
    let asked = 0;
    runtime.functions = () =>
      asked++ === 0 ? new Promise((resolve) => (first = resolve)) : Promise.resolve(MATH_FUNCTIONS);
    vi.stubGlobal("showOpenFilePicker", () =>
      Promise.resolve([
        {
          name: "greet.json",
          getFile: () =>
            Promise.resolve({ name: "greet.json", text: () => Promise.resolve(json.text) }),
        },
      ]),
    );
    const { user, texts } = setup(SMILE, { runtime });
    await fileMenu(user, "Open…");
    // The open asks in the runtime's queue, behind the first request.
    first([]);
    await waitFor(() => expect(texts.at(-1)).toContain("fresh: not(x: {social/greeted})"));
    await waitFor(() => expect(screen.getByRole("button", { name: "Step" })).toBeEnabled());
  });

  it("opens no graph file whose functions came from a runtime switched away from", async () => {
    const greet = language.resolve(language.parse(GREET.text).document, MATH_FUNCTIONS);
    const json = language.writeFile(greet, "json", MATH_FUNCTIONS);
    if ("problems" in json) throw new Error("greet writes as JSON");
    const first = new MockArora({ store: GREET.store });
    let said: (functions: MethodSignature[]) => void = () => {};
    let asked = 0;
    first.functions = () =>
      asked++ === 0 ? Promise.resolve(MATH_FUNCTIONS) : new Promise((resolve) => (said = resolve));
    vi.stubGlobal("showOpenFilePicker", () =>
      Promise.resolve([
        {
          name: "greet.json",
          getFile: () =>
            Promise.resolve({ name: "greet.json", text: () => Promise.resolve(json.text) }),
        },
      ]),
    );
    const texts: string[] = [];
    const props = {
      language,
      defaultText: SMILE.text,
      fileName: SMILE.file,
      autoPlay: false,
      onTextChange: (t: string) => texts.push(t),
    };
    const user = userEvent.setup();
    const { rerender } = render(<BehaviorEditor {...props} runtime={first} />);
    await fileMenu(user, "Open…");
    rerender(<BehaviorEditor {...props} runtime={new MockArora({ store: GREET.store })} />);
    said(MATH_FUNCTIONS);
    expect(await screen.findByRole("alert")).toHaveTextContent("the runtime changed");
    expect(texts).toEqual([]);
  });

  it("writes no file whose name says another format than the one saved", async () => {
    const written: string[] = [];
    const offered: unknown[] = [];
    vi.stubGlobal("showSaveFilePicker", (options: unknown) => {
      offered.push(options);
      return Promise.resolve({
        name: "tree.bt",
        createWritable: () =>
          Promise.resolve({
            write: (data: string) => {
              written.push(data);
              return Promise.resolve();
            },
            close: () => Promise.resolve(),
          }),
      });
    });
    const { user } = setup(ORDER);
    await screen.findByRole("tree", { name: "Behavior diagram" });
    await fileMenu(user, "Save as…");
    await user.click(screen.getByRole("button", { name: "Graph, JSON" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "tree.bt is not named as Graph, JSON: name it .json",
    );
    expect(offered).toEqual([expect.objectContaining({ excludeAcceptAllOption: true })]);
    expect(written).toEqual([]);
  });

  it("says why the runtime refused the behavior", async () => {
    const refusing: BehaviorRuntime = {
      ...new MockArora(),
      functions: () => Promise.resolve(MATH_FUNCTIONS),
      start: () => Promise.reject(new Error("the device has no interpreter")),
      edit: () => Promise.reject(new Error("not started")),
      step: () => Promise.reject(new Error("not started")),
      write: () => Promise.resolve(),
      read: () => Promise.resolve(null),
      keys: () => Promise.resolve([]),
      stop: () => Promise.resolve(),
    };
    setup(ORDER, { runtime: refusing });
    expect(await screen.findByRole("alert")).toHaveTextContent("the device has no interpreter");
  });

  it("tabs the diagram and the text beside the store on a wide screen", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const { user } = setup(ORDER);
    expect(await screen.findByRole("tree", { name: "Behavior diagram" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Behavior text" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Store" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Text" }));
    expect(screen.getByRole("textbox", { name: "Behavior text" })).toHaveValue(ORDER.text);
    expect(screen.queryByRole("tree", { name: "Behavior diagram" })).toBeNull();
    await act(() => Promise.resolve());
  });
});
