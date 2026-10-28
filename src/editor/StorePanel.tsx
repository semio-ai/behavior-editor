import { useEffect, useId, useRef, useState } from "react";
import type { KeyInfo } from "../runtime/runtime";
import {
  type NumericTag,
  type Value,
  formatNumber,
  formatValue,
  numberValue,
  numericTag,
  valueBoolean,
  valueNumber,
  valueString,
} from "../model/value";
import type { BehaviorKeys } from "./store-keys";
import { HISTORY } from "./use-playback";

export interface StorePanelProps {
  store: ReadonlyMap<string, Value>;
  /** What the runtime says of each key: whether a person may write it, its type. */
  keys: ReadonlyMap<string, KeyInfo>;
  /** The keys the behavior reads and writes, read off its graph. */
  behavior: BehaviorKeys;
  /** The keys written since the last tick. */
  pending: ReadonlySet<string>;
  history: ReadonlyMap<string, readonly (number | null)[]>;
  /** The keys the plot draws. */
  plotted: readonly string[];
  onPlottedChange(keys: string[]): void;
  onWrite(key: string, value: Value | null): void;
}

/** The range a slider gives a number: 0 to 1 for a fraction, a power of ten beyond. */
export function sliderRange(value: number): [number, number] {
  const magnitude = Math.abs(value);
  const top = magnitude <= 1 ? 1 : 10 ** Math.ceil(Math.log10(magnitude));
  return value < 0 ? [-top, top] : [0, top];
}

const SERIES = 4;

/** What a key is, and so what a person may do with it. */
interface KeyRow {
  key: string;
  value: Value | undefined;
  editable: boolean;
  /** Why it is shown as it is, when that needs saying. */
  note: string | null;
}

/**
 * Each key's row. A key is editable when its runtime says a person may write
 * it, unless the behavior publishes it after every tick, which overwrites a
 * write at once. A key a tree node writes stays editable: a write lasts until
 * the node ticks.
 */
export function keyRows(
  store: ReadonlyMap<string, Value>,
  keys: ReadonlyMap<string, KeyInfo>,
  behavior: BehaviorKeys,
  pending: ReadonlySet<string>,
): KeyRow[] {
  const all = [...new Set([...store.keys(), ...keys.keys(), ...behavior.reads])].sort();
  return all.map((key) => {
    const info = keys.get(key);
    const write = behavior.writes.get(key);
    const editable = info?.editable === true && write !== "sink";
    const note = pending.has(key)
      ? "applies at the next step"
      : write === "sink"
        ? "published by the behavior every tick"
        : !info
          ? "not listed by the runtime: it cannot be written"
          : !info.editable
            ? "written by the runtime, not by a person"
            : write === "leaf"
              ? "written by the behavior when its node ticks"
              : null;
    return { key, value: store.get(key), editable, note };
  });
}

/** The value a key with none yet starts from, of its type when the runtime says. */
function startingValue(ty: string | undefined): Value {
  if (ty === "bool") return { bool: false };
  if (ty === "str") return { str: "" };
  const tag = NUMERIC.find((t) => t === ty) ?? "f64";
  return numberValue(tag, 0);
}

const NUMERIC: readonly NumericTag[] = [
  "u8",
  "u16",
  "u32",
  "u64",
  "i8",
  "i16",
  "i32",
  "i64",
  "f32",
  "f64",
];

/**
 * The store, key by key, as the last tick left it, with the keys the behavior
 * reads that hold nothing yet. An editable key has a slider for a number, a
 * switch for a boolean, a field for a string, each writing through the
 * runtime; any other key shows its value and why it cannot be written. Any
 * number can be plotted.
 */
export function StorePanel({
  store,
  keys,
  behavior,
  pending,
  history,
  plotted,
  onPlottedChange,
  onWrite,
}: StorePanelProps) {
  const rows = keyRows(store, keys, behavior, pending);
  // A key's slider spans the values it held lately, so it holds still while the value moves.
  const rangeOf = (key: string, n: number): [number, number] => {
    const seen = [n, ...(history.get(key) ?? []).filter((v): v is number => v !== null)];
    const ranges = seen.map(sliderRange);
    return [Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))];
  };
  return (
    <section className="be-store" aria-label="Store">
      <h3>Store</h3>
      {rows.length === 0 && <p className="be-fine">The store holds no key yet.</p>}
      <ul className="be-keys">
        {rows.map(({ key, value, editable, note }) => {
          const shown = value ?? startingValue(keys.get(key)?.ty);
          const n = valueNumber(value);
          const plottable = n !== undefined || valueBoolean(value) !== undefined;
          const series = plotted.indexOf(key);
          const noteId = `be-note-${key}`;
          return (
            <li key={key} className="be-key">
              <div className="be-key-body">
                {editable ? (
                  <KeyEditor
                    name={key}
                    value={shown}
                    range={
                      valueNumber(shown) === undefined ? null : rangeOf(key, valueNumber(shown)!)
                    }
                    describedBy={note ? noteId : undefined}
                    onWrite={(next) => onWrite(key, next)}
                  />
                ) : (
                  <div className="be-control be-output">
                    <span className="be-label">{key}</span>
                    <output aria-label={key} aria-describedby={note ? noteId : undefined}>
                      {value === undefined ? "no value" : formatValue(value)}
                    </output>
                  </div>
                )}
                {note && (
                  <p className="be-key-note" id={noteId}>
                    {value === undefined && editable ? `no value yet · ${note}` : note}
                  </p>
                )}
                {!note && value === undefined && <p className="be-key-note">no value yet</p>}
              </div>
              {plottable && (
                <label className="be-plot-toggle">
                  <input
                    type="checkbox"
                    checked={series >= 0}
                    onChange={(event) =>
                      onPlottedChange(
                        event.target.checked ? [...plotted, key] : plotted.filter((k) => k !== key),
                      )
                    }
                  />
                  <i
                    className={series >= 0 ? `be-swatch be-series-${series % SERIES}` : "be-swatch"}
                  />
                  <span className="be-visually-hidden">{`Plot ${key}`}</span>
                </label>
              )}
            </li>
          );
        })}
      </ul>
      {plotted.length > 0 && <Plot keys={plotted} history={history} />}
    </section>
  );
}

