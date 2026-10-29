import { useEffect, useMemo, useRef, useState } from "react";
import { type Value, formatValue, valueEquals } from "../model/value";
import { statusOf } from "../runtime/natives";
import type { DetachedActivity, Status, TickReport } from "../runtime/runtime";
import {
  type Box,
  type DiagramLayout,
  MINI,
  layoutDiagram,
  outputY,
  portY,
} from "./diagram-layout";
import type { DiagramRow } from "./diagram-rows";

/** Where a dragged node lands. */
export type Drop =
  /** Last among the children of a node that holds children. */
  | { kind: "into"; key: string }
  /** Just before a node, among its siblings. */
  | { kind: "before"; key: string }
  /** Among the nodes no node holds, before `key` or last. */
  | { kind: "detach"; key: string | null };

export interface DiagramProps {
  rows: DiagramRow[];
  folds: ReadonlySet<string>;
  selected: string | null;
  report: TickReport | null;
  /** The tick before `report`'s, to tell a value that changed from one that stayed. */
  previous: TickReport | null;
  onSelect(key: string): void;
  onToggleFold(key: string): void;
  onDelete(key: string): void;
  onMove(key: string, delta: -1 | 1): void;
  onDrop(key: string, drop: Drop): void;
}

const DRAG_THRESHOLD = 6;

/**
 * What a node did this tick: a tree node's status; a detached node called
 * with its value changed or the same, served from its cache, or not reached.
 */
type NodeState = Status | "changed" | "same" | "cached" | "idle";

/** A row's state this tick, and its return value with whether it changed since the tick before. */
interface RowState {
  state: NodeState | null;
  /** Whether the runtime said what the node did: a device may not. */
  known?: boolean;
  value?: Value;
  change?: "changed" | "same";
}

function stateOf(
  row: DiagramRow,
  report: TickReport | null,
  previous: TickReport | null,
): RowState {
  if (!report || row.graphId === null) return { state: null };
  const id = row.graphId;
  // A status is the pill's to show, not a value's.
  const reported = report.values?.[id];
  const value = reported === undefined || statusOf(reported) ? undefined : reported;
  const ran = row.detached
    ? report.detached?.[id] === "called"
    : report.statuses?.[id] !== undefined;
  // A value is new when its node ran and it differs from the tick before's.
  const change: RowState["change"] =
    value === undefined
      ? undefined
      : ran && !valueEquals(previous?.values?.[id], value)
        ? "changed"
        : "same";
  const shown = value === undefined ? {} : { value, change };
  if (!row.detached) {
    return { state: report.statuses?.[id] ?? null, known: !!report.statuses, ...shown };
  }
  const activity: DetachedActivity | undefined = report.detached?.[id];
  if (activity === undefined) return { state: null, known: !!report.detached, ...shown };
  if (activity !== "called") return { state: activity, ...shown };
  return { state: change ?? "changed", ...shown };
}

const live = (state: NodeState | null) => state !== null && state !== "idle";

const STATE_WORDS: Record<NodeState, string> = {
  S: "succeeded",
  F: "failed",
  R: "running",
  changed: "called, value changed",
  same: "called, same value",
  cached: "cache hit, not called",
  idle: "not reached",
};

/** Which drop the point `(x, y)` makes for the dragged row `dragged`. */
export function dropAt(
  layout: DiagramLayout,
  dragged: DiagramRow,
  x: number,
  y: number,
): Drop | null {
  const excluded = new Set([dragged.key, ...dragged.descendantKeys]);
  for (const box of layout.boxes.values()) {
    if (excluded.has(box.row.key)) continue;
    if (x < box.x || x > box.x + box.w || y < box.y || y > box.y + box.h) continue;
    if (box.row.detached) return { kind: "detach", key: box.row.key };
    if (box.row.shape === "control") return { kind: "into", key: box.row.key };
    return box.row.key === "0" ? null : { kind: "before", key: box.row.key };
  }
  return x < layout.treeLeft ? { kind: "detach", key: null } : null;
}

