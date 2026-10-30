import { useEffect, useId, useRef } from "react";
import type { BehaviorRuntime } from "../runtime/runtime";
import { labelOf } from "./file-formats";
import type { RecentFile } from "./recent-files";

/** A behavior the start screen offers to open. */
export interface BehaviorExample {
  /** What the start screen calls it. */
  title: string;
  /** The name it is saved under; its extension says its format. */
  fileName: string;
  /** Its text, in the behavior language. */
  text: string;
  /** The store keys plotted when it opens. */
  plotKeys?: readonly string[];
  /**
   * The runtime it needs, such as a device seeded for it: made when it opens,
   * and disposed when another file opens or the editor closes. Without it, it
   * runs on the editor's runtime.
   */
  runtime?(): { runtime: BehaviorRuntime; dispose?(): void };
}

export interface StartScreenProps {
  examples: readonly BehaviorExample[];
  recent: readonly RecentFile[];
  onNew(): void;
  onOpen(): void;
  onOpenRecent(file: RecentFile): void;
  onForget(file: RecentFile): void;
  onExample(example: BehaviorExample): void;
  /** Why the last attempt to open a file failed. */
  error: string | null;
  /** Whether to take the focus: the person came back to it from a file. */
  focus: boolean;
}

/**
 * What the editor shows with no behavior open: a new behavior, a file to
 * open, the files opened lately, and the host's examples.
 */
export function StartScreen({
  examples,
  recent,
  onNew,
  onOpen,
  onOpenRecent,
  onForget,
  onExample,
  error,
  focus,
}: StartScreenProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const ids = { title: useId(), recent: useId(), examples: useId() };
  useEffect(() => {
    if (focus) heading.current?.focus();
  }, [focus]);
  return (
    <section className="be-start" aria-labelledby={ids.title}>
      <h2 id={ids.title} ref={heading} tabIndex={-1}>
        Open a behavior
      </h2>
      <div className="be-start-actions">
        <button type="button" className="be-primary" onClick={onNew}>
          New behavior
        </button>
        <button type="button" onClick={onOpen}>
          Open…
        </button>
      </div>
      {error && (
        <p className="be-alert" role="alert">
          {error}
        </p>
      )}
      <div className="be-start-lists">
        <section aria-labelledby={ids.recent}>
          <h3 id={ids.recent}>Recent</h3>
          {recent.length ? (
            <ul className="be-start-list">
              {recent.map((file) => (
                <li key={file.id}>
                  <button
                    type="button"
                    className="be-start-item"
                    onClick={() => onOpenRecent(file)}
                  >
                    <span className="be-start-name">{file.name}</span>
                    <span className="be-start-meta">{labelOf(file.format)}</span>
                  </button>
                  <button
                    type="button"
                    className="be-start-forget"
                    aria-label={`Remove ${file.name} from the recent files`}
                    title="Remove from the recent files"
                    onClick={() => onForget(file)}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="be-fine">The files you open or save are listed here.</p>
          )}
        </section>
        {examples.length > 0 && (
          <section aria-labelledby={ids.examples}>
            <h3 id={ids.examples}>Examples</h3>
            <ul className="be-start-list">
              {examples.map((example, i) => (
                <li key={`${i}:${example.fileName}`}>
                  <button
                    type="button"
                    className="be-start-item"
                    onClick={() => onExample(example)}
                  >
                    <span className="be-start-name">{example.title}</span>
                    <span className="be-start-meta">{example.fileName}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </section>
  );
}
