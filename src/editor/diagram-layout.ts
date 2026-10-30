import type { DiagramRow } from "./diagram-rows";

/**
 * Where the diagram puts each node, edge and wire. Top-down, as behavior-tree
 * editors draw it; a node stacks its children in an indented column when they
 * are all leaves and more than four, or wider side by side than `STACK_WIDTH`. The detached nodes go in columns left of
 * the tree, each column after the columns it reads from, each node level with
 * the ports it feeds. A folded node hides its subtree, shows one square per
 * node it hides, and stands for them at either end of a wire.
 */
export interface DiagramLayout {
  boxes: Map<string, Box>;
  /** The parent-to-child edges of the tree. */
  edges: { from: string; to: string; d: string }[];
  /** The data wires: from the output a node produces, on its right edge, to the port reading it. */
  wires: Wire[];
  width: number;
  height: number;
  /** The x past which the tree begins: dropping a node left of it detaches it. */
  treeLeft: number;
}

export interface Box {
  row: DiagramRow;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The text lines under the title: one or more per port. */
  lines: string[];
  /** The line each port starts on. */
  portLine: number[];
  /** The output lines, under the ports: each output's name and where it is written. */
  outputLines: string[];
  /** The rows a folded node hides, one square each, up to `MINI`. */
  minis: DiagramRow[] | null;
  folded: boolean;
  pill: boolean;
}

export interface Wire {
  /** What tells it from every other wire: its ends, with the output and the port it joins. */
  id: string;
  from: string;
  to: string;
  /** The port the wire reaches, or `null` when it reaches a folded node standing for the reader. */
  port: number | null;
  d: string;
}

const CH_T = 7.3;
const CH_S = 6.65;
export const PAD = 20;
const HG = 18;
const VG = 30;
const IND = 24;
const SG = 8;
const GG = 64;
export const LINE = 15;
export const MINI = 18;
const FG = 44;
const WRAP = 46;
/** How wide leaves side by side may run before they stack in a column. */
const STACK_WIDTH = 640;

/** The y of port `i`'s line, from the top of its box. */
export const portY = (box: Box, i: number) => 32 + LINE * box.portLine[i]!;

/** The y of output `i`'s line, from the top of its box. */
export const outputY = (box: Box, i: number) => 32 + LINE * (box.lines.length + i);

/** An output's line: `{face/level} ← _ret`, or its name alone when it is written nowhere. */
export const outputText = (o: { name: string; text: string }) =>
  o.text ? `${o.text} ← ${o.name}` : o.name;