/**
 * The behavior as a diagram: the tree top-down with this tick's statuses, the
 * detached nodes on its left, and the wires from each producing node to the
 * ports that read it. A node is selected by click or arrow keys, folded by its
 * chevron or the left and right keys, moved by dragging or Alt+arrows, and
 * deleted with Delete.
 */
export function Diagram({
  rows,
  folds,
  selected,
  report,
  previous,
  onSelect,
  onToggleFold,
  onDelete,
  onMove,
  onDrop,
}: DiagramProps) {
  const layout = useMemo(() => layoutDiagram(rows, folds), [rows, folds]);
  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  const [hovered, setHovered] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ key: string; x: number; y: number; drop: Drop | null } | null>(
    null,
  );
  const press = useRef<{ key: string; x: number; y: number; pointer: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const root = layout.boxes.get("0");
  const rootCentre = root ? root.x + root.w / 2 : null;
  const centredAt = useRef<number | null>(0);
  // Open on the root, and follow it while the layout settles (the functions
  // arriving widen the nodes), until the pane is scrolled by hand.
  useEffect(() => {
    const pane = container.current?.parentElement;
    if (!pane || rootCentre === null || centredAt.current !== pane.scrollLeft) return;
    pane.scrollLeft = Math.max(0, rootCentre - pane.clientWidth / 2);
    centredAt.current = pane.scrollLeft;
  }, [rootCentre]);
  const nodeRefs = useRef(new Map<string, SVGGElement>());

  const visible = [...layout.boxes.keys()];
  const focusKey = selected !== null && layout.boxes.has(selected) ? selected : visible[0];

  const focus = (key: string) => {
    onSelect(key);
    nodeRefs.current.get(key)?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    const key = focusKey;
    if (key === undefined) return;
    const row = byKey.get(key)!;
    const at = visible.indexOf(key);
    const folded = folds.has(key);
    const handled = (() => {
      switch (event.key) {
        case "ArrowDown":
          if (event.altKey) onMove(key, 1);
          else if (at < visible.length - 1) focus(visible[at + 1]!);
          return true;
        case "ArrowUp":
          if (event.altKey) onMove(key, -1);
          else if (at > 0) focus(visible[at - 1]!);
          return true;
        case "ArrowRight":
          if (row.childKeys.length && folded) onToggleFold(key);
          else if (row.childKeys.length) focus(row.childKeys[0]!);
          return true;
        case "ArrowLeft":
          if (row.childKeys.length && !folded) onToggleFold(key);
          else if (row.parentKey !== null) focus(row.parentKey);
          return true;
        case "Home":
          if (visible[0] !== undefined) focus(visible[0]);
          return true;
        case "End":
          if (visible.length) focus(visible.at(-1)!);
          return true;
        case "Delete":
        case "Backspace":
          onDelete(key);
          return true;
        default:
          return false;
      }
    })();
    if (handled) event.preventDefault();
  };

  const point = (event: React.PointerEvent) => {
    const rect = svg.current!.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (key: string) => (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const { x, y } = point(event);
    press.current = { key, x, y, pointer: event.pointerId };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const pressed = press.current;
    if (!pressed) return;
    const { x, y } = point(event);
    if (!drag && Math.hypot(x - pressed.x, y - pressed.y) < DRAG_THRESHOLD) return;
    if (pressed.key === "0") return;
    if (!drag) svg.current?.setPointerCapture?.(pressed.pointer);
    setDrag({ key: pressed.key, x, y, drop: dropAt(layout, byKey.get(pressed.key)!, x, y) });
  };

  const onPointerUp = (event: React.PointerEvent) => {
    const pressed = press.current;
    press.current = null;
    if (drag) {
      if (drag.drop) onDrop(drag.key, drag.drop);
      setDrag(null);
    } else if (pressed) {
      // The chevron folds; anywhere else on a node selects it.
      if ((event.target as Element).closest("[data-fold]")) onToggleFold(pressed.key);
      else focus(pressed.key);
    }
  };

  const detachedKeys = rows.filter((r) => r.detached).map((r) => r.key);
  const positionOf = (row: DiagramRow) => {
    const siblings =
      row.parentKey !== null
        ? byKey.get(row.parentKey)!.childKeys
        : row.detached
          ? detachedKeys
          : [row.key];
    return { at: siblings.indexOf(row.key) + 1, of: siblings.length };
  };

  const hot = hovered ?? selected;
  const states = new Map(rows.map((r) => [r.key, stateOf(r, report, previous)]));
  const isLive = (key: string) => live(states.get(key)?.state ?? null);
  const dropKey = drag?.drop && drag.drop.kind !== "detach" ? drag.drop.key : null;

  return (
    <div className="be-diagram" ref={container} data-dragging={drag ? "" : undefined}>
      <svg
        ref={svg}
        width={layout.width}
        height={layout.height}
        viewBox={`0 0 ${layout.width} ${layout.height}`}
        role="tree"
        aria-label="Behavior diagram"
        onKeyDown={onKeyDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          press.current = null;
          setDrag(null);
        }}
      >
        {drag?.drop?.kind === "detach" && (
          <rect
            className="be-detach-zone"
            x={0}
            y={0}
            width={Math.max(layout.treeLeft - 8, 0)}
            height={layout.height}
          />
        )}
        <g aria-hidden="true">
          {layout.edges.map((e) => (
            <path
              key={`${e.from}>${e.to}`}
              className={`be-edge${isLive(e.to) ? " be-live" : ""}`}
              d={e.d}
            />
          ))}
        </g>
        <g aria-hidden="true">
          {layout.wires.map((w) => (
            <path
              key={`${w.from}>${w.to}@${w.port ?? "folded"}`}
              className={`be-wire${isLive(w.from) && isLive(w.to) ? " be-live" : ""}${
                hot !== null && (w.from === hot || w.to === hot) ? " be-hot" : ""
              }`}
              d={w.d}
            />
          ))}
        </g>
        <g>
          {[...layout.boxes.values()].map((box) => (
            <DiagramNode
              key={box.row.key}
              box={box}
              state={states.get(box.row.key) ?? { state: null }}
              miniStates={box.minis?.map((m) => states.get(m.key)?.state ?? null) ?? []}
              position={positionOf(box.row)}
              selected={box.row.key === selected}
              focusable={box.row.key === focusKey}
              dropTarget={box.row.key === dropKey}
              dragged={drag?.key === box.row.key}
              nodeRef={(el) => {
                if (el) nodeRefs.current.set(box.row.key, el);
                else nodeRefs.current.delete(box.row.key);
              }}
              onFocus={() => onSelect(box.row.key)}
              onHover={(on) => setHovered(on ? box.row.key : null)}
              onPointerDown={onPointerDown(box.row.key)}
            />
          ))}
        </g>
        {drag && (
          <text className="be-drag-label" x={drag.x + 12} y={drag.y + 4} aria-hidden="true">
            {byKey.get(drag.key)?.title}
          </text>
        )}
      </svg>
    </div>
  );
}

