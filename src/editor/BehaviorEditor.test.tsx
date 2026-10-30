// @vitest-environment jsdom
import "../../fixtures/dom";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { type Example, GREET, ORDER, RETURN_VALUES, SMILE } from "../../fixtures/examples";
import { loadLanguage } from "../../fixtures/language";
import { DATAFLOW_FUNCTIONS, loadDevice, localArora } from "../../fixtures/local-arora";
import { isEmptyDiff } from "../model/graph";
import type { MethodSignature } from "../model/signature";
import { valueNumber } from "../model/value";
import type { BehaviorDocument, SourceNode } from "../text/ast";
import type { BehaviorText } from "../text/language";
import { DATAFLOW_MODULE_ID, createLocalArora } from "../local-arora/local-arora";
import type { DeviceSession } from "../session/device-session";
import { BehaviorEditor, type BehaviorEditorProps, REPARSE_DELAY_MS } from "./BehaviorEditor";
import { reopenPageStore } from "./recent-files";

let language: BehaviorText;
beforeAll(async () => {
  language = await loadLanguage();
});

const sessions: DeviceSession[] = [];
afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  reopenPageStore();
  for (const session of sessions.splice(0)) await session.close();
});

/** A local Arora seeded as `example` is, paused, closed after the test. */
async function arora(example: Example, options: Parameters<typeof localArora>[1] = {}) {
  const session = await localArora(example, options);
  sessions.push(session);
  return session;
}

/**
 * The editor over `example`, controlled: the text lives in the test's state,
 * and every change the editor makes is recorded in `texts`. It works on a
 * local Arora seeded as the example is, paused, unless `props` give a session.
 */
async function setup(example: Example, props: Partial<BehaviorEditorProps> = {}) {
  const session = props.session ?? (await arora(example));
  const texts: string[] = [];
  function Host() {
    const [text, setText] = useState(example.text);
    return (
      <BehaviorEditor
        language={language}
        session={session}
        text={text}
        onTextChange={(next) => {
          texts.push(next);
          setText(next);
        }}
        fileName={example.file}
        moduleNames={{ [DATAFLOW_MODULE_ID]: "dataflow" }}
        {...props}
      />
    );
  }
  const user = userEvent.setup();
  render(<Host />);
  /** The document of the text the editor's last change wrote. */
  const written = (): BehaviorDocument => language.parse(texts.at(-1)!).document;
  return { session, texts, user, written };
}

/** The Arora's tick, as the header shows it; `null` before the trace reported. */
function deviceTick(): number | null {
  const shown = /\d+/.exec(screen.getByLabelText("Device tick").textContent ?? "");
  return shown ? Number(shown[0]) : null;
}

/** Wait until the Arora runs the file: the editor's changes go to it. */
const running = () => screen.findByRole("switch", { name: "Live edits" });

/** Choose `entry` from the File menu. */
async function fileMenu(user: ReturnType<typeof userEvent.setup>, entry: string) {
  await user.click(screen.getByRole("button", { name: "File" }));
  await user.click(screen.getByRole("menuitem", { name: entry }));
}

const item = (name: RegExp | string) => screen.getByRole("treeitem", { name });
const names = (nodes: readonly SourceNode[]) => nodes.map((n) => n.call.function.name.text);

