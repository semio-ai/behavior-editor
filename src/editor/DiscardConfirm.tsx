import { useEffect, useRef } from "react";

export interface DiscardConfirmProps {
  /** Discard the unsaved changes, and go on with what replaces the file. */
  onDiscard(): void;
  /** Keep the file and its changes. */
  onKeep(): void;
}

/**
 * The question asked before something replaces a file with unsaved changes.
 * It takes the focus as it shows, on Discard.
 */
export function DiscardConfirm({ onDiscard, onKeep }: DiscardConfirmProps) {
  const discard = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    discard.current?.focus();
  }, []);
  return (
    <span className="be-confirm" role="alert">
      Discard unsaved changes?
      <button ref={discard} type="button" className="be-danger" onClick={onDiscard}>
        Discard
      </button>
      <button type="button" onClick={onKeep}>
        Keep editing
      </button>
    </span>
  );
}
