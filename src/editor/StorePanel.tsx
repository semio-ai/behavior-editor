import { useEffect, useId, useRef, useState } from "react";
import {
  type Value,
  formatNumber,
  formatValue,
  numberValue,
  numericTag,
  valueBoolean,
  valueNumber,
  valueString,
} from "../model/value";
import { HISTORY } from "./use-playback";

export interface StorePanelProps {
  store: ReadonlyMap<string, Value>;
  history: ReadonlyMap<string, readonly (number | null)[]>;
  /** The keys the plot draws. */
  plotted: readonly string[];
  onPlottedChange(keys: string[]): void;
  onWrite(key: string, value: Value | null): void;
  /** Whether something other than a person writes `key` at every tick: shown, not edited. */
  isOutput(key: string): boolean;
}

/** The range a slider gives a number: 0 to 1 for a fraction, a power of ten beyond. */
export function sliderRange(value: number): [number, number] {
  const magnitude = Math.abs(value);
  const top = magnitude <= 1 ? 1 : 10 ** Math.ceil(Math.log10(magnitude));
  return value < 0 ? [-top, top] : [0, top];
}

const SERIES = 4;

/**
 * The store, key by key, as the last tick left it. An input has a slider for
 * a number, a switch for a boolean, a field for a string, each writing
 * through the runtime; an output, which the runtime or the behavior writes at
 * every tick, shows its value. Any number can be plotted.
 */
export function StorePanel({
  store,
  history,
  plotted,
  onPlottedChange,
  onWrite,
  isOutput,
}: StorePanelProps) {
  const keys = [...store.keys()].sort();
  // A key's slider spans the values it held lately, so it holds still while the value moves.
  const rangeOf = (key: string, n: number): [number, number] => {
    const seen = [n, ...(history.get(key) ?? []).filter((v): v is number => v !== null)];
    const ranges = seen.map(sliderRange);
    return [Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))];
  };
  return (
    <section className="be-store" aria-label="Store">
      <h3>Store</h3>
      {keys.length === 0 && <p className="be-fine">The store holds no key yet.</p>}
      <ul className="be-keys">
        {keys.map((key) => {
          const value = store.get(key)!;
          const n = valueNumber(value);
          const plottable = n !== undefined || valueBoolean(value) !== undefined;
          const series = plotted.indexOf(key);
          return (
            <li key={key} className="be-key">
              {isOutput(key) ? (
                <div className="be-control be-output">
                  <span className="be-label">{key}</span>
                  <output aria-label={key}>{formatValue(value)}</output>
                </div>
              ) : (
                <KeyEditor
                  name={key}
                  value={value}
                  range={n === undefined ? null : rangeOf(key, n)}
                  onWrite={(next) => onWrite(key, next)}
                />
              )}
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
  onWrite,
}: {
  name: string;
  value: Value;
  range: [number, number] | null;
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
        <StringField id={id} value={s} onCommit={(text) => onWrite({ str: text })} />
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
  value,
  onCommit,
}: {
  id: string;
  value: string;
  onCommit(text: string): void;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      id={id}
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
