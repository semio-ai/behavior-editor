import { nativeWrites } from "../runtime/natives";
import type { DiagramPort, DiagramRow, DiagramSource } from "./diagram-rows";

/**
 * Where the diagram puts each node, edge and wire. Top-down, as behavior-tree
 * editors draw it; a node stacks its children in an indented column when they
 * are all leaves and more than four, or wider side by side than `STACK_WIDTH`,
 * or, holding subtrees, wider than `SUBTREE_STACK_WIDTH`; in such a column, a
 * node holding a few leaves holds them in a row on its right. The detached
 * nodes go in columns left of the tree, each column after the columns it
 * reads from, each node level with the ports it feeds. A folded node hides
 * its subtree, shows one square per node it hides, and stands for them at
 * either end of a wire.
 *
 * A packed node lists less and joins its wires: its ports bound to keys no
 * node writes, when there are `PACK_MIN` or more, in one summary line, as its
 * outputs to keys no node reads; the ports reading one same node on one line,
 * which one wire reaches; a port its function writes back on one line with
 * its output; an output no node reads and written nowhere, not at all. The
 * same ports of a node not packed are listed one by one, those keys under a
 * header line.
 */
export interface DiagramLayout {
  boxes: Map<string, Box>;
  /** The parent-to-child edges of the tree. */
  edges: { from: string; to: string; d: string }[];
  /** The data wires: from the output a node produces, on its right edge, to the port reading it. */
  wires: Wire[];
  /** On a packed node, the count of the links reaching a line where more than one does. */
  badges: Badge[];
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
  /**
   * The line each output is on: among `outputLines`, or among `lines` for an
   * output packed with the port it writes back (`inline`); -1 for one a
   * packed node does not list, read by no node and written nowhere.
   */
  outputLine: number[];
  inline: boolean[];
  /**
   * The lines summing up, or heading, the ports bound to keys no node writes
   * and the outputs to keys no node reads.
   */
  summaries: Summary[];
  /** Whether packing would change it, and whether it is packed. */
  packable: boolean;
  packed: boolean;
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
  /**
   * What it carries, one entry per link packed into it: `@node.output` read by
   * reference, `{key}` through a key.
   */
  carries: string[];
  /** Whether it goes through keys only: a node writes them, the reader reads them. */
  store: boolean;
}

/** The count of the links reaching a packed node's line, and its place, left of the line. */
export interface Badge {
  to: string;
  x: number;
  y: number;
  count: number;
  /** What the links carry, and from where, one per line. */
  title: string;
}

/** A line summing up keys: lines `from` to `to` of the inputs, or of the outputs. */
export interface Summary {
  output: boolean;
  from: number;
  to: number;
  /** Each key it stands for, with its port or output, one per line. */
  title: string;
}

