import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Graph, isEmptyDiff } from "../model/graph";
import { type NodePath, deleteNode, moveNode, reparent, siblingPath, walk } from "../model/edit";
import type { MethodSignature } from "../model/signature";
import { MockArora } from "../runtime/mock-arora";
import type { BehaviorRuntime } from "../runtime/runtime";
import type { DeviceSession } from "../session/device-session";
import { useSessionState } from "../session/use-device-session";
import type { BehaviorDocument } from "../text/ast";
import type { BehaviorText, Diagnostic } from "../text/language";
import { Diagram, type Drop } from "./Diagram";
import { diagramRows, rowKey } from "./diagram-rows";
import {
  type BehaviorFile,
  openBehaviorFile,
  reopenBehaviorFile,
  saveBehaviorFile,
} from "./file-access";
import { FileBar } from "./FileBar";
import {
  FILE_FORMATS,
  type FileFormat,
  formatOf,
  problemsText,
  withExtension,
} from "./file-formats";
import { functionIndex, missingFunctions } from "./functions";
import { type Edit, Inspector } from "./Inspector";
import { DeviceBanner } from "./DeviceBanner";
import { DeviceBar } from "./DeviceBar";
import { DiscardConfirm } from "./DiscardConfirm";
import { PlaybackBar } from "./PlaybackBar";
import { type RecentFile, useRecentFiles } from "./recent-files";
import { type BehaviorExample, type ExampleFit, StartScreen } from "./StartScreen";
import { behaviorKeys } from "./store-keys";
import { StorePanel } from "./StorePanel";
import { TextView } from "./TextView";
import { useMediaQuery } from "./use-media-query";
import { type DeviceMode, useDeviceMode } from "./use-device-mode";
import { askFunctions, usePlayback, useRuntimeFunctions, whenIdle } from "./use-playback";

export interface BehaviorEditorProps {
  /** The language: its parser, formatter and resolver. */
  language: BehaviorText;
  /**
   * Where the behavior runs with no device attached; a mock device with the
   * math module by default.
   */
  runtime?: BehaviorRuntime;
  /**
   * A session with a device. While it is connected, or lost and connecting
   * again, the editor shows what the device runs and does, and runs the file
   * on it only when the person asks: see the README's "On a device". Every
   * file opened works on the device then, an example as any other.
   */
  session?: DeviceSession | null;
  /** The file's text, for a controlled editor; `onTextChange` receives every change. */
  text?: string;
  /**
   * The text an uncontrolled editor starts from. With neither it nor `text`,
   * the editor opens on its start screen.
   */
  defaultText?: string;
  onTextChange?(text: string): void;
  /** The name a new file is saved under; its extension says its format. */
  fileName?: string;
  /** The behaviors the start screen offers to open; none by default. */
  examples?: readonly BehaviorExample[];
  /** Names to show and write for module ids. */
  moduleNames?: Readonly<Record<string, string>>;
  /** The store keys plotted from the start. */
  plotKeys?: readonly string[];
  /** Whether the behavior ticks as soon as it resolves; otherwise it waits for Play or Step. */
  autoPlay?: boolean;
}

type Tab = "diagram" | "text" | "store";
interface TabInfo {
  id: Tab;
  label: string;
}
const DIAGRAM: TabInfo = { id: "diagram", label: "Diagram" };
const TEXT: TabInfo = { id: "text", label: "Text" };
const STORE: TabInfo = { id: "store", label: "Store" };
/** A wide screen keeps the inspector and the store beside the tabbed views. */
const WIDE_TABS = [DIAGRAM, TEXT];
const NARROW_TABS = [DIAGRAM, TEXT, STORE];

const WIDE = "(min-width: 1100px)";

/** How long typing pauses before the text is parsed again. */
export const REPARSE_DELAY_MS = 250;

/** A file open in the editor: what it opened as, and the example it is, if one. */
interface OpenFile {
  /** Counts the files opened: each opens in a workspace of its own. */
  serial: number;
  file: BehaviorFile;
  /** Its text as it opened. */
  text: string;
  example: BehaviorExample | null;
}

const NO_EXAMPLES: readonly BehaviorExample[] = [];

/** A new file named `name`, in the format its extension says. */
const newFile = (name: string): BehaviorFile => ({
  name,
  format: formatOf(name) ?? "bt",
  handle: null,
});