function KeyEditor({
  name,
  value,
  range,
  describedBy,
  onWrite,
}: {
  name: string;
  value: Value;
  range: [number, number] | null;
  describedBy: string | undefined;
  onWrite(value: Value): void;
}) {
  const id = useId();
  const n = valueNumber(value);
  const tag = numericTag(value);
  const b = valueBoolean(value);
  const s = valueString(value);
  if (n !== undefined && tag && range) {
    const integer = !tag.startsWith("f");
    const step = integer ? 1 : (range[1] - range[0]) / 200;
    return (
      <div className="be-control">
        <label htmlFor={id}>{name}</label>
        <output htmlFor={id}>{formatNumber(n)}</output>
        <input
          id={id}
          aria-describedby={describedBy}
          type="range"
          min={range[0]}
          max={range[1]}
          step={step}
          value={n}
          onChange={(event) => onWrite(numberValue(tag, Number(event.target.value)))}
        />
      </div>
    );
  }
  if (b !== undefined) {
    return (
      <div className="be-control">
        <label className="be-check" htmlFor={id}>
          <input
            id={id}
            aria-describedby={describedBy}
            type="checkbox"
            role="switch"
            checked={b}
            onChange={(event) => onWrite({ bool: event.target.checked })}
          />
          {name}
        </label>
      </div>
    );
  }
  if (s !== undefined) {
    return (
      <div className="be-control">
        <label htmlFor={id}>{name}</label>
        <StringField
          id={id}
          describedBy={describedBy}
          value={s}
          onCommit={(text) => onWrite({ str: text })}
        />
      </div>
    );
  }
  return (
    <div className="be-control">
      <span className="be-label">{name}</span>
      <code className="be-as-written">{formatValue(value)}</code>
    </div>
  );
}

function StringField({
  id,
  describedBy,
  value,
  onCommit,
}: {
  id: string;
  describedBy: string | undefined;
  value: string;
  onCommit(text: string): void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      id={id}
      aria-describedby={describedBy}
      type="text"
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={() => text !== value && onCommit(text)}
      onKeyDown={(event) => event.key === "Enter" && text !== value && onCommit(text)}
    />
  );
}

/** The plotted keys over the last ticks, on one scale. */
function Plot({
  keys,
  history,
}: {
  keys: readonly string[];
  history: ReadonlyMap<string, readonly (number | null)[]>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    const g = el?.getContext?.("2d");
    if (!el || !g) return;
    const dpr = window.devicePixelRatio || 1;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (!w) return;
    el.width = w * dpr;
    el.height = h * dpr;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const style = getComputedStyle(el);
    const series = keys.map((k) => history.get(k) ?? []);
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of series) {
      for (const v of s) {
        if (v === null) continue;
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    if (!Number.isFinite(lo)) [lo, hi] = [0, 1];
    if (hi - lo < 1e-9) [lo, hi] = [lo - 0.5, hi + 0.5];
    const y = (v: number) => h - 6 - ((v - lo) / (hi - lo)) * (h - 12);
    g.strokeStyle = style.getPropertyValue("--be-grid");
    g.lineWidth = 1;
    for (const v of [lo, (lo + hi) / 2, hi]) {
      g.beginPath();
      g.moveTo(0, y(v));
      g.lineTo(w, y(v));
      g.stroke();
    }
    g.fillStyle = style.getPropertyValue("--be-muted");
    g.font = `10px ${style.getPropertyValue("--be-mono")}`;
    g.fillText(formatNumber(hi), 4, 12);
    g.fillText(formatNumber(lo), 4, h - 8);
    series.forEach((s, i) => {
      g.strokeStyle = style.getPropertyValue(`--be-series-${i % SERIES}`);
      g.lineWidth = 2;
      g.beginPath();
      let drawing = false;
      s.forEach((v, j) => {
        const x = w - (s.length - 1 - j) * (w / (HISTORY - 1));
        if (v === null) {
          drawing = false;
          return;
        }
        if (drawing) g.lineTo(x, y(v));
        else g.moveTo(x, y(v));
        drawing = true;
      });
      g.stroke();
    });
  }, [keys, history]);
  return (
    <figure className="be-plot">
      <canvas
        ref={canvas}
        role="img"
        aria-label={`Plot of ${keys.join(", ")} over the last ticks`}
      />
      <figcaption>
        {keys.map((k, i) => (
          <span key={k}>
            <i className={`be-swatch be-series-${i % SERIES}`} />
            {k}
          </span>
        ))}
      </figcaption>
    </figure>
  );
}
