// @vitest-environment jsdom
import "../../fixtures/dom";
import { cleanup, configure, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GREET, ORDER } from "../../fixtures/examples";
import { loadLanguage } from "../../fixtures/language";
import { DATAFLOW_FUNCTIONS, loadDevice } from "../../fixtures/local-arora";
import { type DeviceModule, createLocalArora } from "../local-arora/local-arora";
import { valueNumber } from "../model/value";
import type { DeviceSession } from "../session/device-session";
import type { BehaviorText } from "../text/language";
import { BehaviorEditor, type BehaviorEditorProps } from "./BehaviorEditor";
import type { BehaviorFile, FileAccess } from "./file-access";
import { reopenPageStore } from "./recent-files";
import type { BehaviorExample } from "./StartScreen";

// The local Arora is a real device stepped in the page, and this host is loaded: wait for it longer.
configure({ asyncUtilTimeout: 5000 });

let language: BehaviorText;
let device: DeviceModule;
beforeAll(async () => {
  language = await loadLanguage();
  device = await loadDevice();
});

/** Every local Arora the tests started, the last the one an editor keeps. */
const locals: DeviceSession[] = [];
/** Start a local Arora seeded as ORDER is, paused so that the test steps it. */
const startLocal = () => {
  const session = createLocalArora(device, language, {
    inputs: ORDER.inputs,
    values: ORDER.values,
    playing: false,
  });
  locals.push(session);
  return session;
};

afterEach(async () => {
  cleanup();
  vi.unstubAllGlobals();
  // Each test starts as a new page: no recent file.
  reopenPageStore();
  for (const session of locals.splice(0)) await session.close();
});

/** The examples a host offers: files, opened on whichever Arora is attached. */
const EXAMPLES: BehaviorExample[] = [
  { title: "Order", fileName: ORDER.file, text: ORDER.text },
  { title: "Greet", fileName: GREET.file, text: GREET.text },
];