describe("BehaviorEditor", () => {
  it("draws the tree, and the detached nodes beside it, as a tree of items", async () => {
    await setup(GREET);
    const tree = await screen.findByRole("tree", { name: "Behavior diagram" });
    const items = within(tree).getAllByRole("treeitem");
    expect(items).toHaveLength(16);
    expect(items[0]).toHaveAttribute("aria-level", "1");
    expect(item(/^sequence/)).toHaveAttribute("aria-level", "2");
    expect(item(/^fresh: not, detached/)).toBeTruthy();
    expect(items[0]).toHaveAccessibleName(/^fallback/);
    expect(items[0]).toHaveAttribute("aria-expanded", "true");
  });

  it("describes a node by its outputs", async () => {
    await setup(SMILE);
    const mouth = await screen.findByRole("treeitem", { name: /^mouth: / });
    expect(mouth).toHaveAccessibleDescription("{rig/mouth_corner} ← _ret state");
  });

  it("steps the behavior and shows what each node did", async () => {
    const { user, session } = await setup(ORDER);
    await running();
    await user.click(screen.getByRole("button", { name: "Step" }));
    await waitFor(() => expect(deviceTick()).not.toBeNull());
    const first = deviceTick()!;
    expect(screen.getByLabelText("Root status")).toHaveTextContent("Success");
    expect(item(/^sequence, succeeded/)).toBeTruthy();
    // The load and the trace's start each apply with a step of the device's: v
    // counts those ticks too.
    const v = valueNumber(await session.read("v"))!;
    await waitFor(() => expect(item(/^inc: add, detached, called, /)).toHaveAccessibleName(new RegExp(`value ${v}$`)));
    await user.click(screen.getByRole("button", { name: "Step" }));
    await waitFor(() => expect(deviceTick()).toBe(first + 1));
    expect(await session.read("v")).toEqual({ f32: v + 1 });
  });

  it("tells a detached node whose value changed from one that ran to the same value", async () => {
    const { user, session } = await setup(RETURN_VALUES);
    await running();
    await user.click(screen.getByRole("button", { name: "Step" }));
    await waitFor(() => expect(deviceTick()).not.toBeNull());
    // A little farther, and still near: the distance's readers run, `near` to the same value.
    await session.write("sensor/distance", { f32: 0.35 });
    await user.click(screen.getByRole("button", { name: "Step" }));
    await waitFor(() => expect(item(/^near: /)).toHaveAccessibleName(/called, same value, value true$/));
    expect(item(/^cm: /)).toHaveAccessibleName(/called, value changed, value 35$/);
    await user.click(screen.getByRole("button", { name: "Step" }));
    await waitFor(() =>
      expect(item(/^cm: /)).toHaveAccessibleName(/cache hit, not called, value 35$/),
    );
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
      await setup(GREET);
      // Once the Arora's functions arrive, the nodes take their final widths.
      await waitFor(() => expect(item(/^\{rig\/arm_wave\} = multiply/)).toHaveAttribute("data-key"));
      await waitFor(() => {
        const root = screen.getAllByRole("treeitem", { name: /^fallback/ })[0]!;
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
    const { user } = await setup(ORDER);
    await user.click(await screen.findByRole("treeitem", { name: /^sequence/ }));
    const inspector = screen.getByRole("region", { name: "Selected node" });
    expect(within(inspector).getByText("sequence", { selector: "code" })).toBeTruthy();
    expect(item(/^sequence/)).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowRight}");
    expect(screen.getAllByRole("treeitem", { name: /^\{v\} = add/ })[0]).toHaveFocus();
    expect(within(inspector).getByText("{v} = add", { selector: "code" })).toBeTruthy();
    await user.keyboard("{ArrowLeft}");
    expect(item(/^sequence/)).toHaveFocus();
  });

  it("renames a node from the inspector, and its readers follow", async () => {
    const { user, written } = await setup(GREET);
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
    const { user, texts } = await setup(SMILE);
    await user.click(await screen.findByRole("treeitem", { name: /^cheeks: / }));
    const name = screen.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "amount{Enter}");
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Another node has this name.")).toBeTruthy();
    expect(texts).toEqual([]);
  });

  it("edits a literal argument through the inspector", async () => {
    const { user, written } = await setup(SMILE);
    await user.click(await screen.findByRole("treeitem", { name: /^cheeks: / }));
    const b = screen.getByRole("textbox", { name: "operand_1" });
    expect(b).toHaveValue("0.6");
    await user.clear(b);
    await user.type(b, "0.9{Enter}");
    expect(written().nodes[4]?.call.arguments[1]?.value.kind).toEqual({
      type: "number",
      text: "0.9",
      suffix: "f32",
    });
  });

  it("feeds an argument from another node's output", async () => {
    const { user, written } = await setup(SMILE);
    await user.click(await screen.findByRole("treeitem", { name: /^cheeks: / }));
    await user.selectOptions(screen.getByRole("combobox", { name: "operand_1: source" }), "node");
    await user.selectOptions(screen.getByRole("combobox", { name: "operand_1: node" }), "corner");
    expect(written().nodes[4]?.call.arguments[1]?.value.kind).toMatchObject({
      type: "port",
      node: { text: "corner" },
      parameter: { text: "_ret" },
    });
  });

  it("writes a store key `{key}` cannot hold in its quoted form", async () => {
    const { user, texts } = await setup(SMILE);
    await user.click(await screen.findByRole("treeitem", { name: /^cheeks: / }));
    await user.selectOptions(screen.getByRole("combobox", { name: "operand_1: source" }), "key");
    const key = screen.getByRole("combobox", { name: "operand_1: store key" });
    await user.clear(key);
    await user.type(key, "face/a key{Enter}");
    expect(texts.at(-1)).toContain(
      'cheeks: {rig/cheek_raise} = multiply(operand_0: @amount._ret, operand_1: {"face/a key"})',
    );
  });

  it("deletes the selected node with the Delete key, and moves it with Alt and an arrow", async () => {
    const { user, written } = await setup(ORDER);
    await user.click((await screen.findAllByRole("treeitem", { name: /^equal/ }))[0]!);
    await user.keyboard("{Delete}");
    expect(names(written().nodes[0]!.children)).toEqual(["add", "add", "equal"]);
    await user.click(screen.getAllByRole("treeitem", { name: /^\{v\} = add/ })[1]!);
    await user.keyboard("{Alt>}{ArrowUp}{/Alt}");
    expect(names(written().nodes[0]!.children)).toEqual(["add", "add", "equal"]);
  });

  it("adds a child from the palette, searching it by name", async () => {
    const { user, written } = await setup(ORDER);
    await user.click(await screen.findByRole("treeitem", { name: /^sequence/ }));
    await user.click(screen.getByRole("button", { name: "Add child" }));
    const search = screen.getByRole("searchbox", { name: "Add child" });
    expect(search).toHaveFocus();
    await user.type(search, "succ");
    const group = screen.getByRole("region", { name: "Behavior tree" });
    await user.click(within(group).getByRole("button", { name: /^succeed/ }));
    expect(names(written().nodes[0]!.children)).toEqual([
      "add",
      "equal",
      "add",
      "equal",
      "succeed",
    ]);
  });

  it("folds a node, hiding its subtree", async () => {
    const { user } = await setup(GREET);
    const before = (await screen.findAllByRole("treeitem")).length;
    const parallel = screen.getAllByRole("treeitem", { name: /^parallel/ })[0]!;
    expect(parallel).toHaveAttribute("aria-level", "3");
    expect(parallel).toHaveAttribute("aria-posinset", "3");
    expect(parallel).toHaveAttribute("aria-setsize", "4");
    await user.click(parallel);
    await user.keyboard("{ArrowLeft}");
    expect(screen.getAllByRole("treeitem")).toHaveLength(before - 5);
    expect(screen.getAllByRole("treeitem", { name: /^parallel/ })[0]).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await user.keyboard("{ArrowRight}");
    expect(screen.getAllByRole("treeitem")).toHaveLength(before);
  });

  it("parses the text again once typing pauses, and lists what it found", async () => {
    const { user, texts } = await setup(ORDER);
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
    const { user, texts } = await setup(ORDER);
    await user.click(screen.getByRole("tab", { name: "Text" }));
    await user.type(screen.getByRole("textbox", { name: "Behavior text" }), "x(");
    await user.click(screen.getByRole("tab", { name: "Diagram" }));
    expect(await screen.findByText(/^The text has errors/)).toBeVisible();
    await user.click((await screen.findAllByRole("treeitem", { name: /^equal/ }))[0]!);
    await user.keyboard("{Delete}");
    expect(screen.getByRole("button", { name: "Delete" })).toBeDisabled();
    expect(texts).toHaveLength(2);
  });

  it("keeps the Arora on the file as it last ran while the text has errors, and edits it once it runs", async () => {
    const session = await arora(ORDER, { playing: true });
    const edits: string[] = [];
    const edit = session.edit.bind(session);
    session.edit = (diff, next, options) => {
      if (!isEmptyDiff(diff)) edits.push("edit");
      return edit(diff, next, options);
    };
    const { user } = await setup(ORDER, { session });
    await running();
    await waitFor(() => expect(deviceTick()).toBeGreaterThan(0));
    await user.click(screen.getByRole("tab", { name: "Text" }));
    const text = screen.getByRole("textbox", { name: "Behavior text" });
    await user.type(text, "x(");
    await screen.findByRole("list", { name: "Diagnostics" });
    const banner = await screen.findByRole("region", { name: "Device's behavior" });
    expect(within(banner).getByRole("status")).toHaveTextContent(
      "The device goes on running this file as it last ran: your changes are not sent.",
    );
    // The Arora steps on, the file as it last ran.
    const held = deviceTick()!;
    await waitFor(() => expect(deviceTick()).toBeGreaterThan(held));
    await user.type(text, "{Backspace}{Backspace}");
    await waitFor(() => expect(screen.queryByRole("list", { name: "Diagnostics" })).toBeNull());
    await waitFor(() => expect(screen.queryByRole("region", { name: "Device's behavior" })).toBeNull());
    expect(edits).toEqual([]);
  });

  it("keeps what was typed when the tab changes before the text is parsed", async () => {
    const { user, texts } = await setup(ORDER);
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
    const { user } = await setup(ORDER);
    await user.click(screen.getByRole("tab", { name: "Text" }));
    const field = screen.getByRole("textbox", { name: "Behavior text" });
    await user.click(screen.getByRole("tab", { name: "Diagram" }));
    expect(screen.queryByRole("textbox", { name: "Behavior text" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Text" }));
    expect(screen.getByRole("textbox", { name: "Behavior text" })).toBe(field);
  });

  it("parses a file replacing the text at once, whatever typing left waiting", async () => {
    const { user } = await setup(ORDER);
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

  it("writes a store key from its control, through the Arora", async () => {
    const { user, session } = await setup(GREET);
    await running();
    // The store shows the keys the Arora's last step listed.
    await user.click(screen.getByRole("button", { name: "Step" }));
    await waitFor(() => expect(deviceTick()).not.toBeNull());
    await user.click(screen.getByRole("tab", { name: "Store" }));
    const visible = await screen.findByRole("switch", { name: "person/visible" });
    expect(visible).not.toBeChecked();
    await user.click(visible);
    await waitFor(() => expect(visible).toBeChecked());
    // The device applies the write at its next step.
    expect(visible).toHaveAccessibleDescription("applies at the next step");
    expect(await session.read("person/visible")).toEqual({ bool: false });
    await user.click(screen.getByRole("tab", { name: "Diagram" }));
    await user.click(screen.getByRole("button", { name: "Step" }));
    await waitFor(async () =>
      expect(await session.read("person/visible")).toEqual({ bool: true }),
    );
    await user.click(screen.getByRole("tab", { name: "Store" }));
    // A key the behavior writes, and the device keeps closed, shows as a value.
    expect(screen.getByRole("status", { name: "rig/arm_raise" })).toBeInTheDocument();
  });

  it("marks the file dirty, and asks before discarding the change", async () => {
    const { user } = await setup(SMILE);
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
    const session = await arora(SMILE);
    const calls: string[] = [];
    const edit = session.edit.bind(session);
    session.edit = (diff, next, options) => {
      if (isEmptyDiff(diff)) return edit(diff, next, options);
      calls.push("edit");
      return Promise.reject(new Error("the device refused the edit"));
    };
    const { user } = await setup(SMILE, { session });
    await running();
    await user.click(screen.getByRole("treeitem", { name: /^cheeks: / }));
    const b = screen.getByRole("textbox", { name: "operand_1" });
    await user.clear(b);
    await user.type(b, "0.9{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("the device refused the edit");
    await user.clear(screen.getByRole("textbox", { name: "operand_1" }));
    await user.type(screen.getByRole("textbox", { name: "operand_1" }), "0.6{Enter}");
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(calls).toEqual(["edit"]);
  });

  it("runs the file opened on the Arora, then edits it as the text changes", async () => {
    const session = await arora(SMILE);
    const calls: string[] = [];
    const run = session.run.bind(session);
    const edit = session.edit.bind(session);
    session.run = (loaded) => {
      calls.push("run");
      return run(loaded);
    };
    session.edit = (diff, next, options) => {
      if (!isEmptyDiff(diff)) calls.push(`edit ${JSON.stringify(Object.keys(diff))}`);
      return edit(diff, next, options);
    };
    const { user } = await setup(SMILE, { session });
    await running();
    await user.click(screen.getByRole("button", { name: "Step" }));
    await waitFor(() => expect(deviceTick()).not.toBeNull());
    const tick = deviceTick()!;
    await user.click(screen.getByRole("treeitem", { name: /^cheeks: / }));
    const b = screen.getByRole("textbox", { name: "operand_1" });
    await user.clear(b);
    await user.type(b, "0.9{Enter}");
    await waitFor(() => expect(calls).toEqual(["run", 'edit ["bind"]']));
    // The edit goes on from the tick it reached: the interpreter's tick counts on.
    await user.click(screen.getByRole("button", { name: "Step" }));
    await waitFor(() => expect(deviceTick()).toBeGreaterThan(tick));
  });

  it("opens a graph file as text, saves it as another format, and refuses one that cannot hold it", async () => {
    const greet = language.resolve(language.parse(GREET.text).document, DATAFLOW_FUNCTIONS);
    const json = language.writeFile(greet, "json", DATAFLOW_FUNCTIONS);
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
    const { user, texts } = await setup(SMILE);
    await screen.findByRole("tree", { name: "Behavior diagram" });
    // The example's comments stay in its text: a graph file has none.
    await fileMenu(user, "Save as…");
    await user.click(screen.getByRole("button", { name: "Graph, JSON" }));
    await waitFor(() => expect(written.at(-1)?.name).toBe("smile.json"));
    expect(screen.getByText(/keeps no comments/)).toHaveAttribute("role", "status");

    await fileMenu(user, "Open…");
    await waitFor(() => expect(texts.at(-1)).toContain("fresh: not(in: {social/greeted})"));
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
    const { user } = await setup(SMILE);
    await user.click(screen.getByRole("tab", { name: "Text" }));
    await user.type(screen.getByRole("textbox", { name: "Behavior text" }), "late: not(in: true)\n");
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
    const { user } = await setup(ORDER, { fileName: "draft" });
    await screen.findByRole("tree", { name: "Behavior diagram" });
    await fileMenu(user, "Save");
    await waitFor(() => expect(downloads).toEqual(["draft.bt"]));
    expect(screen.getByText("draft.bt")).toBeTruthy();
    click.mockRestore();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
  });

  it("opens a graph file with the functions the Arora says once the picker returns", async () => {
    const greet = language.resolve(language.parse(GREET.text).document, DATAFLOW_FUNCTIONS);
    const json = language.writeFile(greet, "json", DATAFLOW_FUNCTIONS);
    if ("problems" in json) throw new Error("greet writes as JSON");
    const session = await arora(GREET);
    let said: (functions: MethodSignature[]) => void = () => {};
    const saying = new Promise<MethodSignature[]>((resolve) => (said = resolve));
    session.functions = () => saying;
    let pick: (handles: unknown[]) => void = () => {};
    vi.stubGlobal(
      "showOpenFilePicker",
      () => new Promise((resolve) => (pick = resolve)),
    );
    const { user, texts } = await setup(SMILE, { session });
    await fileMenu(user, "Open…");
    said(DATAFLOW_FUNCTIONS);
    pick([
      {
        name: "greet.json",
        getFile: () =>
          Promise.resolve({ name: "greet.json", text: () => Promise.resolve(json.text) }),
      },
    ]);
    await waitFor(() => expect(texts.at(-1)).toContain("fresh: not(in: {social/greeted})"));
  });

  it("resolves a graph file opened against the functions the Arora said for it", async () => {
    const greet = language.resolve(language.parse(GREET.text).document, DATAFLOW_FUNCTIONS);
    const json = language.writeFile(greet, "json", DATAFLOW_FUNCTIONS);
    if ("problems" in json) throw new Error("greet writes as JSON");
    const session = await arora(GREET);
    // Its first answer lists nothing; asked again, it lists its functions.
    let asked = 0;
    session.functions = () => Promise.resolve(asked++ === 0 ? [] : DATAFLOW_FUNCTIONS);
    vi.stubGlobal("showOpenFilePicker", () =>
      Promise.resolve([
        {
          name: "greet.json",
          getFile: () =>
            Promise.resolve({ name: "greet.json", text: () => Promise.resolve(json.text) }),
        },
      ]),
    );
    const { user, texts } = await setup(SMILE, { session });
    await fileMenu(user, "Open…");
    await waitFor(() => expect(texts.at(-1)).toContain("fresh: not(in: {social/greeted})"));
    // It resolves, and runs on the Arora.
    expect(await running()).toBeChecked();
  });

  it("keeps the functions a file opened with when the first answer comes after", async () => {
    const greet = language.resolve(language.parse(GREET.text).document, DATAFLOW_FUNCTIONS);
    const json = language.writeFile(greet, "json", DATAFLOW_FUNCTIONS);
    if ("problems" in json) throw new Error("greet writes as JSON");
    const session = await arora(GREET);
    // The first answer comes late, and lists nothing; asked again, it lists its functions.
    let first: (functions: MethodSignature[]) => void = () => {};
    let asked = 0;
    session.functions = () =>
      asked++ === 0 ? new Promise((resolve) => (first = resolve)) : Promise.resolve(DATAFLOW_FUNCTIONS);
    vi.stubGlobal("showOpenFilePicker", () =>
      Promise.resolve([
        {
          name: "greet.json",
          getFile: () =>
            Promise.resolve({ name: "greet.json", text: () => Promise.resolve(json.text) }),
        },
      ]),
    );
    const { user, texts } = await setup(SMILE, { session });
    await fileMenu(user, "Open…");
    // The workspace's own first request answers last, and nothing of it shows.
    first([]);
    await waitFor(() => expect(texts.at(-1)).toContain("fresh: not(in: {social/greeted})"));
    // It resolves, and runs on the Arora.
    expect(await running()).toBeChecked();
  });

  it("opens no graph file whose functions came from an Arora switched away from", async () => {
    const greet = language.resolve(language.parse(GREET.text).document, DATAFLOW_FUNCTIONS);
    const json = language.writeFile(greet, "json", DATAFLOW_FUNCTIONS);
    if ("problems" in json) throw new Error("greet writes as JSON");
    const first = await arora(GREET);
    let said: (functions: MethodSignature[]) => void = () => {};
    let asked = 0;
    first.functions = () =>
      asked++ === 0 ? Promise.resolve(DATAFLOW_FUNCTIONS) : new Promise((resolve) => (said = resolve));
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
      onTextChange: (t: string) => texts.push(t),
    };
    const second = await arora(GREET);
    const user = userEvent.setup();
    const { rerender } = render(<BehaviorEditor {...props} session={first} />);
    await fileMenu(user, "Open…");
    rerender(<BehaviorEditor {...props} session={second} />);
    said(DATAFLOW_FUNCTIONS);
    expect(await screen.findByRole("alert")).toHaveTextContent("the Arora changed");
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
    const { user } = await setup(ORDER);
    await screen.findByRole("tree", { name: "Behavior diagram" });
    await fileMenu(user, "Save as…");
    await user.click(screen.getByRole("button", { name: "Graph, JSON" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "tree.bt is not named as Graph, JSON: name it .json",
    );
    expect(offered).toEqual([expect.objectContaining({ excludeAcceptAllOption: true })]);
    expect(written).toEqual([]);
  });

  it("says why the Arora refused the behavior", async () => {
    const session = await arora(ORDER);
    session.run = () => Promise.reject(new Error("the device has no interpreter"));
    await setup(ORDER, { session });
    expect(await screen.findByRole("alert")).toHaveTextContent("the device has no interpreter");
  });

  it("tabs the diagram and the text beside the store on a wide screen", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({
      matches: true,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const { user } = await setup(ORDER);
    expect(await screen.findByRole("tree", { name: "Behavior diagram" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Behavior text" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Store" })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Text" }));
    expect(screen.getByRole("textbox", { name: "Behavior text" })).toHaveValue(ORDER.text);
    expect(screen.queryByRole("tree", { name: "Behavior diagram" })).toBeNull();
    await act(() => Promise.resolve());
  });
});

describe("BehaviorEditor with no Arora", () => {
  it("says so, and starts the local Arora the host offers", async () => {
    const device = await loadDevice();
    const user = userEvent.setup();
    render(
      <BehaviorEditor
        language={language}
        defaultText={ORDER.text}
        fileName={ORDER.file}
        localArora={() => {
          const session = createLocalArora(device, language, {
            inputs: ORDER.inputs,
            values: ORDER.values,
            playing: false,
          });
          sessions.push(session);
          return session;
        }}
      />,
    );
    const runsOn = () => screen.getByRole("status", { name: "Runs on" });
    expect(runsOn()).toHaveTextContent("No Arora");
    expect(screen.queryByRole("group", { name: "Playback" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Start a local Arora" }));
    await waitFor(() => expect(runsOn()).toHaveTextContent("Local Arora"));
    expect(await screen.findByRole("group", { name: "Playback" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start a local Arora" })).toBeNull();
  });

  it("offers no local Arora the host does not", () => {
    render(<BehaviorEditor language={language} defaultText={ORDER.text} />);
    expect(screen.getByRole("status", { name: "Runs on" })).toHaveTextContent("No Arora");
    expect(screen.queryByRole("button", { name: "Start a local Arora" })).toBeNull();
  });

  it("checks no call of a module's function, and still reports what the text breaks", async () => {
    const user = userEvent.setup();
    render(<BehaviorEditor language={language} defaultText={ORDER.text} fileName={ORDER.file} />);
    await screen.findByRole("tree", { name: "Behavior diagram" });
    await new Promise((resolve) => setTimeout(resolve, REPARSE_DELAY_MS));
    // No function index says what `add` or `lessthan` call: nothing about them is an error.
    expect(screen.queryByRole("list", { name: "Diagnostics", hidden: true })).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Text" }));
    await user.type(screen.getByRole("textbox", { name: "Behavior text" }), "x(");
    const diagnostics = await screen.findByRole("list", { name: "Diagnostics" });
    expect(within(diagnostics).getAllByRole("button")[0]).toHaveTextContent(/^11:2 error/);
    expect(within(diagnostics).queryByText(/no function is named/)).toBeNull();
  });
});

describe("BehaviorEditor on a local Arora", () => {
  it("runs a file opened there at once, and steps it as the person plays, pauses, steps and sets the rate", async () => {
    const { user } = await setup(SMILE);
    expect(screen.getByRole("status", { name: "Runs on" })).toHaveTextContent("Local Arora");
    expect(await running()).toBeChecked();
    // Paused, nothing steps until the person does.
    await user.click(screen.getByRole("button", { name: "Step" }));
    await waitFor(() => expect(deviceTick()).not.toBeNull());
    await waitFor(() => expect(item(/^mouth: .*detached, (called|cache hit)/)).toBeTruthy());
    const stepped = deviceTick()!;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(deviceTick()).toBe(stepped);

    await user.click(screen.getByRole("button", { name: "Play" }));
    await waitFor(() => expect(deviceTick()).toBeGreaterThan(stepped + 2));
    expect(screen.getByRole("button", { name: "Step" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Pause" }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const paused = deviceTick()!;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(deviceTick()).toBe(paused);

    // The rate sets each step's length: the device's clock says so.
    await user.selectOptions(screen.getByRole("combobox", { name: "rate" }), "10");
    await user.click(screen.getByRole("button", { name: "Step" }));
    await waitFor(() => expect(deviceTick()).toBe(paused + 1));
    expect(screen.getByLabelText("Step rate")).toHaveTextContent("10 Hz");
  });
});