export interface LayoutOptions {
  /** The rows packed. */
  packed?: ReadonlySet<string>;
  /** Whether to link a node writing a key to each node reading it (default true). */
  storeLinks?: boolean;
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
/** A summary of keys wraps shorter: it is read at a glance, not edited. */
const SUMMARY_WRAP = 32;
/** How wide leaves side by side may run before they stack in a column. */
const STACK_WIDTH = 640;
/** How wide subtrees side by side may run before they stack in a column. */
const SUBTREE_STACK_WIDTH = 1280;
/** How many leaves a node in a column holds in a row, at most. */
const ROW_MAX = 3;
/** The room a row leaves under it, past `SG`, for the wires along it. */
const ROW_GAP = 8;
/** How many ports bound to keys no node writes a packed node sums up in one line, at least. */
export const PACK_MIN = 3;

/** The y of port `i`'s line, from the top of its box. */
export const portY = (box: Box, i: number) => 32 + LINE * box.portLine[i]!;

/** The y of output `i`'s line, from the top of its box. */
export const outputY = (box: Box, i: number) =>
  box.outputLine[i]! < 0
    ? 15
    : 32 + LINE * (box.inline[i] ? box.outputLine[i]! : box.lines.length + box.outputLine[i]!);

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

/** A key's segments and the separators between them: `sim/base.position`: `sim`, `/`, `base`, `.`, `position`. */
const tokens = (key: string) => key.split(/([./])/);

/**
 * `keys` in short: grouped by their first segment, a group by what its keys
 * share then each one's rest, `joints.{position,velocity}`; or, past `max`
 * characters, or a group past `part`, by what they share alone, `joints`. A
 * group of one is its key.
 */
export function keySummary(keys: readonly string[], max: number, part = max): string {
  const groups = new Map<string, string[]>();
  for (const key of keys) {
    const first = tokens(key)[0]!;
    groups.set(first, [...(groups.get(first) ?? []), key]);
  }
  const shared = (group: string[]) => {
    const split = group.map(tokens);
    const same = (n: number) => split.every((t) => n < t.length - 1 && t[n] === split[0]![n]);
    let n = 0;
    while (same(n)) n += 1;
    // End on a segment, not a separator.
    if (n % 2 === 0) n -= 1;
    return n;
  };
  const parts = (detailed: boolean) =>
    [...groups.values()].map((group) => {
      if (group.length === 1) return group[0]!;
      const n = shared(group);
      const prefix = tokens(group[0]!).slice(0, n).join("");
      if (!detailed) return prefix;
      const rests = group.map((k) => tokens(k).slice(n + 1).join(""));
      return `${prefix}${tokens(group[0]!)[n]}{${rests.join(",")}}`;
    });
  const detailed = parts(true);
  return detailed.join(", ").length <= max && detailed.every((p) => p.length <= part)
    ? detailed.join(", ")
    : parts(false).join(", ");
}

/** How many keys and which: `▸ 15 keys: command, imu, …` packed, `▾ 15 keys` listing them. */
function summaryText(keys: readonly string[], packed: boolean): string {
  const head = `${packed ? "▸" : "▾"} ${keys.length} keys`;
  if (!packed) return head;
  return `${head}: ${keySummary(keys, 2 * SUMMARY_WRAP - head.length - 2, SUMMARY_WRAP - 2)}`;
}

/**
 * The lines of `row`'s ports and outputs, packed or not (above); `sources`,
 * each port's, as drawn; `linked`, whether each output is read.
 */
function ioLines(
  row: DiagramRow,
  sources: readonly DiagramSource[][],
  linked: readonly boolean[],
  producerOf: (source: DiagramSource) => string,
  packed: boolean,
) {
  const { ports, outputs } = row;
  const outputIndex = new Map(outputs.map((o, i) => [o.name, i]));
  // The parameters a native writes and does not read, as `set_string` its `variable`.
  const writeOnly = new Set(
    Object.entries(row.entry?.signature.function.parameters ?? {})
      .filter(([id]) => nativeWrites(row.entry!.signature.id, id))
      .map(([, p]) => p.name),
  );
  // The ports bound to keys no node writes, and the outputs to keys no node
  // reads, but those a port writes back.
  const keyed = ports.flatMap((p, i) =>
    p.key !== undefined && !sources[i]!.length && !outputIndex.has(p.name) ? [i] : [],
  );
  const sinks = outputs.flatMap((o, i) =>
    o.key !== undefined && !linked[i] && !ports.some((p) => p.name === o.name) ? [i] : [],
  );
  const inputGroup = keyed.length >= PACK_MIN ? new Set(keyed) : new Set<number>();
  const outputGroup = sinks.length >= PACK_MIN ? new Set(sinks) : new Set<number>();
  // The ports reading the same nodes, each set of them on one line when packed.
  const readsFrom = sources.map((list) => [...new Set(list.map(producerOf))].sort().join(" "));
  const together = new Map<string, number[]>();
  ports.forEach((_, i) => {
    if (!readsFrom[i] || inputGroup.has(i)) return;
    together.set(readsFrom[i], [...(together.get(readsFrom[i]) ?? []), i]);
  });
  const writesBack = ports.some((p) => outputIndex.has(p.name));
  const packable =
    inputGroup.size > 0 ||
    outputGroup.size > 0 ||
    writesBack ||
    [...together.values()].some((g) => g.length > 1);

  const lines: string[] = [];
  const portLine: number[] = [];
  const outputLine: number[] = [];
  const inline = outputs.map(() => false);
  const summaries: Summary[] = [];
  const push = (text: string, wrap = WRAP) => {
    const at = lines.length;
    lines.push(...wrapText(text, wrap));
    return at;
  };
  const portText = (p: DiagramPort) => `${p.name}  ${p.text}`;
  const titleOf = (members: number[], text: (i: number) => string) =>
    members.map(text).join("\n");
  ports.forEach((p, i) => {
    if (portLine[i] !== undefined) return;
    if (inputGroup.has(i)) {
      const members = [...inputGroup];
      const from = push(summaryText(members.map((m) => ports[m]!.key!), packed), SUMMARY_WRAP);
      summaries.push({
        output: false,
        from,
        to: lines.length - 1,
        title: titleOf(members, (m) => portText(ports[m]!)),
      });
      for (const m of members) portLine[m] = packed ? from : push(`  ${portText(ports[m]!)}`);
      return;
    }
    const written = outputIndex.get(p.name);
    if (packed && written !== undefined) {
      portLine[i] = push(`${p.name} ${writeOnly.has(p.name) ? "→" : "⇄"} ${p.text}`);
      outputLine[written] = portLine[i];
      inline[written] = true;
      return;
    }
    const group = packed && readsFrom[i] ? together.get(readsFrom[i])! : [i];
    const at = push(
      group.length > 1
        ? `${group.map((m) => ports[m]!.name).join(", ")}  ${group
            .map((m) => ports[m]!.text)
            .join(", ")}`
        : portText(p),
    );
    for (const m of group) portLine[m] = at;
  });

  const outputLines: string[] = [];
  const pushOutput = (text: string, wrap = WRAP) => {
    const at = outputLines.length;
    outputLines.push(...wrapText(text, wrap));
    return at;
  };
  outputs.forEach((o, i) => {
    if (inline[i] || outputLine[i] !== undefined) return;
    if (outputGroup.has(i)) {
      const members = [...outputGroup];
      const from = pushOutput(
        summaryText(members.map((m) => outputs[m]!.key!), packed),
        SUMMARY_WRAP,
      );
      summaries.push({
        output: true,
        from,
        to: outputLines.length - 1,
        title: titleOf(members, (m) => outputText(outputs[m]!)),
      });
      for (const m of members) outputLine[m] = packed ? from : pushOutput(outputText(outputs[m]!));
      return;
    }
    outputLine[i] = packed && o.key === undefined && !linked[i] ? -1 : pushOutput(outputText(o));
  });
  return { lines, portLine, outputLines, outputLine, inline, summaries, packable };
}

interface TreeBox extends Box {
  children: TreeBox[];
  W: number;
  H: number;
  CW: number;
  stacked: boolean;
  /** Whether it holds its leaves in a row on its right: a node of a column holding a few leaves. */
  inRow: boolean;
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
 * producer to farthest right.
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
  return orthogonal(from, to, [x1, y1], [x2, y2], boxes, lanes, corridors, x0);
}

/**
 * The path of a wire from `from`'s output at `start` to `to`'s port at `end`,
 * on its right, along the gaps between nodes: out to the right, along a
 * corridor down or up, along a lane, and into the port from its left. Lanes
 * come in order: the port's own line, in the gap over the reader,
 * just over it, in the gap
 * between the two nodes, over both, under both; corridors from nearest the
 * producer, `offset` further for each output, so the wires of one output
 * share their way out and those of two outputs run side by side; or, for a
 * port several wires reach (`fanIn`), from nearest the reader, so they share
 * their way in. A lane keeps clear of the nodes it passes by a few pixels.
 */
function routeForward(
  from: Box,
  to: Box,
  [x1, y1]: readonly [number, number],
  [x2, y2]: readonly [number, number],
  boxes: readonly Box[],
  offset: number,
  fanIn: boolean,
): string {
  const x0 = x2 - 7;
  const below = to.y - (from.y + from.h);
  const above = from.y - (to.y + to.h);
  // The gap over the reader, up to the nearest node above it on the way.
  const over = Math.max(
    -Infinity,
    ...boxes
      .filter((b) => b !== from && b.y + b.h <= to.y && b.x < x2 && b.x + b.w > x1)
      .map((b) => b.y + b.h),
  );
  const lanes = [
    y2,
    // A third of the way up, below the edges a parent draws midway.
    ...(Number.isFinite(over) ? [to.y - (to.y - over) / 3] : []),
    to.y - 4,
    ...(below > 0 ? [from.y + from.h + below / 2] : []),
    ...(above > 0 ? [to.y + to.h + above / 2] : []),
    // Over both, clear of the edges from their parent, over both.
    Math.min(from.y, to.y) - 6,
    Math.max(from.y + from.h, to.y + to.h) + 8,
  ];
  const corridors = [
    ...new Set(
      [x1 + 9 + offset, ...boxes.map((b) => b.x + b.w + 9 + offset), x0].filter(
        (x) => x > x1 && x <= x0,
      ),
    ),
  ].sort((a, b) => (fanIn ? b - a : a - b));
  return orthogonal(from, to, [x1, y1], [x2, y2], boxes, lanes, corridors, x0, 5);
}

/**
 * The first route, lane by lane then corridor by corridor, whose every
 * segment clears every node, the two it joins included; with none, the one
 * crossing the fewest.
 */
function orthogonal(
  from: Box,
  to: Box,
  [x1, y1]: readonly [number, number],
  [x2, y2]: readonly [number, number],
  boxes: readonly Box[],
  lanes: readonly number[],
  corridors: readonly number[],
  x0: number,
  margin = 2,
): string {
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
            crosses(segment, b, b === from || b === to ? 0 : margin),
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
  return lane === y2
    ? `M${x1},${y1} H${xr} V${y2} H${x2}`
    : `M${x1},${y1} H${xr} V${lane} H${x0} V${y2} H${x2}`;
}

/**
 * Whether the curve from `a` to `d`, its control points `b` and `c`, clears
 * every node but the two it joins, which it leaves and enters by their edges.
 */
function curveClear(
  a: readonly [number, number],
  b: readonly [number, number],
  c: readonly [number, number],
  d: readonly [number, number],
  from: Box,
  to: Box,
  boxes: readonly Box[],
): boolean {
  const at = (t: number) => {
    const u = 1 - t;
    const [w0, w1, w2, w3] = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
    return [
      w0 * a[0] + w1 * b[0] + w2 * c[0] + w3 * d[0],
      w0 * a[1] + w1 * b[1] + w2 * c[1] + w3 * d[1],
    ] as const;
  };
  const points = Array.from({ length: 25 }, (_, i) => at(i / 24));
  return boxes.every(
    (box) =>
      box === from ||
      box === to ||
      points.every(
        ([x, y], i) =>
          i === 0 || !crosses([points[i - 1]![0], points[i - 1]![1], x, y], box, 4),
      ),
  );
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
  { packed = new Set(), storeLinks = true }: LayoutOptions = {},
): DiagramLayout {
  const byKey = new Map(rows.map((r) => [r.key, r]));
  const sourcesOf = (p: DiagramPort) =>
    storeLinks ? p.sources : p.sources.filter((s) => s.via === undefined);
  const shownOf = (key: string) => visibleKey(byKey, key, folds);
  const read = new Set(
    rows.flatMap((r) => r.ports.flatMap((p) => sourcesOf(p).map((s) => `${s.key}>${s.output}`))),
  );
  const boxes = new Map<string, TreeBox>();
  for (const row of rows) {
    if (shownOf(row.key) !== row.key) continue;
    const folded = row.childKeys.length > 0 && folds.has(row.key);
    const pill = !row.detached;
    const io = ioLines(
      row,
      row.ports.map(sourcesOf),
      row.outputs.map((o) => read.has(`${row.key}>${o.name}`)),
      (source) => shownOf(source.key),
      packed.has(row.key),
    );
    const { lines, outputLines } = io;
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
      ...io,
      packed: io.packable && packed.has(row.key),
      minis,
      folded,
      pill,
      children: [],
      W: w,
      H: h,
      CW: 0,
      stacked: false,
      inRow: false,
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
    n.stacked = n.children.every((c) => !c.children.length)
      ? k > 4 || sideBySide > STACK_WIDTH
      : sideBySide > SUBTREE_STACK_WIDTH;
    if (n.stacked) {
      // A subtree of a few leaves in the column holds them in a row on its right.
      for (const c of n.children) {
        const leaves = c.children;
        if (!leaves.length || leaves.length > ROW_MAX || leaves.some((l) => l.children.length)) {
          continue;
        }
        c.inRow = true;
        c.W = c.w + leaves.reduce((s, l) => s + HG + l.W, 0);
        // Room under the row for the wires to the next one.
        c.H = Math.max(c.h, ...leaves.map((l) => l.H)) + ROW_GAP;
      }
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
    if (n.inRow) {
      let cx = x + n.w + HG;
      for (const c of n.children) {
        place(c, cx, y);
        cx += c.W + HG;
      }
      return;
    }
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
      for (const s of sourcesOf(p)) {
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
        if (!sourcesOf(p).some((source) => source.key === f.row.key)) return;
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
      // In a row, one line from the node's right through its leaves, each drawn over it.
      const d = n.inRow
        ? `M${n.x + n.w},${n.y + 15} H${c.x}`
        : n.stacked
          ? `M${n.x + 14},${n.y + n.h} V${c.y + Math.min(c.h / 2, 16)} H${c.x}`
          : `M${n.x + n.w / 2},${n.y + n.h} V${n.y + n.h + VG / 2} H${c.x + c.w / 2} V${c.y}`;
      edges.push({ from: n.row.key, to: c.row.key, d });
    }
  }

  // Each link from an output to a port, joined into one wire per line it
  // reaches on a packed node: the first output it reads is where it leaves.
  interface Link {
    from: TreeBox;
    to: TreeBox;
    output: number;
    port: number | null;
    carries: string[];
    store: boolean;
  }
  const links = new Map<string, Link>();
  const nameOf = (key: string) => byKey.get(key)?.node.name?.text ?? key;
  for (const row of rows) {
    row.ports.forEach((p, i) => {
      for (const source of sourcesOf(p)) {
        const from = boxes.get(shownOf(source.key));
        const to = boxes.get(shownOf(row.key));
        if (!from || !to || from === to) continue;
        const direct = to.row === row;
        // A wire leaves the output it reads, or the top of a folded node standing for its producer.
        const output =
          from.row.key === source.key
            ? from.row.outputs.findIndex((o) => o.name === source.output)
            : -1;
        const end = direct ? (to.packed ? `L${to.portLine[i]}` : `${i}`) : "folded";
        const id = to.packed
          ? `${from.row.key}>${to.row.key}@${end}`
          : `${from.row.key}.${output >= 0 ? from.row.outputs[output]!.name : "top"}>${
              to.row.key
            }@${end}${source.via === undefined ? "" : `{${source.via}}`}`;
        const carries =
          source.via === undefined ? `@${nameOf(source.key)}.${source.output}` : `{${source.via}}`;
        const link = links.get(id);
        if (!link) {
          links.set(id, {
            from,
            to,
            output,
            port: direct ? i : null,
            carries: [carries],
            store: source.via !== undefined,
          });
        } else if (!link.carries.includes(carries)) {
          link.carries.push(carries);
          link.store &&= source.via !== undefined;
        }
      }
    });
  }

  const all = [...boxes.values()];
  const reaching = new Map<string, number>();
  for (const { to, port } of links.values()) {
    const at = `${to.row.key}@${port === null ? "folded" : portY(to, port)}`;
    reaching.set(at, (reaching.get(at) ?? 0) + 1);
  }
  const wires: Wire[] = [];
  const badges = new Map<string, Badge>();
  for (const [id, { from, to, output, port, carries, store }] of links) {
    const x1 = from.x + from.w;
    const y1 = from.y + (output >= 0 ? outputY(from, output) : 15);
    const x2 = to.x;
    const y2 = to.y + (port === null ? 15 : portY(to, port));
    // A wire to a reader on the right curves across the gap between them,
    // its control points within it, when the curve crosses no node; or goes
    // along the gaps between nodes, sharing its way out with the other wires
    // of its output. Any other goes around the right of both nodes, then
    // across the gap below its producer when the reader is under it, or over
    // the top of both, and into the port from its left, so it crosses neither.
    const bend = Math.min(Math.max(36, (x2 - x1) / 2), x2 - x1);
    const curve = `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
    const d =
      x2 <= x1
        ? routeBack(from, to, [x1, y1], [x2, y2], all)
        : curveClear([x1, y1], [x1 + bend, y1], [x2 - bend, y2], [x2, y2], from, to, all)
          ? curve
          : routeForward(
              from,
              to,
              [x1, y1],
              [x2, y2],
              all,
              4 * Math.max(output, 0),
              reaching.get(`${to.row.key}@${port === null ? "folded" : portY(to, port)}`)! > 1,
            );
    wires.push({ id, from: from.row.key, to: to.row.key, port, d, carries, store });
    if (!to.packed) continue;
    const at = `${to.row.key}@${y2}`;
    const badge = badges.get(at) ?? { to: to.row.key, x: x2 - 13, y: y2, count: 0, title: "" };
    badge.count += carries.length;
    badge.title += `${badge.title ? "\n" : ""}${nameOf(from.row.key)}: ${carries.join(", ")}`;
    badges.set(at, badge);
  }

  const right = Math.max(treeRight - Math.max(dx, 0), ...placed.map((o) => o.x + o.w));
  return {
    boxes,
    edges,
    wires,
    badges: [...badges.values()].filter((b) => b.count > 1),
    width: Math.max(right + PAD, 200),
    height: height + PAD,
    treeLeft,
  };
}
