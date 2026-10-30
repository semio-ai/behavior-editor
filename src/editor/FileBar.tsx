import { Fragment, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { DiscardConfirm } from "./DiscardConfirm";
import { FILE_FORMATS, type FileFormat } from "./file-formats";
import type { RecentFile } from "./recent-files";

export interface FileBarProps {
  name: string;
  dirty: boolean;
  /** The files opened lately, newest first. */
  recent: readonly RecentFile[];
  onNew(): void;
  onOpen(): void;
  onOpenRecent(file: RecentFile): void;
  /** Save in the file's own format. */
  onSave(): void;
  /** Save in `format`, asking where. */
  onSaveAs(format: FileFormat): void;
  /** Close the file, back to the start screen. */
  onClose(): void;
  /** Why the last file operation failed. */
  error: string | null;
  /** What the last save could not keep, such as the text's comments in a graph file. */
  notice: string | null;
}

/** What waits for the person's answer: discarding the changes, or a format to save as. */
type Asking = { kind: "discard"; run(): void } | { kind: "format" } | null;

/**
 * The file: its name, whether it has unsaved changes, and its menu: New,
 * Open, the recent files, Save, Save As, which then asks for the format, and
 * Close. What would replace the file asks first while it has unsaved changes.
 */
export function FileBar({
  name,
  dirty,
  recent,
  onNew,
  onOpen,
  onOpenRecent,
  onSave,
  onSaveAs,
  onClose,
  error,
  notice,
}: FileBarProps) {
  const [asking, setAsking] = useState<Asking>(null);
  const prompt = useRef<HTMLSpanElement>(null);
  // The formats take the focus, which the menu they came from gave up.
  useEffect(() => {
    prompt.current?.querySelector("button")?.focus();
  }, [asking]);
  const guarded = (run: () => void) => () => {
    if (dirty) setAsking({ kind: "discard", run });
    else run();
  };
  const entries: MenuEntry[] = [
    { label: "New", run: guarded(onNew) },
    { label: "Open…", run: guarded(onOpen) },
    ...(recent.length
      ? [
          {
            group: "Open recent",
            items: recent.map((file) => ({
              label: file.name,
              run: guarded(() => onOpenRecent(file)),
            })),
          },
        ]
      : []),
    { label: "Save", run: onSave, separated: true },
    { label: "Save as…", run: () => setAsking({ kind: "format" }) },
    { label: "Close", run: guarded(onClose), separated: true },
  ];
  return (
    <div className="be-file" role="group" aria-label="File">
      <Menu label="File" entries={entries} />
      <span className="be-file-name">
        {name}
        {dirty && (
          <span className="be-dirty" title="Unsaved changes">
            <span aria-hidden="true"> ●</span>
            <span className="be-visually-hidden"> (unsaved changes)</span>
          </span>
        )}
      </span>
      {asking?.kind === "discard" && (
        <DiscardConfirm
          onDiscard={() => {
            setAsking(null);
            asking.run();
          }}
          onKeep={() => setAsking(null)}
        />
      )}
      {asking?.kind === "format" && (
        <span className="be-confirm" role="group" aria-label="Save as" ref={prompt}>
          Save as
          {FILE_FORMATS.map((f) => (
            <button
              key={f.format}
              type="button"
              onClick={() => {
                setAsking(null);
                onSaveAs(f.format);
              }}
            >
              {f.label}
            </button>
          ))}
          <button type="button" onClick={() => setAsking(null)}>
            Cancel
          </button>
        </span>
      )}
      {error && (
        <span className="be-problem" role="alert">
          {error}
        </span>
      )}
      {!error && notice && (
        <span className="be-fine" role="status">
          {notice}
        </span>
      )}
    </div>
  );
}

interface MenuItem {
  label: string;
  run(): void;
  /** Whether a separator comes before it. */
  separated?: boolean;
}
type MenuEntry = MenuItem | { group: string; items: MenuItem[] };

/**
 * A menu button: the menu opens on a click, Enter, Space or the down arrow,
 * its items move with the arrow keys, Home and End, an item runs on a click
 * or Enter, and Escape, Tab or a click elsewhere closes it, Escape giving the
 * focus back to the button.
 */
function Menu({ label, entries }: { label: string; entries: readonly MenuEntry[] }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const id = useId();
  const items = () => [
    ...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []),
  ];
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };
  const onKeyDown = (event: KeyboardEvent) => {
    const all = items();
    const at = all.indexOf(document.activeElement as HTMLElement);
    const to = (i: number) => {
      event.preventDefault();
      all[(i + all.length) % all.length]?.focus();
    };
    if (event.key === "ArrowDown") to(at + 1);
    else if (event.key === "ArrowUp") to(at - 1);
    else if (event.key === "Home") to(0);
    else if (event.key === "End") to(all.length - 1);
    else if (event.key === "Escape") {
      event.preventDefault();
      close(true);
    } else if (event.key === "Tab") close(false);
  };
  const item = (entry: MenuItem, key: string) => (
    <Fragment key={key}>
      {entry.separated && <div role="separator" className="be-menu-separator" />}
      <button
        type="button"
        role="menuitem"
        tabIndex={-1}
        onClick={() => {
          close(true);
          entry.run();
        }}
      >
        {entry.label}
      </button>
    </Fragment>
  );
  return (
    <span
      className="be-menu-holder"
      onBlur={(event) => {
        if (open && !event.currentTarget.contains(event.relatedTarget as Node | null)) close(false);
      }}
    >
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {label}
      </button>
      {open && (
        <div
          ref={menu}
          id={id}
          role="menu"
          aria-label={label}
          className="be-menu"
          tabIndex={-1}
          onKeyDown={onKeyDown}
        >
          {entries.map((entry, i) =>
            "group" in entry ? (
              <div key={`g${i}`} role="group" aria-label={entry.group} className="be-menu-group">
                <span className="be-menu-heading" aria-hidden="true">
                  {entry.group}
                </span>
                {entry.items.map((it, j) => item(it, `g${i}.${j}`))}
              </div>
            ) : (
              item(entry, `i${i}`)
            ),
          )}
        </div>
      )}
    </span>
  );
}