function wrapText(s: string, max: number): string[] {
  if (s.length <= max) return [s];
  const lines: string[] = [];
  let rest = s;
  while (rest.length > max) {
    let cut = Math.max(rest.lastIndexOf(", ", max), rest.lastIndexOf(" ", max));
    cut = cut > max * 0.4 ? cut + 1 : max;
    lines.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  lines.push(rest);
  return lines;
}

interface TreeBox extends Box {
  children: TreeBox[];
  W: number;
  H: number;
  CW: number;
  stacked: boolean;
}

/** A segment of a route, along one axis: `[x1, y1, x2, y2]`. */
type Segment = readonly [number, number, number, number];

/** Whether `segment` runs through `box`, `margin` around it, rather than along or past it. */
function crosses(segment: Segment, box: Box, margin: number): boolean {
  const [ax, ay, bx, by] = segment;
  const [left, right] = [Math.min(ax, bx), Math.max(ax, bx)];
  const [top, bottom] = [Math.min(ay, by), Math.max(ay, by)];
  return (
    left < box.x + box.w + margin &&
    right > box.x - margin &&
    top < box.y + box.h + margin &&
    bottom > box.y - margin
  );
}

/**
 * The path of a wire from `from`'s output at `start` back to `to`'s port at
 * `end`, which is not on its right: out to the right, along a corridor down
 * or up, along a lane, and into the port from its left. Lanes come in order:
 * in the gap between the two nodes when one is above the other, nearest the
 * reader then midway, over both, under both; corridors from nearest the
 * producer to farthest right. The route taken is the first whose every
 * segment clears every node, the two it joins included; with none, the one
 * crossing the fewest.
 */
function routeBack(
  from: Box,
  to: Box,
  [x1, y1]: readonly [number, number],
  [x2, y2]: readonly [number, number],
  boxes: readonly Box[],
): string {
  const x0 = x2 - 10;
  const below = to.y - (from.y + from.h);
  const above = from.y - (to.y + to.h);
  const lanes = [
    ...(below > 0 ? [to.y - Math.min(SG / 2, below / 2), from.y + from.h + below / 2] : []),
    ...(above > 0 ? [to.y + to.h + Math.min(SG / 2, above / 2), to.y + to.h + above / 2] : []),
    Math.min(from.y, to.y) - 8,
    Math.max(from.y + from.h, to.y + to.h) + 8,
  ];
  const corridors = [
    ...new Set([x1, ...boxes.map((b) => b.x + b.w)].filter((x) => x >= x1).map((x) => x + 9)),
  ].sort((a, b) => a - b);
  const crossings = (xr: number, lane: number) => {
    const segments: Segment[] = [
      [x1, y1, xr, y1],
      [xr, y1, xr, lane],
      [xr, lane, x0, lane],
      [x0, lane, x0, y2],
    ];
    // A wire leaves its producer's edge and enters its reader's.
    return boxes.reduce(
      (count, b) =>
        count +
        segments.filter(
          (segment, i) =>
            !((b === from && i === 0) || (b === to && i === 3)) &&
            crosses(segment, b, b === from || b === to ? 0 : 2),
        ).length,
      0,
    );
  };
  let route: readonly [number, number, number] = [corridors[0]!, lanes[0]!, Infinity];
  search: for (const lane of lanes) {
    for (const xr of corridors) {
      const count = crossings(xr, lane);
      if (count < route[2]) route = [xr, lane, count];
      if (count === 0) break search;
    }
  }
  const [xr, lane] = route;
  return `M${x1},${y1} H${xr} V${lane} H${x0} V${y2} H${x2}`;
}

/** The row standing for `key` with `folds`: its outermost folded ancestor, or itself. */
export function visibleKey(
  rows: ReadonlyMap<string, DiagramRow>,
  key: string,
  folds: ReadonlySet<string>,
): string {
  let shown = key;
  for (let a = rows.get(key)?.parentKey ?? null; a !== null; a = rows.get(a)?.parentKey ?? null) {
    if (folds.has(a)) shown = a;
  }
  return shown;
}

export function layoutDiagram(
  rows: readonly DiagramRow[],
  folds: ReadonlySet<string>,
): DiagramLayout {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const boxes = new Map<string, TreeBox>();
  for (const row of rows) {
    if (visibleKey(byKey, row.key, folds) !== row.key) continue;
    const folded = row.childKeys.length > 0 && folds.has(row.key);
    const pill = !row.detached;
    const lines: string[] = [];
    const portLine = row.ports.map((p) => {
      const at = lines.length;
      lines.push(...wrapText(`${p.name}  ${p.text}`, WRAP));
      return at;
    });
    const outputLines = row.outputs.map(outputText);
    const minis = folded ? row.descendantKeys.slice(0, MINI).map((k) => byKey.get(k)!) : null;
    const chev = row.childKeys.length ? 2 : 0;
    const head =
      (row.title.length + (row.glyph ? row.glyph.length + 1 : 0) + chev) * CH_T + (pill ? 30 : 0);
    const textW = Math.max(
      head,
      ...[...lines, ...outputLines].map((l) => l.length * CH_S + 4),
      minis ? minis.length * 11 + (row.descendantKeys.length > MINI ? 34 : 0) : 0,
    );
    const condition = row.shape === "condition";
    const w = Math.ceil(Math.max(condition ? 132 : 112, textW + (condition ? 36 : 24)));
    const textLines = lines.length + outputLines.length;
    const h = (textLines ? 28 + LINE * textLines : 30) + (minis ? 16 : 0);
    boxes.set(row.key, {
      row,
      x: 0,
      y: 0,
      w,
      h,
      lines,
      portLine,
      outputLines,
      minis,
      folded,
      pill,
      children: [],
      W: w,
      H: h,
      CW: 0,
      stacked: false,
    });
  }
  for (const box of boxes.values()) {
    const parent = box.row.parentKey === null ? undefined : boxes.get(box.row.parentKey);
    if (parent) parent.children.push(box);
  }

  const size = (n: TreeBox) => {
    n.children.forEach(size);
    const k = n.children.length;
    if (!k) {
      n.W = n.w;
      n.H = n.h;
      return;
    }
    const sideBySide = n.children.reduce((s, c) => s + c.W, 0) + HG * (k - 1);
    n.stacked = n.children.every((c) => !c.children.length) && (k > 4 || sideBySide > STACK_WIDTH);
    if (n.stacked) {
      n.W = Math.max(n.w, IND + Math.max(...n.children.map((c) => c.W)));
      n.H = n.h + 14 + n.children.reduce((s, c) => s + c.H, 0) + SG * (k - 1);
    } else {
      n.CW = n.children.reduce((s, c) => s + c.W, 0) + HG * (k - 1);
      n.W = Math.max(n.w, n.CW);
      n.H = n.h + VG + Math.max(...n.children.map((c) => c.H));
    }
  };
  const place = (n: TreeBox, x: number, y: number) => {
    n.x = x;
    n.y = y;
    if (!n.children.length) return;
    if (n.stacked) {
      let cy = y + n.h + 14;
      for (const c of n.children) {
        place(c, x + IND, cy);
        cy += c.H + SG;
      }
      return;
    }
    let cx = x + Math.max(0, (n.w - n.CW) / 2);
    for (const c of n.children) {
      place(c, cx, y + n.h + VG);
      cx += c.W + HG;
    }
    const a = n.children[0]!;
    const b = n.children.at(-1)!;
    const mid = (a.x + a.w / 2 + b.x + b.w / 2) / 2;
    n.x = Math.min(Math.max(mid - n.w / 2, x), x + n.W - n.w);
  };

  // The detached nodes, in columns: each after the columns it reads from,
  // whatever their order in the file. A node a cycle reaches again, in a
  // document that does not resolve, counts as no column.
  const floats = [...boxes.values()].filter((b) => b.row.detached);
  const detached = new Set(floats);
  const column = new Map<TreeBox, number>();
  const ranking = new Set<TreeBox>();
  const columnOf = (f: TreeBox): number => {
    const known = column.get(f);
    if (known !== undefined) return known;
    if (ranking.has(f)) return -1;
    ranking.add(f);
    let k = 0;
    for (const p of f.row.ports) {
      for (const s of p.sources) {
        const producer = boxes.get(s.key);
        if (producer && detached.has(producer)) k = Math.max(k, columnOf(producer) + 1);
      }
    }
    ranking.delete(f);
    column.set(f, k);
    return k;
  };
  floats.forEach(columnOf);
  const columnW: number[] = [];
  for (const f of floats) {
    const j = column.get(f)!;
    columnW[j] = Math.max(columnW[j] ?? 0, f.w);
  }
  const floatW = columnW.length
    ? columnW.reduce((a, b) => a + b, 0) + FG * (columnW.length - 1) + GG
    : 0;

  const root = boxes.get("0");
  let height = PAD;
  let treeRight = PAD + floatW;
  if (root) {
    size(root);
    place(root, PAD + floatW, PAD);
    height = Math.max(height, PAD + root.H);
    treeRight = PAD + floatW + root.W;
  }
  const treeBoxes = [...boxes.values()].filter((b) => !b.row.detached);
  const placed: TreeBox[] = [...treeBoxes];
  const hits = (x: number, y: number, f: TreeBox) =>
    placed.some(
      (o) => x < o.x + o.w + 12 && o.x < x + f.w + 12 && y < o.y + o.h + 10 && o.y < y + f.h + 10,
    );
  // The column nearest the tree goes first, so a node's readers are placed before it.
  const order = [...floats].sort((a, b) => column.get(b)! - column.get(a)!);
  for (const f of order) {
    const j = column.get(f)!;
    const x0 = PAD + columnW.slice(0, j).reduce((a, b) => a + b, 0) + FG * j;
    const ys: number[] = [];
    const xs: number[] = [];
    for (const row of rows) {
      row.ports.forEach((p, i) => {
        if (!p.sources.some((source) => source.key === f.row.key)) return;
        const to = boxes.get(visibleKey(byKey, row.key, folds));
        if (!to || to === f || !placed.includes(to)) return;
        ys.push(to.y + (to.row === row ? portY(to, i) : 15) - 15);
        xs.push(to.x);
      });
    }
    f.x = Math.max(x0, (xs.length ? Math.min(...xs) : x0 + f.w + FG) - FG - f.w);
    f.y = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : PAD;
    while (hits(f.x, f.y, f)) f.y += 6;
    placed.push(f);
    height = Math.max(height, f.y + f.h);
  }
  // Drop the margin the columns reserved but no node used.
  const dx = placed.length ? Math.min(...placed.map((o) => o.x)) - PAD : 0;
  if (dx > 0) for (const o of placed) o.x -= dx;
  const treeLeft = root ? root.x - Math.max(0, (root.W - root.w) / 2) : PAD;

  const edges: DiagramLayout["edges"] = [];
  for (const n of treeBoxes) {
    for (const c of n.children) {
      const d = n.stacked
        ? `M${n.x + 14},${n.y + n.h} V${c.y + Math.min(c.h / 2, 16)} H${c.x}`
        : `M${n.x + n.w / 2},${n.y + n.h} V${n.y + n.h + VG / 2} H${c.x + c.w / 2} V${c.y}`;
      edges.push({ from: n.row.key, to: c.row.key, d });
    }
  }

  const wires: Wire[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    row.ports.forEach((p, i) => {
      for (const source of p.sources) {
        const from = boxes.get(visibleKey(byKey, source.key, folds));
        const to = boxes.get(visibleKey(byKey, row.key, folds));
        if (!from || !to || from === to) continue;
        const direct = to.row === row;
        const x1 = from.x + from.w;
        // A wire leaves the output it reads, or the top of a folded node standing for its producer.
        const output =
          from.row.key === source.key
            ? from.row.outputs.findIndex((o) => o.name === source.output)
            : -1;
        const y1 = from.y + (output >= 0 ? outputY(from, output) : 15);
        const x2 = to.x;
        const y2 = to.y + (direct ? portY(to, i) : 15);
        const id = `${from.row.key}.${output >= 0 ? from.row.outputs[output]!.name : "top"}>${
          to.row.key
        }@${direct ? i : "folded"}`;
        if (seen.has(id)) continue;
        seen.add(id);
        // A wire to a reader on the right curves across the gap between
        // them, its control points within it. Any other goes around the
        // right of both nodes, then across the gap below its producer when
        // the reader is under it, or over the top of both, and into the port
        // from its left, so it crosses neither.
        const back = x2 > x1 ? "" : routeBack(from, to, [x1, y1], [x2, y2], [...boxes.values()]);
        const bend = Math.min(Math.max(36, (x2 - x1) / 2), x2 - x1);
        const d =
          x2 > x1
            ? `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`
            : back;
        wires.push({ id, from: from.row.key, to: to.row.key, port: direct ? i : null, d });
      }
    });
  }

  const right = Math.max(treeRight - Math.max(dx, 0), ...placed.map((o) => o.x + o.w));
  return {
    boxes,
    edges,
    wires,
    width: Math.max(right + PAD, 200),
    height: height + PAD,
    treeLeft,
  };
}
