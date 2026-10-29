import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { type NodePath, deleteNode, moveNode, reparent, siblingPath, walk } from "../model/edit";
import { MockArora } from "../runtime/mock-arora";
import type { BehaviorRuntime } from "../runtime/runtime";
import type { BehaviorText, Diagnostic } from "../text/language";
import { Diagram, type Drop } from "./Diagram";
import { diagramRows, rowKey } from "./diagram-rows";
import { type BehaviorFile, openBehaviorFile, saveBehaviorFile } from "./file-access";
import { FileBar } from "./FileBar";
import { functionIndex } from "./functions";
import { type Edit, Inspector } from "./Inspector";
import { PlaybackBar } from "./PlaybackBar";
import { behaviorKeys } from "./store-keys";
import { StorePanel } from "./StorePanel";
import { TextView } from "./TextView";
import { useMediaQuery } from "./use-media-query";
import { usePlayback, useRuntimeFunctions } from "./use-playback";

export interface BehaviorEditorProps {
  /** The language: its parser, formatter and resolver. */
  language: BehaviorText;
  /** Where the behavior runs; a mock device with the math module by default. */
  runtime?: BehaviorRuntime;
  /** The file's text, for a controlled editor; `onTextChange` receives every change. */
  text?: string;
  /** The text an uncontrolled editor starts from. */
  defaultText?: string;
  onTextChange?(text: string): void;
  /** The file's name until one is opened or saved. */
  fileName?: string;
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

/**
 * An editor for a behavior: its tree and detached nodes as a diagram, and
 * its file as text, in tabs, either editing the other; run on a device or a mock, its
 * statuses and store live; read from and saved to a local `.bt` file.
 */
export function BehaviorEditor({
  language,
  runtime,
  text: controlled,
  defaultText = "",
  onTextChange,
  fileName = "behavior.bt",
  moduleNames,
  plotKeys = [],
  autoPlay = true,
}: BehaviorEditorProps) {
  const active = useMemo(() => runtime ?? new MockArora(), [runtime]);
  const [own, setOwn] = useState(defaultText);
  const text = controlled ?? own;
  const [file, setFile] = useState<BehaviorFile>({ name: fileName, handle: null });
  const [saved, setSaved] = useState(text);
  const [fileError, setFileError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>("0");
  const [folds, setFolds] = useState<ReadonlySet<string>>(new Set());
  const [plotted, setPlotted] = useState<string[]>([...plotKeys]);
  const [tab, setTab] = useState<Tab>("diagram");
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
  const { functions, error: functionsError } = useRuntimeFunctions(active);
  const resolved = useMemo(
    () => language.resolve(parsed.document, functions),
    [language, parsed.document, functions],
  );
  const runnable =
    resolved.graph.root !== undefined && !resolved.diagnostics.some((d) => d.severity === "error");
  const playback = usePlayback(active, runnable ? resolved : null, autoPlay);
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
    run().catch((e: unknown) => setFileError(e instanceof Error ? e.message : String(e)));
  };
  const save = (saveAs: boolean) =>
    fileAction(async () => {
      const written = await saveBehaviorFile(text, file, saveAs);
      if (!written) return;
      setFile(written);
      setSaved(text);
    });
  const onNew = fileAction(async () => {
    setFile({ name: fileName, handle: null });
    setText("");
    setSaved("");
    setSelected("0");
    await Promise.resolve();
  });
  const onOpen = fileAction(async () => {
    const opened = await openBehaviorFile();
    if (!opened) return;
    setFile({ name: opened.name, handle: opened.handle });
    setText(opened.text);
    setSaved(opened.text);
    setSelected("0");
    setFolds(new Set());
  });

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
          onNew={onNew}
          onOpen={onOpen}
          onSave={save(false)}
          onSaveAs={save(true)}
          error={fileError}
        />
        <PlaybackBar
          playing={playback.playing}
          onPlayingChange={playback.setPlaying}
          onStep={playback.step}
          onReset={playback.reset}
          rate={playback.rate}
          onRateChange={playback.setRate}
          tick={playback.report?.tick ?? 0}
          root={playback.report?.root}
          runnable={runnable}
        />
      </header>
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
          <ViewTabs tabs={WIDE_TABS} tab={tab === "store" ? "diagram" : tab} onTab={setTab}>
            {tab === "text" ? textView : diagram}
          </ViewTabs>
          <aside className="be-side">
            {inspector}
            {store}
          </aside>
        </div>
      ) : (
        <ViewTabs tabs={NARROW_TABS} tab={tab} onTab={setTab}>
          {tab === "diagram" && (
            <>
              {diagram}
              {inspector}
            </>
          )}
          {tab === "text" && textView}
          {tab === "store" && store}
        </ViewTabs>
      )}
    </div>
  );
}

/** Tabs over the editor's views, the arrow keys moving between them. */
function ViewTabs({
  tabs,
  tab,
  onTab,
  children,
}: {
  tabs: readonly TabInfo[];
  tab: Tab;
  onTab(tab: Tab): void;
  children: ReactNode;
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
      <div role="tabpanel" id={`be-panel-${tab}`} aria-labelledby={`be-tab-${tab}`}>
        {children}
      </div>
    </div>
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

function uniqueDiagnostics(...lists: readonly (readonly Diagnostic[])[]): Diagnostic[] {
  const seen = new Set<string>();
  return lists.flat().filter((d) => {
    const id = `${d.severity}|${d.span.start}|${d.span.end}|${d.message}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}