interface DiagramNodeProps {
  box: Box;
  /** Its place among its siblings: the tree's own nesting is not in the markup. */
  position: { at: number; of: number };
  state: RowState;
  miniStates: (NodeState | null)[];
  selected: boolean;
  focusable: boolean;
  dropTarget: boolean;
  dragged: boolean;
  nodeRef(el: SVGGElement | null): void;
  onFocus(): void;
  onHover(on: boolean): void;
  onPointerDown(event: React.PointerEvent): void;
}

function DiagramNode({
  box,
  position,
  state: { state, known = true, value, change },
  miniStates,
  selected,
  focusable,
  dropTarget,
  dragged,
  nodeRef,
  onFocus,
  onHover,
  onPointerDown,
}: DiagramNodeProps) {
  const { row, w, h } = box;
  const rx =
    row.shape === "condition"
      ? row.ports.length
        ? 12
        : Math.min(h / 2, 18)
      : row.shape === "action"
        ? 2
        : 7;
  const tx = row.shape === "condition" ? 16 : 11;
  const hasChildren = row.childKeys.length > 0;
  const status = row.detached ? null : (state as Status | null);
  const classes = [
    "be-node",
    `be-${row.shape}`,
    state === null ? (known ? "be-idle" : "be-unknown") : `be-${state}`,
    selected ? "be-selected" : "",
    dropTarget ? "be-drop" : "",
    dragged ? "be-dragged" : "",
  ].filter(Boolean);
  const label = [
    row.title,
    row.detached ? "detached" : "",
    state === null ? "" : STATE_WORDS[state],
    value === undefined ? "" : `value ${formatValue(value)}`,
    hasChildren && box.folded ? `${row.descendantKeys.length} nodes folded` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <g
      ref={nodeRef}
      className={classes.join(" ")}
      transform={`translate(${box.x},${box.y})`}
      role="treeitem"
      aria-level={row.detached ? 1 : row.depth + 1}
      aria-posinset={position.at}
      aria-setsize={position.of}
      aria-selected={selected}
      aria-expanded={hasChildren ? !box.folded : undefined}
      aria-label={label}
      tabIndex={focusable ? 0 : -1}
      data-key={row.key}
      onFocus={onFocus}
      onPointerEnter={() => onHover(true)}
      onPointerLeave={() => onHover(false)}
      onPointerDown={onPointerDown}
    >
      {box.folded && <rect className="be-under" x={4} y={4} width={w} height={h} rx={rx} />}
      <rect className="be-box" width={w} height={h} rx={rx} />
      <text className="be-title" x={tx} y={19}>
        {hasChildren && (
          <tspan className="be-chev" data-fold="">
            {box.folded ? "▸ " : "▾ "}
          </tspan>
        )}
        {row.glyph && <tspan className="be-glyph">{`${row.glyph} `}</tspan>}
        {row.title}
      </text>
      {box.lines.map((line, i) => (
        <text key={i} className="be-line" x={tx} y={36 + 15 * i}>
          {line}
        </text>
      ))}
      {row.ports.map((p, i) => (
        <circle
          key={p.name}
          className={`be-port${p.sources.length ? " be-wired" : ""}`}
          cx={0}
          cy={portY(box, i)}
          r={3.2}
        />
      ))}
      {box.outputLines.map((line, i) => (
        <text
          key={`out-${i}`}
          className="be-line be-output"
          x={w - 11}
          y={4 + outputY(box, i)}
          textAnchor="end"
        >
          {line}
        </text>
      ))}
      {row.outputs.map((o, i) => (
        <circle
          key={`out-${o.name}`}
          className={`be-port be-out${o.text ? " be-wired" : ""}`}
          cx={w}
          cy={outputY(box, i)}
          r={3.2}
        />
      ))}
      {box.minis && (
        <g className="be-minis">
          {box.minis.map((m, i) => (
            <rect
              key={m.key}
              className={`be-mini be-${miniStates[i] ?? "idle"}`}
              x={tx + i * 11}
              y={h - 15}
              width={8}
              height={8}
              rx={2}
            />
          ))}
          {row.descendantKeys.length > MINI && (
            <text className="be-line" x={tx + MINI * 11 + 2} y={h - 7}>
              {`+${row.descendantKeys.length - MINI}`}
            </text>
          )}
        </g>
      )}
      {value !== undefined && <ValueLabel value={value} change={change} w={w} />}
      {box.pill && (
        <g className={`be-pill be-${status ?? "none"}`}>
          <rect x={w - 27} y={7} width={19} height={15} rx={3} />
          <text x={w - 17.5} y={18} textAnchor="middle">
            {status ?? "–"}
          </text>
        </g>
      )}
    </g>
  );
}

const VALUE_CHARS = 12;

/** A node's return value, set in its top border at the right, colored by whether it changed. */
function ValueLabel({
  value,
  change,
  w,
}: {
  value: Value;
  change: "changed" | "same" | undefined;
  w: number;
}) {
  const full = formatValue(value);
  const text = full.length > VALUE_CHARS ? `${full.slice(0, VALUE_CHARS - 1)}…` : full;
  const width = text.length * 6.2 + 10;
  return (
    <g className={`be-value be-${change ?? "same"}`} aria-hidden="true">
      <rect x={w - width - 34} y={-9} width={width} height={16} rx={3} />
      <text x={w - 39} y={2.5} textAnchor="end">
        {text}
      </text>
    </g>
  );
}
