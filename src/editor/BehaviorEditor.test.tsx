// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Example, GREET, ORDER, SMILE } from "../../fixtures/examples";
import { MATH_FUNCTIONS, loadLanguage } from "../../fixtures/language";
import type { BehaviorDocument, SourceNode } from "../text/ast";
import type { BehaviorText } from "../text/language";
import { MATH_MODULE_ID } from "../runtime/math-module";
import { MockArora } from "../runtime/mock-arora";
import type { BehaviorRuntime } from "../runtime/runtime";
import { BehaviorEditor, type BehaviorEditorProps } from "./BehaviorEditor";

let language: BehaviorText;
beforeAll(async () => {
  language = await loadLanguage();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
      parameter: null,
    });
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
    expect(texts).toEqual([]);
    await waitFor(() => expect(texts).toEqual([`${ORDER.text}x(`]));
    const diagnostics = await screen.findByRole("list", { name: "Diagnostics" });
    // `(` opens on line 11, the line after the file's last, at column 2.
    expect(within(diagnostics).getAllByRole("button")[0]).toHaveTextContent(/^11:2 error/);
    expect(text).toHaveAttribute("aria-invalid", "true");
  });

  it("edits nothing from the diagram while the text has errors", async () => {
    const { user, texts } = setup(ORDER);
    await user.click(screen.getByRole("tab", { name: "Text" }));
    await user.type(screen.getByRole("textbox", { name: "Behavior text" }), "x(");
    await waitFor(() => expect(texts).toHaveLength(1));
    await user.click(screen.getByRole("tab", { name: "Diagram" }));
    expect(screen.getByText(/^The text has errors/)).toBeVisible();
    await user.click((await screen.findAllByRole("treeitem", { name: /^truthy/ }))[0]!);
    await user.keyboard("{Delete}");
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(texts).toHaveLength(1);
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
    await user.click(screen.getByRole("button", { name: "New" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Discard unsaved changes?");
    await user.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByText("(unsaved changes)")).toBeTruthy();
  });

  it("says why the runtime refused the behavior", async () => {
    const refusing: BehaviorRuntime = {
      ...new MockArora(),
      functions: () => Promise.resolve(MATH_FUNCTIONS),
      start: () => Promise.reject(new Error("the device has no interpreter")),
      step: () => Promise.reject(new Error("not started")),
      write: () => Promise.resolve(),
      read: () => Promise.resolve(null),
      keys: () => Promise.resolve([]),
      stop: () => Promise.resolve(),
    };
    setup(ORDER, { runtime: refusing });
    expect(await screen.findByRole("alert")).toHaveTextContent("the device has no interpreter");
  });

  it("puts the diagram and the text side by side on a wide screen", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    setup(ORDER);
    expect(await screen.findByRole("tree", { name: "Behavior diagram" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Behavior text" })).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull();
    await act(() => Promise.resolve());
  });
});