/**
 * An editor for a behavior: its tree and detached nodes as a diagram, and
 * its file as text, in tabs, either editing the other; run on a device or a
 * mock, its statuses and store live; read from and saved to local files.
 * With no behavior, it shows a start screen: a new behavior, a file to open,
 * the files opened lately, and the host's examples.
 */
export function BehaviorEditor({
  language,
  runtime,
  session = null,
  text: controlled,
  defaultText,
  onTextChange,
  fileName = "behavior.bt",
  examples = NO_EXAMPLES,
  moduleNames,
  plotKeys = [],
  autoPlay = true,
}: BehaviorEditorProps) {
  const host = useMemo(() => runtime ?? new MockArora(), [runtime]);
  const sessionState = useSessionState(session);
  const attached =
    sessionState?.status === "connected" || sessionState?.status === "lost" ? session : null;
  /** The files the editor ran on a device, newest first: the device's behavior opens as one of them when it is. */
  const ran = useRef<RanFile[]>([]);
  // Where a file opens: the device attached, or the editor's runtime. An
  // open finishing late checks it still is.
  const opensOn: Pick<BehaviorRuntime, "functions"> = attached ?? host;
  const shownHost = useRef(opensOn);
  useEffect(() => {
    shownHost.current = opensOn;
  }, [opensOn]);
  const recent = useRecentFiles();
  const serial = useRef(0);
  const [openFile, setOpenFile] = useState<OpenFile | null>(() => {
    const text = controlled ?? defaultText;
    return text === undefined ? null : { serial: 0, file: newFile(fileName), text, example: null };
  });
  // The examples are weighed against the device only while the start screen shows them.
  const fits = useExampleFits(language, attached, openFile ? NO_EXAMPLES : examples, moduleNames);
  const [startError, setStartError] = useState<string | null>(null);
  /** Whether the start screen shows because the person closed a file. */
  const [closed, setClosed] = useState(false);
  /** The view shown, which stays as files open and close. */
  const [tab, setTab] = useState<Tab>("diagram");

  // A controlled editor whose text arrives after it mounted opens on it, as
  // one mounted with it does; one the person closed stays closed.
  useEffect(() => {
    if (controlled === undefined || closed) return;
    setOpenFile((open) => {
      if (open) return open;
      // The host's text replaces the file as an open would: an open asked
      // before it is moot.
      requests.current += 1;
      serial.current += 1;
      return { serial: serial.current, file: newFile(fileName), text: controlled, example: null };
    });
  }, [controlled, closed, fileName]);

  /**
   * Counts what replaces the file open: a file opened, a new one, an example,
   * a close. An open finishing after another of these was asked for is moot.
   */
  const requests = useRef(0);
  const begin = (file: BehaviorFile, text: string, example: BehaviorExample | null = null) => {
    requests.current += 1;
    serial.current += 1;
    setStartError(null);
    setOpenFile({ serial: serial.current, file, text, example });
    onTextChange?.(text);
  };
  /**
   * Open a file, as text: a graph file through the functions of the runtime it
   * opens on. Nothing opens when something else replaced the file meanwhile.
   */
  const openAsText = async (asked: number, opened: BehaviorFile & { text: string }) => {
    let next = opened.text;
    if (opened.format !== "bt") {
      const from = opensOn;
      const functions = await askFunctions(from);
      // Opened with another runtime's functions, the file would name functions
      // the runtime it opens on may not have: it opens nothing.
      if (shownHost.current !== from) {
        throw new Error(`${opened.name} was not opened: the runtime changed while it was`);
      }
      const out = language.openFile(opened.text, opened.format, functions);
      if ("problems" in out) {
        throw new Error(`${opened.name} does not open: ${problemsText(out.problems)}`);
      }
      next = out.text;
    }
    if (requests.current !== asked) return;
    recent.remember(opened, opened.text);
    begin({ name: opened.name, format: opened.format, handle: opened.handle }, next);
  };
  /** Run the open `asked`; its failure is not shown once something else replaced the file. */
  const moot = async (asked: number, open: () => Promise<void>) => {
    try {
      await open();
    } catch (error) {
      if (requests.current === asked) throw error;
    }
  };
  const files: FileActions = {
    recent: recent.files,
    remember: recent.remember,
    create: () => begin(newFile(fileName), ""),
    open: async () => {
      const asked = ++requests.current;
      await moot(asked, async () => {
        const opened = await openBehaviorFile();
        if (opened) await openAsText(asked, opened);
      });
    },
    openRecent: async (entry) => {
      const asked = ++requests.current;
      await moot(asked, async () => openAsText(asked, await reopenBehaviorFile(entry)));
    },
    close: () => {
      requests.current += 1;
      setOpenFile(null);
      setClosed(true);
    },
    openText: (name, text) => begin(newFile(name), text),
    openDevice: async (unchanged = () => true) => {
      const from = attached;
      if (!from) return;
      const asked = ++requests.current;
      // Moot once another file replaced this one, or the device was let go
      // of or replaced: its answer opens nothing, and its failure is not shown.
      const current = () => requests.current === asked && shownHost.current === from;
      /** Open the answer, unless the file changed while it was read: those changes are not discarded unasked. */
      const replace = (file: BehaviorFile, text: string) => {
        if (!unchanged()) {
          throw new Error(
            "The device's behavior was not opened: the file changed while it was read",
          );
        }
        begin(file, text);
      };
      try {
        const read = await from.deviceBehavior();
        if (!current()) return;
        if (!read) throw new Error("The device does not say what it runs");
        const held = ran.current.find((f) => isEmptyDiff(language.diff(f.graph, read.graph)));
        if (held) {
          replace(newFile(held.name), held.text);
          return;
        }
        const functions = await askFunctions(from);
        if (!current()) return;
        const out = language.openFile(JSON.stringify(read.graph), "json", functions);
        if ("problems" in out) {
          throw new Error(`The device's behavior does not open: ${problemsText(out.problems)}`);
        }
        replace(newFile(DEVICE_FILE), out.text);
      } catch (error) {
        if (current()) throw error;
      }
    },
    ask: () => {
      const asked = ++requests.current;
      return () => requests.current === asked;
    },
    ran: ran.current,
  };

  // The runtime an example runs on with no device attached, made when it
  // opens and disposed when it closes. It is made while a device is attached
  // too, idle, so that letting go of the device hands the file to it at once.
  const [made, setMade] = useState<{ serial: number; runtime: BehaviorRuntime } | null>(null);
  const example = openFile?.example ?? null;
  const opened = openFile?.serial ?? -1;
  useEffect(() => {
    if (!example?.runtime) return undefined;
    const created = example.runtime();
    setMade({ serial: opened, runtime: created.runtime });
    // The workspace's stop is queued on the runtime as it unmounts, in this
    // same commit: the runtime goes once that and every call before it ran.
    return () => {
      Promise.resolve()
        .then(() => whenIdle(created.runtime))
        .then(() => created.dispose?.());
    };
  }, [example, opened]);

  if (!openFile) {
    const attempt = (run: () => Promise<void>) => () => {
      setStartError(null);
      run().catch((e: unknown) => setStartError(e instanceof Error ? e.message : String(e)));
    };
    return (
      <div className="be-root">
        <StartScreen
          examples={examples}
          recent={recent.files}
          onNew={files.create}
          onOpen={attempt(files.open)}
          onOpenRecent={(entry) => attempt(() => files.openRecent(entry))()}
          onForget={(entry) => recent.forget(entry.id)}
          onExample={(chosen) => begin(newFile(chosen.fileName), chosen.text, chosen)}
          onOpenDevice={
            sessionState?.status === "connected" ? attempt(files.openDevice) : undefined
          }
          fits={fits}
          error={startError}
          focus={closed}
        />
      </div>
    );
  }
  const active = example?.runtime ? (made?.serial === openFile.serial ? made.runtime : null) : host;
  if (!active) {
    return (
      <div className="be-root">
        <p className="be-fine" role="status">
          {`Opening ${example!.title}…`}
        </p>
      </div>
    );
  }
  return (
    <Workspace
      key={openFile.serial}
      language={language}
      runtime={active}
      open={openFile}
      files={files}
      text={controlled}
      onTextChange={onTextChange}
      moduleNames={moduleNames}
      plotKeys={openFile.example?.plotKeys ?? plotKeys}
      autoPlay={autoPlay}
      device={attached}
      tab={tab}
      onTab={setTab}
    />
  );
}

