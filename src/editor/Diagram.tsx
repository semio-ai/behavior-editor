import { useMemo, useRef, useState } from "react";
import type { DetachedActivity, Status, TickReport } from "../runtime/runtime";
import { type Box, type DiagramLayout, MINI, layoutDiagram, portY } from "./diagram-layout";
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
  onSelect(key: string): void;
  onToggleFold(key: string): void;
  onDelete(key: string): void;
  onMove(key: string, delta: -1 | 1): void;
  onDrop(key: string, drop: Drop): void;
}

const DRAG_THRESHOLD = 6;

/** What a row did this tick: its status when the tree holds it, its activity when detached. */
function stateOf(row: DiagramRow, report: TickReport | null): Status | DetachedActivity | null {
  if (!report || row.graphId === null) return null;
  if (row.detached) return report.detached?.[row.graphId] ?? null;
  return report.statuses?.[row.graphId] ?? null;
}

const live = (state: Status | DetachedActivity | null) => state !== null && state !== "idle";

const STATE_WORDS: Record<Status | DetachedActivity, string> = {
  S: "succeeded",
  F: "failed",
  R: "running",
  called: "called",
  cached: "cached",
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
  const states = new Map(rows.map((r) => [r.key, stateOf(r, report)]));
  const isLive = (key: string) => live(states.get(key) ?? null);
  const dropKey = drag?.drop && drag.drop.kind !== "detach" ? drag.drop.key : null;

  return (
    <div className="be-diagram" data-dragging={drag ? "" : undefined}>
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
              state={states.get(box.row.key) ?? null}
              miniStates={box.minis?.map((m) => states.get(m.key) ?? null) ?? []}
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
  state: Status | DetachedActivity | null;
  miniStates: (Status | DetachedActivity | null)[];
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
  state,
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
    state === null ? "be-idle" : `be-${state}`,
    selected ? "be-selected" : "",
    dropTarget ? "be-drop" : "",
    dragged ? "be-dragged" : "",
  ].filter(Boolean);
  const label = [
    row.title,
    row.detached ? "detached" : "",
    state === null ? "" : STATE_WORDS[state],
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
      {row.produces && <circle className="be-port be-wired" cx={w} cy={15} r={3.2} />}
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
