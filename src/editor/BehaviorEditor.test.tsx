// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Example, GREET, ORDER, SMILE } from "../../fixtures/examples";
import { fixtureLanguage } from "../../fixtures/fixture-language";
import type { BehaviorDocument, SourceNode } from "../text/ast";
import { MATH_MODULE_ID } from "../runtime/math-module";
import { MockArora } from "../runtime/mock-arora";
import type { BehaviorRuntime } from "../runtime/runtime";
import { BehaviorEditor, type BehaviorEditorProps } from "./BehaviorEditor";

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
        language={fixtureLanguage()}
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
  /** The document the editor's last change wrote, as the test double encodes it. */
  const written = () => JSON.parse(texts.at(-1)!) as BehaviorDocument;
  return { runtime, texts, user, written };
}

const item = (name: RegExp | string) => screen.getByRole("treeitem", { name });
const names = (nodes: readonly SourceNode[]) => nodes.map((n) => n.function.name);

describe("BehaviorEditor", () => {
  it("draws the tree, and the detached nodes beside it, as a tree of items", async () => {
    setup(GREET);
    const tree = await screen.findByRole("tree", { name: "Behavior diagram" });
    const items = within(tree).getAllByRole("treeitem");
    expect(items).toHaveLength(17);
    expect(items[0]).toHaveAttribute("aria-level", "1");
    expect(item(/^sequence/)).toHaveAttribute("aria-level", "2");
    expect(item(/^raise: damp, detached/)).toBeTruthy();
    expect(item(/^fallback/)).toHaveAttribute("aria-expanded", "true");
  });

  it("steps the behavior and shows what each node did", async () => {
    const { user, runtime } = setup(ORDER);
    await user.click(await screen.findByRole("button", { name: "Step" }));
    await waitFor(() => expect(screen.getByLabelText("Tick")).toHaveTextContent("tick 1"));
    expect(screen.getByLabelText("Root status")).toHaveTextContent("Success");
    expect(item(/^sequence, succeeded/)).toBeTruthy();
    expect(item(/^inc: add, detached, called/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Step" }));
    await waitFor(() => expect(screen.getByLabelText("Tick")).toHaveTextContent("tick 2"));
    expect(await runtime.read("v")).toEqual({ f64: 2 });
  });

  it("selects a node by click, and moves the selection with the arrow keys", async () => {
    const { user } = setup(ORDER);
    await user.click(await screen.findByRole("treeitem", { name: /^sequence/ }));
    const inspector = screen.getByRole("region", { name: "Selected node" });
    expect(within(inspector).getByText("sequence", { selector: "code" })).toBeTruthy();
    expect(item(/^sequence/)).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowRight}");
    expect(screen.getAllByRole("treeitem", { name: /^\{v\} = number/ })[0]).toHaveFocus();
    expect(within(inspector).getByText("{v} = number", { selector: "code" })).toBeTruthy();
    await user.keyboard("{ArrowLeft}");
    expect(item(/^sequence/)).toHaveFocus();
  });

  it("renames a node from the inspector, and its readers follow", async () => {
    const { user, written } = setup(GREET);
    await user.click(await screen.findByRole("treeitem", { name: /^raise: damp/ }));
    const name = screen.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "lift{Enter}");
    const document = written();
    expect(document.nodes[2]?.name?.text).toBe("lift");
    const wave = document.nodes[0]!.children[0]!.children[2]!.children[0]!;
    expect(wave.arguments[0]?.value).toMatchObject({ kind: "node", node: "lift" });
  });

  it("refuses a name another node has", async () => {
    const { user, texts } = setup(GREET);
    await user.click(await screen.findByRole("treeitem", { name: /^raise: damp/ }));
    const name = screen.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "sway{Enter}");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Another node has this name.")).toBeTruthy();
    expect(texts).toEqual([]);
  });

  it("edits a literal argument through the inspector", async () => {
    const { user, written } = setup(SMILE);
    await user.click(await screen.findByRole("treeitem", { name: /^cheek: / }));
    const b = screen.getByRole("textbox", { name: "b" });
    expect(b).toHaveValue("0.6");
    await user.clear(b);
    await user.type(b, "0.9{Enter}");
    expect(written().nodes[4]?.arguments[1]?.value).toMatchObject({ kind: "number", text: "0.9" });
  });

  it("feeds an argument from another node's output", async () => {
    const { user, written } = setup(SMILE);
    await user.click(await screen.findByRole("treeitem", { name: /^cheek: / }));
    await user.selectOptions(screen.getByRole("combobox", { name: "b: source" }), "node");
    await user.selectOptions(screen.getByRole("combobox", { name: "b: node" }), "corner");
    expect(written().nodes[4]?.arguments[1]?.value).toMatchObject({
      kind: "node",
      node: "corner",
      parameter: null,
    });
  });

  it("deletes the selected node with the Delete key, and moves it with Alt and an arrow", async () => {
    const { user, written } = setup(ORDER);
    await user.click((await screen.findAllByRole("treeitem", { name: /^equal/ }))[0]!);
    await user.keyboard("{Delete}");
    expect(names(written().nodes[0]!.children)).toEqual(["number", "number", "equal"]);
    await user.click(screen.getAllByRole("treeitem", { name: /^\{v\} = number/ })[1]!);
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(names(written().nodes[0]!.children)).toEqual(["number", "number", "equal"]);
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
      "number",
      "equal",
      "number",
      "equal",
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
    await user.type(text, "x");
    expect(texts).toEqual([]);
    await waitFor(() => expect(texts).toEqual([`${ORDER.text}x`]));
    const diagnostics = await screen.findByRole("list", { name: "Diagnostics" });
    expect(within(diagnostics).getByRole("button")).toHaveTextContent(
      "the fixture language knows no such text",
    );
    expect(text).toHaveAttribute("aria-invalid", "true");
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
    await user.click(await screen.findByRole("treeitem", { name: /^cheek: / }));
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
      functions: () => Promise.resolve([]),
      start: () => Promise.reject(new Error("the device has no interpreter")),
      step: () => Promise.reject(new Error("not started")),
      write: () => Promise.resolve(),
      read: () => Promise.resolve(null),
      keys: () => Promise.resolve([]),
      stop: () => Promise.resolve(),
    };
    setup(ORDER, {
      runtime: refusing,
      language: { ...fixtureLanguage(), resolve: () => ORDER.loaded },
    });
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