/**
 * How each of `examples` stands to the device `session` reaches: the
 * functions it calls that the device lacks, and whether it resolves against
 * the device's functions. `null` with no device, and until the device said
 * its functions; each connection asks them again.
 */
function useExampleFits(
  language: BehaviorText,
  session: DeviceSession | null,
  examples: readonly BehaviorExample[],
  moduleNames: Readonly<Record<string, string>> | undefined,
): ReadonlyMap<BehaviorExample, ExampleFit> | null {
  const state = useSessionState(session);
  const connection = state?.status === "connected" ? state : null;
  const [said, setSaid] = useState<{
    session: DeviceSession;
    functions: MethodSignature[];
  } | null>(null);
  useEffect(() => {
    if (!session || !connection) return undefined;
    let current = true;
    askFunctions(session)
      .then((functions) => current && setSaid({ session, functions }))
      // The start screen marks nothing it could not learn; the file opened tells why.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [session, connection]);
  const functions = said && said.session === session ? said.functions : null;
  return useMemo(() => {
    if (!functions) return null;
    const index = functionIndex(language.natives(), functions, moduleNames);
    return new Map(
      examples.map((example) => {
        const parsed = language.parse(example.text);
        const resolved = language.resolve(parsed.document, functions);
        const errors = [...parsed.diagnostics, ...resolved.diagnostics].some(
          (d) => d.severity === "error",
        );
        return [
          example,
          {
            missing: missingFunctions(parsed.document, index),
            runs: !errors && resolved.graph.root !== undefined,
          },
        ];
      }),
    );
  }, [functions, language, examples, moduleNames]);
}

/** What the workspace asks of the editor holding it: the files it opens and remembers. */
interface FileActions {
  recent: readonly RecentFile[];
  remember(file: BehaviorFile, text: string): void;
  create(): void;
  open(): Promise<void>;
  openRecent(entry: RecentFile): Promise<void>;
  close(): void;
  /** Open `text` as a new file named `name`. */
  openText(name: string, text: string): void;
  /**
   * Open the behavior the attached device runs: as the file run there whose
   * graph it is, with its names, or as its graph, each node named by its id.
   * Its answer opens nothing once another file or device replaced the one
   * open, and is refused once `unchanged` says the file open changed since
   * it was asked for.
   */
  openDevice(unchanged?: () => boolean): Promise<void>;
  /**
   * Ask to replace the file, with something read later: whether the ask is
   * still the last, nothing else having replaced the file since.
   */
  ask(): () => boolean;
  /** The files run on a device, newest first, which the workspace adds to. */
  ran: RanFile[];
}

/** A file as it ran on a device: its name, its text, and the graph it resolved to. */
interface RanFile {
  name: string;
  text: string;
  graph: Graph;
}

/** How many files run on a device the editor remembers. */
const RAN_FILES = 10;

/** The name the device's behavior opens under when no file run on it has its graph. */
const DEVICE_FILE = "device.bt";

interface WorkspaceProps {
  language: BehaviorText;
  /** The runtime the file runs on while no device is attached. */
  runtime: BehaviorRuntime;
  open: OpenFile;
  files: FileActions;
  /** The text of a controlled editor. */
  text: string | undefined;
  onTextChange: ((text: string) => void) | undefined;
  moduleNames: Readonly<Record<string, string>> | undefined;
  plotKeys: readonly string[];
  autoPlay: boolean;
  tab: Tab;
  onTab(tab: Tab): void;
  /**
   * The session with the device attached, if one is: the file works on the
   * device, and nothing runs on `runtime`.
   */
  device: DeviceSession | null;
}

/** One file open: the editor's views over it, its runtime running it. */
function Workspace({
  language,
  runtime: active,
  open,
  files,
  text: controlled,
  onTextChange,
  moduleNames,
  plotKeys,
  autoPlay,
  tab,
  onTab: setTab,
  device: session,
}: WorkspaceProps) {
  const [own, setOwn] = useState(open.text);
  const text = controlled ?? own;
  const [file, setFile] = useState<BehaviorFile>(open.file);
  const [saved, setSaved] = useState(open.text);
  const [fileError, setFileError] = useState<string | null>(null);
  const [fileNotice, setFileNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>("0");
  const [folds, setFolds] = useState<ReadonlySet<string>>(new Set());
  const [plotted, setPlotted] = useState<string[]>([...plotKeys]);
  const wide = useMediaQuery(WIDE);

  const setText = useCallback(
    (next: string) => {
      if (controlled === undefined) setOwn(next);
      onTextChange?.(next);
    },
    [controlled, onTextChange],
  );

  // The text is current at every keystroke: what is saved, what a tab shows.
  // Typing parses it again once it pauses; any other change, a diagram edit or
  // a file opened, parses it at once, and makes a parse still waiting moot.
  const [typed, setTyped] = useState<string | null>(null);
  const [settled, setSettled] = useState(text);
  useEffect(() => {
    if (typed !== text) return undefined;
    const timer = setTimeout(() => setSettled(text), REPARSE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [typed, text]);
  const source = typed === text ? settled : text;
  const type = useCallback(
    (next: string) => {
      setTyped(next);
      setText(next);
    },
    [setText],
  );

  const parsed = useMemo(() => language.parse(source), [language, source]);
  const natives = useMemo(() => language.natives(), [language]);
  // Each connection to the device asks for its functions again.
  const sessionState = useSessionState(session);
  const connection = sessionState?.status === "connected" ? sessionState : null;
  const { functions, error: functionsError, known } = useRuntimeFunctions(
    session ?? active,
    connection,
  );
  const resolved = useMemo(
    () => language.resolve(parsed.document, functions),
    [language, parsed.document, functions],
  );
  // A behavior runs once resolved against its runtime's own functions: one
  // resolved against another's would name functions it may not have. Nor does
  // one whose text has errors: the parse leaves out the lines it could not
  // read, and the graph would be part of the file.
  const runnable =
    known &&
    resolved.graph.root !== undefined &&
    ![...parsed.diagnostics, ...resolved.diagnostics].some((d) => d.severity === "error");
  const diff = useCallback(
    (previous: Graph, next: Graph) => language.diff(previous, next),
    [language],
  );
  const device = useDeviceMode(session, runnable ? resolved : null, diff);
  const local = usePlayback(active, runnable && !session ? resolved : null, autoPlay, diff);
  // On a device, the device's steps are what shows.
  const playback = session ? device : local;
  const runtimeError = functionsError ?? playback.error;

  const index = useMemo(
    () => functionIndex(natives, functions, moduleNames),
    [natives, functions, moduleNames],
  );
  const storeKeys = useMemo(() => behaviorKeys(resolved, index), [resolved, index]);
  const rows = useMemo(
    () => diagramRows(parsed.document, index, resolved.nodes),
    [parsed.document, index, resolved.nodes],
  );
  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  const selectedRow = (selected !== null && byKey.get(selected)) || null;
  const diagnostics = useMemo(
    () => uniqueDiagnostics(parsed.diagnostics, resolved.diagnostics),
    [parsed.diagnostics, resolved.diagnostics],
  );
  // On a device, the file is the device's to run: what keeps it from running
  // there is told, the functions it calls that the device lacks first.
  const missing = useMemo(
    () =>
      session && known && !functionsError ? missingFunctions(parsed.document, index) : [],
    [session, known, functionsError, parsed.document, index],
  );
  const blocked = !session || !known || functionsError || runnable
    ? null
    : missing.length
      ? `This file calls functions this device doesn't have: ${missing.join(", ")}.`
      : diagnostics.some((d) => d.severity === "error")
        ? "The text has errors: the file runs on the device once they are fixed."
        : "The file has no behavior tree to run yet.";

  // While the text has errors, it is the only whole account of the behavior:
  // the parse left out the lines it could not read, so an edit formatted from
  // it would drop them. The diagram shows the parse and edits nothing. Nor
  // does it while typing waits to be parsed: the parse is of an older text.
  const editable = !parsed.diagnostics.some((d) => d.severity === "error");
  const [editError, setEditError] = useState<string | null>(null);
  const edit = useCallback(
    (change: Edit, select?: NodePath | null) => {
      if (!editable || source !== text) return;
      const next = change(parsed.document);
      if (next === parsed.document) return;
      let written: string;
      try {
        written = language.format({ document: next, diagnostics: [] }, functions);
      } catch (error) {
        setEditError(error instanceof Error ? error.message : String(error));
        return;
      }
      setEditError(null);
      setText(written);
      if (select !== undefined) setSelected(select === null ? null : rowKey(select));
    },
    [editable, source, text, parsed.document, language, functions, setText],
  );

  const drop = (key: string, target: Drop) => {
    const row = byKey.get(key);
    if (!row) return;
    const at = row.path;
    edit((d) => {
      if (target.kind === "into") {
        const holder = byKey.get(target.key)!;
        return reparent(d, at, holder.path, holder.node.children.length);
      }
      const before = target.key === null ? null : byKey.get(target.key)!;
      if (target.kind === "detach") {
        const place = before ? before.path[0]! : d.nodes.length;
        return reparent(d, at, null, at.length === 1 && at[0]! < place ? place - 1 : place);
      }
      const parent = before!.path.slice(0, -1);
      const place = before!.path.at(-1)!;
      const sameParent = rowKey(at.slice(0, -1)) === rowKey(parent);
      return reparent(d, at, parent, sameParent && at.at(-1)! < place ? place - 1 : place);
    }, null);
  };

  const onCaret = (offset: number) => {
    const line = source.slice(0, offset).split("\n").length;
    const found = walk(parsed.document)
      .filter(({ node }) => node.span.line === line)
      .at(-1);
    if (found) setSelected(rowKey(found.path));
  };

  const fileAction = (run: () => Promise<void>) => () => {
    setFileError(null);
    setFileNotice(null);
    run().catch((e: unknown) => setFileError(e instanceof Error ? e.message : String(e)));
  };
  /**
   * The file's contents in `format`: the text, or the graph it resolves to,
   * written as the format writes it; and what the format does not keep.
   */
  const contents = (format: FileFormat): { written: string; notice: string | null } => {
    if (format === "bt") return { written: text, notice: null };
    const label = FILE_FORMATS.find((f) => f.format === format)!.label;
    // The text as typed, which typing may not have had parsed yet.
    const now = source === text ? parsed : language.parse(text);
    const graph = source === text ? resolved : language.resolve(now.document, functions);
    if ([...now.diagnostics, ...graph.diagnostics].some((d) => d.severity === "error")) {
      throw new Error(
        `The text has errors: a ${label} file is written from the graph it resolves to`,
      );
    }
    const out = language.writeFile(graph, format, functions);
    if ("problems" in out) {
      throw new Error(`${label} cannot hold this behavior: ${problemsText(out.problems)}`);
    }
    return {
      written: out.text,
      notice: hasComments(now.document)
        ? `Saved as ${label}, which keeps no comments: the text's stay in its .bt`
        : null,
    };
  };
  const save = (format: FileFormat, saveAs: boolean) =>
    fileAction(async () => {
      const { written, notice } = contents(format);
      const target = saveAs
        ? { name: withExtension(file.name, format), format, handle: null }
        : file;
      const stored = await saveBehaviorFile(written, target, saveAs);
      if (!stored) return;
      files.remember(stored, written);
      setFile(stored);
      setSaved(text);
      setFileNotice(notice);
    });
  /** The text now, which a read of the device's behavior checks is still the one it replaces. */
  const textNow = useRef(text);
  textNow.current = text;
  /** Open what the device runs now, read again, in place of the file as it is when asked. */
  const openDeviceBehavior = () => {
    // Read when the open is asked for, which may be later than this render,
    // once the person confirmed discarding their changes.
    const asked = textNow.current;
    return files.openDevice(() => textNow.current === asked).catch((e: unknown) => {
      setEditError(e instanceof Error ? e.message : String(e));
    });
  };
  // The file as it runs on the device, to open with its names when the
  // device's behavior is viewed.
  const runsAsIs = device.relation === "running" && device.pendingChanges === 0 && runnable;
  useEffect(() => {
    if (!runsAsIs) return;
    const ran = files.ran;
    const at = ran.findIndex((f) => f.name === file.name);
    if (at >= 0) ran.splice(at, 1);
    ran.unshift({ name: file.name, text: source, graph: resolved.graph });
    ran.splice(RAN_FILES);
  }, [runsAsIs, files.ran, file.name, source, resolved.graph]);

  const toggleFold = (key: string) =>
    setFolds((f) => {
      const next = new Set(f);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const diagram = (
    <div className="be-pane be-diagram-pane">
      <div className="be-pane-bar">
        <h2>Diagram</h2>
        <Legend />
        <span className="be-fold-actions" role="group" aria-label="Folding">
          <button type="button" onClick={() => setFolds(new Set())}>
            Expand all
          </button>
          <button
            type="button"
            onClick={() =>
              setFolds(
                new Set(rows.filter((r) => r.childKeys.length && r.depth >= 1).map((r) => r.key)),
              )
            }
          >
            Collapse all
          </button>
        </span>
      </div>
      {!editable && (
        <p className="be-notice" role="status">
          The text has errors: the diagram shows what parses, and edits wait until the text is
          fixed.
        </p>
      )}
      <div className="be-canvas">
        {rows.length ? (
          <Diagram
            rows={rows}
            folds={folds}
            selected={selectedRow?.key ?? null}
            report={playback.report}
            previous={playback.previous}
            onSelect={setSelected}
            onToggleFold={toggleFold}
            onDelete={(key) => {
              const row = byKey.get(key);
              if (row && key !== "0") {
                edit(
                  (d) => deleteNode(d, row.path),
                  row.path.length > 1 ? row.path.slice(0, -1) : [0],
                );
              }
            }}
            onMove={(key, delta) => {
              const row = byKey.get(key);
              if (row) edit((d) => moveNode(d, row.path, delta), siblingPath(row.path, delta));
            }}
            onDrop={drop}
          />
        ) : (
          <p className="be-fine">The file has no node yet: write one in the text.</p>
        )}
      </div>
    </div>
  );
  const inspector = selectedRow && (
    <Inspector
      document={parsed.document}
      row={selectedRow}
      rows={rows}
      index={index}
      keys={[...playback.store.keys()]}
      editable={editable}
      onEdit={edit}
    />
  );
  const textView = (
    <div className="be-pane be-text-pane">
      <div className="be-pane-bar">
        <h2>Text</h2>
      </div>
      <TextView
        text={text}
        parsed={source === text}
        diagnostics={diagnostics}
        highlight={selectedRow?.node.span ?? null}
        onChange={type}
        onCaret={onCaret}
      />
    </div>
  );
  const store = (
    <StorePanel
      keys={playback.keys}
      behavior={storeKeys}
      pending={playback.pending}
      store={playback.store}
      history={playback.history}
      plotted={plotted}
      onPlottedChange={setPlotted}
      onWrite={playback.write}
    />
  );

  return (
    <div className="be-root" data-layout={wide ? "wide" : "narrow"}>
      <header className="be-header">
        <FileBar
          name={file.name}
          dirty={text !== saved}
          recent={files.recent}
          onNew={files.create}
          onOpen={fileAction(files.open)}
          onOpenRecent={(entry) => fileAction(() => files.openRecent(entry))()}
          onClose={files.close}
          onSave={save(file.format, false)}
          onSaveAs={(format) => save(format, true)()}
          error={fileError}
          notice={fileNotice}
        />
        <div className="be-header-run">
          <RunsOn session={session} />
          {session && (
            <DeviceBehaviorButton
              device={device}
              dirty={text !== saved}
              onOpen={openDeviceBehavior}
            />
          )}
          {session ? (
            <DeviceBar device={device} />
          ) : (
            <PlaybackBar
              playing={local.playing}
              onPlayingChange={local.setPlaying}
              onStep={local.step}
              onReset={local.reset}
              rate={local.rate}
              onRateChange={local.setRate}
              tick={local.report?.tick ?? 0}
              root={local.report?.root}
              runnable={runnable}
            />
          )}
        </div>
      </header>
      {session && (
        <DeviceBanner
          device={device}
          loaded={runnable ? resolved : null}
          blocked={blocked}
          index={index}
          dirty={text !== saved}
          onOpenDevice={() => void openDeviceBehavior()}
          onSelect={(id) => {
            const row = rows.find((r) => r.graphId === id);
            if (row) setSelected(row.key);
          }}
        />
      )}
      {runtimeError && (
        <p className="be-alert" role="alert">
          {runtimeError}
        </p>
      )}
      {editError && (
        <p className="be-alert" role="alert">
          {editError}
        </p>
      )}
      {wide ? (
        <div className="be-main">
          <ViewTabs
            tabs={WIDE_TABS}
            tab={tab === "store" ? "diagram" : tab}
            onTab={setTab}
            panels={{ diagram, text: textView }}
          />
          <aside className="be-side">
            {inspector}
            {store}
          </aside>
        </div>
      ) : (
        <ViewTabs
          tabs={NARROW_TABS}
          tab={tab}
          onTab={setTab}
          panels={{
            diagram: (
              <>
                {diagram}
                {inspector}
              </>
            ),
            text: textView,
            store,
          }}
        />
      )}
    </div>
  );
}

/**
 * Tabs over the editor's views, the arrow keys moving between them. A view
 * shows while its tab is selected. The text stays mounted, hidden while
 * another tab is, as its field holds what the editor cannot give back: its
 * undo history. Every other view draws from the editor's state, and is drawn
 * afresh, at its size, when its tab is selected.
 */
function ViewTabs({
  tabs,
  tab,
  onTab,
  panels,
}: {
  tabs: readonly TabInfo[];
  tab: Tab;
  onTab(tab: Tab): void;
  panels: Partial<Record<Tab, ReactNode>>;
}) {
  return (
    <div className="be-tabs">
      <div className="be-tablist" role="tablist" aria-label="Views">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`be-tab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls={`be-panel-${t.id}`}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => onTab(t.id)}
            onKeyDown={(event) => {
              const at = tabs.findIndex((x) => x.id === tab);
              const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (!step) return;
              const next = tabs[(at + step + tabs.length) % tabs.length]!;
              onTab(next.id);
              document.getElementById(`be-tab-${next.id}`)?.focus();
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tabs.map((t) => (
        <div
          key={t.id}
          role="tabpanel"
          id={`be-panel-${t.id}`}
          aria-labelledby={`be-tab-${t.id}`}
          hidden={tab !== t.id}
        >
          {(tab === t.id || t.id === "text") && panels[t.id]}
        </div>
      ))}
    </div>
  );
}

/**
 * Open the behavior the device runs in place of the file, asking first while
 * the file has unsaved changes; disabled, saying why, while it reads the
 * device's behavior, while the device does not say what it runs, and while
 * the connection is lost.
 */
function DeviceBehaviorButton({
  device,
  dirty,
  onOpen,
}: {
  device: DeviceMode;
  dirty: boolean;
  onOpen(): Promise<void>;
}) {
  const [asking, setAsking] = useState(false);
  const [reading, setReading] = useState(false);
  const open = () => {
    setReading(true);
    void onOpen().finally(() => setReading(false));
  };
  const unavailable =
    device.state?.status !== "connected"
      ? "The device is not connected."
      : reading || device.relation === "reading"
        ? "Reading the device's behavior…"
        : device.behavior === null
          ? "This device doesn't report its behavior."
          : null;
  return (
    <>
      <button
        type="button"
        disabled={unavailable !== null}
        title={unavailable ?? "Open the behavior the device runs, in place of this file."}
        onClick={() => (dirty ? setAsking(true) : open())}
      >
        Device&apos;s behavior
      </button>
      {asking && (
        <DiscardConfirm
          onDiscard={() => {
            setAsking(false);
            open();
          }}
          onKeep={() => setAsking(false)}
        />
      )}
    </>
  );
}

/**
 * Where the behavior runs: on the device attached, the editor only following
 * it, or simulated in the page, on the editor's runtime or the example's.
 */
function RunsOn({ session }: { session: DeviceSession | null }) {
  const state = useSessionState(session);
  const lost = state?.status === "lost";
  return session ? (
    <output
      className="be-runs-on be-runs-on-device"
      aria-label="Runs on"
      title="The behavior runs on the device: nothing ticks in this page."
    >
      {`Device${session.label ? ` ${session.label}` : ""}${lost ? " (reconnecting)" : ""}`}
    </output>
  ) : (
    <output
      className="be-runs-on be-runs-on-simulated"
      aria-label="Runs on"
      title="The behavior runs in this page, on a simulated runtime: no device runs it."
    >
      Simulated
    </output>
  );
}

/** The legend of the diagram's colors and pills. */
function Legend() {
  return (
    <div className="be-legend" aria-label="Legend">
      <span>
        <i className="be-sw be-sw-changed" />
        ran, value changed
      </span>
      <span>
        <i className="be-sw be-sw-same" />
        ran, same value
      </span>
      <span>
        <i className="be-sw be-sw-cached" />
        cache hit: not called
      </span>
      <span>
        <i className="be-sw be-sw-idle" />
        not reached this tick
      </span>
      <span>
        <i className="be-sw be-sw-wire" />
        data link
      </span>
      <span>
        <span className="be-pill-key be-S">S</span>
        <span className="be-pill-key be-R">R</span>
        <span className="be-pill-key be-F">F</span>
        status
      </span>
    </div>
  );
}

/** Whether `document` holds a comment anywhere. */
function hasComments(document: BehaviorDocument): boolean {
  const inNode = (node: BehaviorDocument["nodes"][number]): boolean =>
    node.comments.length > 0 ||
    node.comment !== null ||
    node.call.arguments.some((a) => a.comments.length > 0) ||
    node.children.some(inNode);
  return document.comments.length > 0 || document.nodes.some(inNode);
}

function uniqueDiagnostics(...lists: readonly (readonly Diagnostic[])[]): Diagnostic[] {
  const seen = new Set<string>();
  return lists.flat().filter((d) => {
    const id = `${d.severity}|${d.span.start}|${d.span.end}|${d.message}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
