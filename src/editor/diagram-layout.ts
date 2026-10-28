import type { DiagramRow } from "./diagram-rows";

/**
 * Where the diagram puts each node, edge and wire. Top-down, as behavior-tree
 * editors draw it; a node stacks its children in an indented column when they
 * are all leaves and more than four. The detached nodes go in columns left of
 * the tree, each column after the columns it reads from, each node level with
 * the ports it feeds. A folded node hides its subtree, shows one square per
 * node it hides, and stands for them at either end of a wire.
 */
export interface DiagramLayout {
  boxes: Map<string, Box>;
  /** The parent-to-child edges of the tree. */
  edges: { from: string; to: string; d: string }[];
  /** The data wires: from the right edge of a producing node to the port reading it. */
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
  /** The rows a folded node hides, one square each, up to `MINI`. */
  minis: DiagramRow[] | null;
  folded: boolean;
  pill: boolean;
}

export interface Wire {
  from: string;
  to: string;
  /** The port the wire reaches, or `null` when it reaches a folded node standing for the reader. */
  port: number | null;
  d: string;
}

const CH_T = 7.3;
const CH_S = 6.65;
const PAD = 20;
const HG = 18;
const VG = 30;
const IND = 24;
const SG = 8;
const GG = 64;
export const LINE = 15;
export const MINI = 18;
const FG = 44;
const WRAP = 46;

/** The y of port `i`'s line, from the top of its box. */
export const portY = (box: Box, i: number) => 32 + LINE * box.portLine[i]!;

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
    const minis = folded ? row.descendantKeys.slice(0, MINI).map((k) => byKey.get(k)!) : null;
    const chev = row.childKeys.length ? 2 : 0;
    const head =
      (row.title.length + (row.glyph ? row.glyph.length + 1 : 0) + chev) * CH_T + (pill ? 30 : 0);
    const textW = Math.max(
      head,
      ...lines.map((l) => l.length * CH_S + 4),
      minis ? minis.length * 11 + (row.descendantKeys.length > MINI ? 34 : 0) : 0,
    );
    const condition = row.shape === "condition";
    const w = Math.ceil(Math.max(condition ? 132 : 112, textW + (condition ? 36 : 24)));
    const h = (lines.length ? 28 + LINE * lines.length : 30) + (minis ? 16 : 0);
    boxes.set(row.key, {
      row,
      x: 0,
      y: 0,
      w,
      h,
      lines,
      portLine,
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
    n.stacked = k > 4 && n.children.every((c) => !c.children.length);
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

  // The detached nodes, in columns: each after the columns it reads from.
  const floats = [...boxes.values()].filter((b) => b.row.detached);
  const column = new Map<TreeBox, number>();
  for (const f of floats) {
    let k = 0;
    for (const p of f.row.ports) {
      for (const s of p.sources) {
        const producer = boxes.get(s);
        if (producer && column.has(producer)) k = Math.max(k, column.get(producer)! + 1);
      }
    }
    column.set(f, k);
  }
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
        if (!p.sources.includes(f.row.key)) return;
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
        const from = boxes.get(visibleKey(byKey, source, folds));
        const to = boxes.get(visibleKey(byKey, row.key, folds));
        if (!from || !to || from === to) continue;
        const direct = to.row === row;
        const x1 = from.x + from.w;
        const y1 = from.y + 15;
        const x2 = to.x;
        const y2 = to.y + (direct ? portY(to, i) : 15);
        const id = `${from.row.key}>${to.row.key}@${y2}`;
        if (seen.has(id)) continue;
        seen.add(id);
        // A wire that runs back and down goes around the right of both nodes
        // and into the port from above, so it crosses neither.
        const xr = Math.max(x1, to.x + to.w) + 9;
        const bend = Math.max(36, (x2 - x1) / 2);
        const d =
          x2 >= x1 + 24 || y2 < y1
            ? `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`
            : `M${x1},${y1} H${xr} V${to.y - 8} H${x2 - 10} V${y2} H${x2}`;
        wires.push({ from: from.row.key, to: to.row.key, port: direct ? i : null, d });
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
