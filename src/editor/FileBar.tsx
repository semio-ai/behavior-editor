import { useState } from "react";
import { FILE_FORMATS, type FileFormat } from "./file-formats";

export interface FileBarProps {
  name: string;
  dirty: boolean;
  onNew(): void;
  onOpen(): void;
  /** Save in the file's own format. */
  onSave(): void;
  /** Save in `format`, asking where. */
  onSaveAs(format: FileFormat): void;
  /** Why the last file operation failed. */
  error: string | null;
  /** What the last save could not keep, such as the text's comments in a graph file. */
  notice: string | null;
}

/**
 * The file: its name, whether it has unsaved changes, and New, Open, Save and
 * Save As, which first asks for the format.
 */
export function FileBar({
  name,
  dirty,
  onNew,
  onOpen,
  onSave,
  onSaveAs,
  error,
  notice,
}: FileBarProps) {
  const [confirming, setConfirming] = useState<"new" | "open" | null>(null);
  const [choosing, setChoosing] = useState(false);
  const guarded = (action: "new" | "open", run: () => void) => () => {
    if (dirty) setConfirming(action);
    else run();
  };
  return (
    <div className="be-file" role="group" aria-label="File">
      <span className="be-file-name">
        {name}
        {dirty && (
          <span className="be-dirty" title="Unsaved changes">
            <span aria-hidden="true"> ●</span>
            <span className="be-visually-hidden"> (unsaved changes)</span>
          </span>
        )}
      </span>
      {confirming ? (
        <span className="be-confirm" role="alert">
          Discard unsaved changes?
          <button
            type="button"
            className="be-danger"
            onClick={() => {
              setConfirming(null);
              if (confirming === "new") onNew();
              else onOpen();
            }}
          >
            Discard
          </button>
          <button type="button" onClick={() => setConfirming(null)}>
            Keep editing
          </button>
        </span>
      ) : choosing ? (
        <span className="be-confirm" role="group" aria-label="Save as">
          Save as
          {FILE_FORMATS.map((f) => (
            <button
              key={f.format}
              type="button"
              onClick={() => {
                setChoosing(false);
                onSaveAs(f.format);
              }}
            >
              {f.label}
            </button>
          ))}
          <button type="button" onClick={() => setChoosing(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <>
          <button type="button" onClick={guarded("new", onNew)}>
            New
          </button>
          <button type="button" onClick={guarded("open", onOpen)}>
            Open…
          </button>
          <button type="button" onClick={onSave}>
            Save
          </button>
          <button type="button" onClick={() => setChoosing(true)}>
            Save as…
          </button>
        </>
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
