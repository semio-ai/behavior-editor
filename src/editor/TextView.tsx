import { useEffect, useId, useRef, useState } from "react";
import type { Span } from "../text/ast";
import type { Diagnostic } from "../text/language";

export interface TextViewProps {
  text: string;
  diagnostics: readonly Diagnostic[];
  /** The span of the selected node, marked in the text. */
  highlight: Span | null;
  /** Called with the text once typing pauses. */
  onChange(text: string): void;
  /** Called with the caret's offset when it moves. */
  onCaret(offset: number): void;
}

/** How long typing pauses before the text is parsed again. */
export const REPARSE_DELAY_MS = 250;

/**
 * The file as text: line numbers, a marker in the gutter of each line a
 * diagnostic is on, the diagnostic's range underlined, and the list of
 * diagnostics, each of which moves the caret to its range.
 */
export function TextView({ text, diagnostics, highlight, onChange, onCaret }: TextViewProps) {
  const [draft, setDraft] = useState(text);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const backdrop = useRef<HTMLPreElement>(null);
  const gutter = useRef<HTMLDivElement>(null);
  const listId = useId();

  // A text from elsewhere (a diagram edit, a file opened) replaces the draft,
  // unless typing is about to send the draft itself.
  useEffect(() => {
    if (pending.current === null) setDraft(text);
  }, [text]);

  useEffect(
    () => () => {
      if (pending.current !== null) clearTimeout(pending.current);
    },
    [],
  );

  const edit = (next: string) => {
    setDraft(next);
    if (pending.current !== null) clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      pending.current = null;
      onChange(next);
    }, REPARSE_DELAY_MS);
  };

  const syncScroll = () => {
    const el = area.current;
    if (!el) return;
    if (backdrop.current) {
      backdrop.current.scrollTop = el.scrollTop;
      backdrop.current.scrollLeft = el.scrollLeft;
    }
    if (gutter.current) gutter.current.scrollTop = el.scrollTop;
  };

  const reveal = (span: Span) => {
    const el = area.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(span.start, Math.max(span.end, span.start));
  };

  const lines = draft.split("\n");
  const linesWith = new Map<number, Diagnostic["severity"]>();
  for (const d of diagnostics) {
    if (linesWith.get(d.span.line) !== "error") linesWith.set(d.span.line, d.severity);
  }
  // Marks are drawn only while the text is what was parsed.
  const marks = draft === text ? marked(draft, diagnostics, highlight) : [{ text: draft }];

  return (
    <div className="be-text">
      <div className="be-code">
        <div className="be-gutter" ref={gutter} aria-hidden="true">
          {lines.map((_, i) => (
            <div key={i} className={`be-gutter-line be-${linesWith.get(i + 1) ?? "plain"}`}>
              {i + 1}
            </div>
          ))}
        </div>
        <div className="be-editor">
          <pre className="be-backdrop" ref={backdrop} aria-hidden="true">
            {marks.map((m, i) =>
              m.mark ? (
                <mark key={i} className={`be-mark be-${m.mark}`}>
                  {m.text}
                </mark>
              ) : (
                <span key={i}>{m.text}</span>
              ),
            )}
            {"\n"}
          </pre>
          <textarea
            ref={area}
            className="be-textarea"
            value={draft}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            wrap="off"
            aria-label="Behavior text"
            aria-describedby={diagnostics.length ? listId : undefined}
            aria-invalid={diagnostics.some((d) => d.severity === "error")}
            onChange={(event) => edit(event.target.value)}
            onScroll={syncScroll}
            onSelect={(event) => onCaret(event.currentTarget.selectionStart)}
          />
        </div>
      </div>
      {diagnostics.length > 0 && (
        <ul className="be-diagnostics" id={listId} aria-label="Diagnostics">
          {diagnostics.map((d, i) => (
            <li key={i}>
              <button
                type="button"
                className={`be-diagnostic be-${d.severity}`}
                onClick={() => reveal(d.span)}
              >
                <span className="be-where">
                  {d.span.line}:{d.span.column}
                </span>{" "}
                <span className="be-severity">{d.severity}</span>{" "}
                <span className="be-message" title={d.message}>
                  {d.message}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The text cut where marks begin and end: the diagnostics' ranges, an empty
 * one widened to a character so it shows, and the highlighted node's range.
 */
function marked(
  text: string,
  diagnostics: readonly Diagnostic[],
  highlight: Span | null,
): { text: string; mark?: string }[] {
  const ranges: { start: number; end: number; mark: string }[] = diagnostics.map((d) => ({
    start: Math.min(d.span.start, text.length),
    end: Math.min(Math.max(d.span.end, d.span.start + 1), text.length),
    mark: d.severity,
  }));
  if (highlight && highlight.end > highlight.start) {
    ranges.push({
      start: highlight.start,
      end: Math.min(highlight.end, text.length),
      mark: "selected",
    });
  }
  const cuts = [...new Set([0, text.length, ...ranges.flatMap((r) => [r.start, r.end])])].sort(
    (a, b) => a - b,
  );
  const out: { text: string; mark?: string }[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const [from, to] = [cuts[i]!, cuts[i + 1]!];
    if (from === to) continue;
    const covering = ranges.filter((r) => r.start <= from && r.end >= to);
    const mark = covering.find((r) => r.mark === "error")?.mark ?? covering[0]?.mark;
    out.push({ text: text.slice(from, to), ...(mark ? { mark } : {}) });
  }
  return out;
}