/** The editor on a local Arora it starts as it mounts, unless `props` say otherwise. */
function setup(props: Partial<BehaviorEditorProps> = {}) {
  const user = userEvent.setup();
  render(
    <BehaviorEditor language={language} localArora={startLocal} startLocalArora {...props} />,
  );
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
    setup({ examples: EXAMPLES, localArora: undefined, startLocalArora: false });
    const start = screen.getByRole("region", { name: "Open a behavior" });
    expect(within(start).getByRole("button", { name: "New behavior" })).toBeTruthy();
    expect(within(start).getByRole("button", { name: "Open…" })).toBeTruthy();
    // With no Arora, there is no Arora's behavior to open.
    expect(within(start).queryByRole("button", { name: "Open the device's behavior" })).toBeNull();
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

  it("opens an example from the keyboard, runs it on the local Arora, and closes it", async () => {
    const { user } = setup({ examples: EXAMPLES });
    // New, Open, the Arora's behavior once the local Arora is attached, then
    // the examples: every action is reached with Tab.
    await screen.findByRole("button", { name: "Open the device's behavior" });
    await user.tab();
    expect(screen.getByRole("button", { name: "New behavior" })).toHaveFocus();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: /^Order/ })).toHaveFocus();
    await user.keyboard("{Enter}");
    await screen.findByRole("tree", { name: "Behavior diagram" });
    expect(text()).toHaveValue(ORDER.text);
    expect(screen.getByText(ORDER.file)).toBeTruthy();
    // A file opened on the local Arora runs there at once; the page steps it.
    expect(await screen.findByRole("switch", { name: "Live edits" })).toBeChecked();
    const local = locals.at(-1)!;
    const before = valueNumber(await local.read("v"))!;
    await user.click(screen.getByRole("button", { name: "Step" }));
    await waitFor(async () => expect(valueNumber(await local.read("v"))).toBeGreaterThan(before));

    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: "Close" }));
    expect(screen.getByRole("heading", { name: "Open a behavior" })).toHaveFocus();
    // The local Arora stays, running the file as it was left.
    expect(local.state.status).toBe("connected");
  });

  it("with no Arora, edits a file and runs nothing, and starts a local Arora when asked", async () => {
    const { user } = setup({ defaultText: GREET.text, fileName: GREET.file, startLocalArora: false });
    const runsOn = () => screen.getByRole("status", { name: "Runs on" });
    expect(runsOn()).toHaveTextContent("No Arora");
    expect(screen.queryByRole("group", { name: "Playback" })).toBeNull();
    // No function index says what a module call calls: no call is told unknown.
    expect(screen.queryByText(/no function is named/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Start a local Arora" }));
    await waitFor(() => expect(runsOn()).toHaveTextContent("Local Arora"));
    expect(screen.getByRole("group", { name: "Playback" })).toBeTruthy();
    // Started with the file open, the local Arora runs it only when asked.
    const offer = await screen.findByRole("region", { name: "Device's behavior" });
    expect(within(offer).getByRole("button", { name: "Run this file on the device" })).toBeEnabled();
  });

  it("starts a new behavior on the local Arora", async () => {
    const { user } = setup({ fileName: "draft.bt" });
    await user.click(screen.getByRole("button", { name: "New behavior" }));
    expect(text()).toHaveValue("");
    expect(screen.getByText("draft.bt")).toBeTruthy();
  });

  it("asks before closing a file with unsaved changes", async () => {
    const { user } = setup({ examples: EXAMPLES });
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

  it("runs a file opened on the local Arora only once it said its functions", async () => {
    let say: () => void = () => {};
    const said = new Promise<void>((resolve) => (say = resolve));
    const runs: unknown[] = [];
    const held = () => {
      const session = startLocal();
      const { functions, run } = session;
      session.functions = async () => {
        await said;
        return functions.call(session);
      };
      session.run = (loaded) => {
        runs.push(loaded);
        return run.call(session, loaded);
      };
      return session;
    };
    const { user } = setup({ examples: EXAMPLES, localArora: held });
    await screen.findByRole("button", { name: "Open the device's behavior" });
    await user.click(screen.getByRole("button", { name: /^Order/ }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(runs).toEqual([]);
    say();
    await waitFor(() => expect(runs).toHaveLength(1));
    expect(await screen.findByRole("switch", { name: "Live edits" })).toBeChecked();
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
    const first = render(<BehaviorEditor language={language} />);
    await user.click(screen.getByRole("button", { name: "Open…" }));
    await waitFor(() => expect(text()).toHaveValue(GREET.text));
    first.unmount();
    render(<BehaviorEditor language={language} />);
    expect(await screen.findByRole("button", { name: /^greet\.bt/ })).toBeTruthy();
  });

  it("opens on a controlled text that arrives after it mounted, and stays closed once closed", async () => {
    const props = { language, fileName: ORDER.file, onTextChange: () => {} };
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

  it("opens nothing from a picker answered after the host's text arrived", async () => {
    let pick: (handles: unknown[]) => void = () => {};
    vi.stubGlobal("showOpenFilePicker", () => new Promise((resolve) => (pick = resolve)));
    const texts: string[] = [];
    const props = {
      language,
      fileName: ORDER.file,
      onTextChange: (t: string) => texts.push(t),
    };
    const user = userEvent.setup();
    const { rerender } = render(<BehaviorEditor {...props} />);
    await user.click(screen.getByRole("button", { name: "Open…" }));
    rerender(<BehaviorEditor {...props} text={ORDER.text} />);
    await waitFor(() => expect(text()).toHaveValue(ORDER.text));
    pick([handle("greet.bt", GREET.text).handle]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(texts).toEqual([]);
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

/** A host's files, by path: `disk` holds them, `picked` is what its open dialog answers. */
function hostFiles(disk: Map<string, string>, picked: () => string | null) {
  const saves: { path: string; text: string; saveAs: boolean }[] = [];
  const read = (path: string): BehaviorFile & { text: string } => {
    const contents = disk.get(path);
    if (contents === undefined) throw new Error(`${path} is not there`);
    const name = path.split("/").pop()!;
    return { name, format: name.endsWith(".bt") ? "bt" : "json", handle: path, text: contents };
  };
  const access: FileAccess = {
    open: () => {
      const path = picked();
      return Promise.resolve(path === null ? null : read(path));
    },
    reopen: (recent) => Promise.resolve(read(recent.handle as string)),
    save: (written, file, saveAs) => {
      const path = saveAs || typeof file.handle !== "string" ? `/picked/${file.name}` : file.handle;
      saves.push({ path, text: written, saveAs });
      disk.set(path, written);
      return Promise.resolve({ ...file, handle: path });
    },
  };
  return { access, saves };
}

describe("a host's files", () => {
  it("opens and saves through the host, a file by its path", async () => {
    const disk = new Map([["/robot/order.bt", ORDER.text]]);
    const { access, saves } = hostFiles(disk, () => "/robot/order.bt");
    vi.stubGlobal("showOpenFilePicker", () => Promise.reject(new Error("no browser picker")));
    const { user } = setup({ fileAccess: access });
    await user.click(screen.getByRole("button", { name: "Open…" }));
    await waitFor(() => expect(text()).toHaveValue(ORDER.text));

    await user.click(screen.getByRole("tab", { name: "Text" }));
    await user.type(text(), "\n");
    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: "Save" }));
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves[0]).toMatchObject({ path: "/robot/order.bt", saveAs: false });
    expect(disk.get("/robot/order.bt")).toBe(`${ORDER.text}\n`);

    // Reopened from its path, the file is as it is on disk now.
    disk.set("/robot/order.bt", GREET.text);
    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: "Close" }));
    const listed = within(screen.getByRole("region", { name: "Recent" }));
    await user.click(listed.getByRole("button", { name: /^order\.bt/ }));
    await waitFor(() => expect(text()).toHaveValue(GREET.text));
  });

  it("opens the host's file as it mounts, and saves it in place", async () => {
    const disk = new Map([["/robot/greet.bt", GREET.text]]);
    const { access, saves } = hostFiles(disk, () => null);
    const initialFile = { name: "greet.bt", format: "bt" as const, handle: "/robot/greet.bt", text: GREET.text };
    const { user } = setup({ fileAccess: access, initialFile });
    await waitFor(() => expect(text()).toHaveValue(GREET.text));
    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: "Save" }));
    await waitFor(() => expect(saves).toEqual([{ path: "/robot/greet.bt", text: GREET.text, saveAs: false }]));
  });

  it("tells the host when the file holds changes not saved, and when it no longer does", async () => {
    const disk = new Map([["/robot/greet.bt", GREET.text]]);
    const { access } = hostFiles(disk, () => null);
    const initialFile = { name: "greet.bt", format: "bt" as const, handle: "/robot/greet.bt", text: GREET.text };
    const dirty: boolean[] = [];
    const { user } = setup({ fileAccess: access, initialFile, onDirtyChange: (d) => dirty.push(d) });
    await waitFor(() => expect(text()).toHaveValue(GREET.text));
    expect(dirty.at(-1)).toBe(false);
    await user.click(screen.getByRole("tab", { name: "Text" }));
    await user.type(text(), "\n");
    await waitFor(() => expect(dirty.at(-1)).toBe(true));
    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: "Save" }));
    await waitFor(() => expect(dirty.at(-1)).toBe(false));
    // Edited again, then closed: the changes are discarded, and none is held any more.
    await user.type(text(), "\n");
    await waitFor(() => expect(dirty.at(-1)).toBe(true));
    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: "Close" }));
    await user.click(await screen.findByRole("button", { name: /^Discard/ }));
    await waitFor(() => expect(dirty.at(-1)).toBe(false));
    expect(screen.getByRole("button", { name: "Open…" })).toBeTruthy();
  });

  it("keeps the text the editor started on once edited, the host's graph file opening over nothing", async () => {
    const graph = language.resolve(language.parse(GREET.text).document, DATAFLOW_FUNCTIONS).graph;
    const initialFile = { name: "greet.json", format: "json" as const, handle: "/robot/greet.json", text: JSON.stringify(graph) };
    const { access } = hostFiles(new Map(), () => null);
    const { user } = setup({ fileAccess: access, initialFile, defaultText: "", fileName: "draft.bt", startLocalArora: false });
    await user.click(screen.getByRole("tab", { name: "Text" }));
    await user.type(text(), "succeed");
    await user.click(screen.getByRole("button", { name: "Start a local Arora" }));
    await waitFor(() => expect(screen.getByRole("status", { name: "Runs on" })).toHaveTextContent("Local Arora"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.getByText("draft.bt")).toBeTruthy();
    expect(text()).toHaveValue("succeed");
  });

  it("says why the host's file did not open over the text the editor started on", async () => {
    const initialFile = { name: "broken.json", format: "json" as const, handle: "/robot/broken.json", text: "{ not json" };
    const { access } = hostFiles(new Map(), () => null);
    setup({ fileAccess: access, initialFile, defaultText: "", fileName: "draft.bt" });
    expect(await screen.findByRole("alert")).toHaveTextContent(/broken\.json/);
    expect(screen.getByText("draft.bt")).toBeTruthy();
  });

  it("takes the host's file over the text the editor starts on", async () => {
    const disk = new Map([["/robot/greet.bt", GREET.text]]);
    const { access, saves } = hostFiles(disk, () => null);
    const initialFile = { name: "greet.bt", format: "bt" as const, handle: "/robot/greet.bt", text: GREET.text };
    const { user } = setup({ fileAccess: access, initialFile, defaultText: GREET.text });
    await waitFor(() => expect(screen.getByText("greet.bt")).toBeTruthy());
    await user.click(screen.getByRole("button", { name: "File" }));
    await user.click(screen.getByRole("menuitem", { name: "Save" }));
    await waitFor(() => expect(saves).toEqual([{ path: "/robot/greet.bt", text: GREET.text, saveAs: false }]));
  });

  it("opens the host's graph file once an Arora is attached, unless the person opened another meanwhile", async () => {
    const graph = language.resolve(language.parse(GREET.text).document, DATAFLOW_FUNCTIONS).graph;
    const initialFile = {
      name: "greet.json",
      format: "json" as const,
      handle: "/robot/greet.json",
      text: JSON.stringify(graph),
    };
    const { access } = hostFiles(new Map(), () => null);
    const runsOn = () => screen.getByRole("status", { name: "Runs on" });

    // Waiting for an Arora, the person starts a new behavior: the Arora attaching later replaces nothing.
    const first = setup({ fileAccess: access, initialFile, startLocalArora: false, fileName: "draft.bt" });
    await first.user.click(screen.getByRole("button", { name: "New behavior" }));
    await first.user.click(screen.getByRole("tab", { name: "Text" }));
    await first.user.type(text(), "succeed");
    await first.user.click(screen.getByRole("button", { name: "Start a local Arora" }));
    await waitFor(() => expect(runsOn()).toHaveTextContent("Local Arora"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(screen.getByText("draft.bt")).toBeTruthy();
    expect(text()).toHaveValue("succeed");
    cleanup();

    // Left alone, it opens as the Arora attaches.
    setup({ fileAccess: access, initialFile });
    await waitFor(() => expect(screen.getByText("greet.json")).toBeTruthy());
  });

  it("opens the host's file it mounted with, another given before it opens notwithstanding", async () => {
    const fileOf = (name: string, source: string) => ({
      name,
      format: "json" as const,
      handle: `/robot/${name}`,
      text: JSON.stringify(language.resolve(language.parse(source).document, DATAFLOW_FUNCTIONS).graph),
    });
    const { access } = hostFiles(new Map(), () => null);
    const props = { language, localArora: startLocal, startLocalArora: true, fileAccess: access };
    // The local Arora attaches after the host gave another file: the first is the one read.
    const { rerender } = render(<BehaviorEditor {...props} initialFile={fileOf("greet.json", GREET.text)} />);
    rerender(<BehaviorEditor {...props} initialFile={fileOf("order.json", ORDER.text)} />);
    await waitFor(() => expect(screen.getByText("greet.json")).toBeTruthy());
    expect(screen.queryByText("order.json")).toBeNull();
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
