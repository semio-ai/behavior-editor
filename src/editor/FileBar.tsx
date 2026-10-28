import { useState } from "react";

export interface FileBarProps {
  name: string;
  dirty: boolean;
  onNew(): void;
  onOpen(): void;
  onSave(): void;
  onSaveAs(): void;
  /** Why the last file operation failed. */
  error: string | null;
}

/** The file: its name, whether it has unsaved changes, and New, Open, Save and Save As. */
export function FileBar({ name, dirty, onNew, onOpen, onSave, onSaveAs, error }: FileBarProps) {
  const [confirming, setConfirming] = useState<"new" | "open" | null>(null);
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
          <button type="button" onClick={onSaveAs}>
            Save as…
          </button>
        </>
      )}
      {error && (
        <span className="be-problem" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
