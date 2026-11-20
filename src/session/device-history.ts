/**
 * What a device did, step by step, as its client was pushed it: kept whole, for
 * a person to go back to any step while the device goes on. Engine-agnostic: it
 * reads the pushes any bridge client delivers, the device's clock
 * (`arora/time`), its store values, and the trace reports the language decodes.
 */
import type { Graph } from "../model/graph";
import { type Value, valueEquals, valueNumber, valuePlotted } from "../model/value";
import { RET } from "../runtime/natives";
import { type DetachedActivity, type Status, TIME_KEY } from "../runtime/runtime";
import type { TraceReport } from "../runtime/trace";

/** The device's state at one of its steps, as `DeviceHistory.at` rebuilds it. */
export interface HistoryState {
  /** The step's index in the history, from 0. */
  index: number;
  /** The device's clock at the step, in seconds; `null` before its first push carrying it. */
  time: number | null;
  /**
   * The interpreter's tick: the tick of the trace's last report, counted on with
   * each step after it, as the session counts it. `null` before a report.
   */
  tick: number | null;
  /** Every store key the device had pushed by then, at its value then. */
  store: Map<string, Value>;
  /** Each node's status, the trace's nodes as its reports left them, by node id. */
  statuses: Record<string, Status>;
  detached: Record<string, DetachedActivity>;
  /** Each watched node's return value. */
  values: Record<string, Value>;
  /** The revision of the behavior the device ran, from its `arora/behavior/revision`; `null` where it kept none. */
  revision: number | null;
  /** That behavior, as recorded; `null` where none was for its revision. */
  behavior: Graph | null;
}

export interface DeviceHistoryOptions {
  /** What the device held when the history started, its keys before any push. */
  base?: ReadonlyMap<string, Value>;
  /**
   * A pushed key's value as a trace report, or `null` for a key that is not a
   * trace's feedback: the session decodes it with its language.
   */
  report?: (key: string, value: Value) => TraceReport | null;
  /**
   * Whether a key is the clients' bookkeeping rather than the device's store
   * (by default, the interpreter's task keys, `arora/tasks/…`): it is not kept.
   */
  ignore?: (key: string) => boolean;
}

const STATUS_CODE: Record<Status, number> = { S: 1, F: 2, R: 3 };
const CODE_STATUS: (Status | undefined)[] = [undefined, "S", "F", "R"];
const ACTIVITY_CODE: Record<DetachedActivity, number> = { called: 1, cached: 2, idle: 3 };
const CODE_ACTIVITY: (DetachedActivity | undefined)[] = [undefined, "called", "cached", "idle"];
/** "no status", "no activity": the node left the trace's view. */
const NONE = 0;

const NUMERIC = new Set(["u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64", "f32", "f64"]);

/** A growable array of numbers. */
class Numbers {
  #data: Float64Array;
  length = 0;
  constructor(capacity = 16) {
    this.#data = new Float64Array(capacity);
  }
  push(n: number) {
    if (this.length === this.#data.length) {
      const grown = new Float64Array(this.#data.length * 2);
      grown.set(this.#data);
      this.#data = grown;
    }
    this.#data[this.length++] = n;
  }
  get(i: number): number {
    return this.#data[i]!;
  }
  setLast(n: number) {
    this.#data[this.length - 1] = n;
  }
  /** The last index whose number is at most `n`, the numbers rising; -1 when none is. */
  lastAtMost(n: number): number {
    let lo = 0;
    let hi = this.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      // A step before the device pushed its clock (NaN) comes before any time.
      const at = this.#data[mid]!;
      if (Number.isNaN(at) || at <= n) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  }
  bytes(): number {
    return this.#data.byteLength;
  }
}

/**
 * The changes of one thing (a key's value, a node's status): the steps it
 * changed at, rising, and what it changed to. Numbers of one tag (a key's
 * `f64` values, a node's status codes) are kept as numbers; anything else as
 * values.
 */
class Changes {
  readonly steps = new Numbers(4);
  #numbers: Numbers | null = new Numbers(4);
  /** The tag of the numbers kept: `undefined` before the first, `null` for plain numbers. */
  #tag: string | null | undefined = undefined;
  #values: (Value | number | null)[] | null = null;

  /** Record that it changed to `value` at `step`; a change at the step of the last replaces it. */
  set(step: number, value: Value | number | null) {
    const n = this.steps.length;
    const replace = n > 0 && this.steps.get(n - 1) === step;
    const number = this.#encode(value);
    if (number === undefined) this.#generic();
    if (this.#values) {
      if (replace) this.#values[n - 1] = value;
      else this.#values.push(value);
    } else if (replace) this.#numbers!.setLast(number!);
    else this.#numbers!.push(number!);
    if (!replace) this.steps.push(step);
  }

  /** What it was at `step`: `undefined` before its first change. */
  at(step: number): Value | number | null | undefined {
    const i = this.steps.lastAtMost(step);
    if (i < 0) return undefined;
    return this.#get(i);
  }

  /** Its last value. */
  get last(): Value | number | null | undefined {
    return this.steps.length ? this.#get(this.steps.length - 1) : undefined;
  }

  bytes(): number {
    return this.steps.bytes() + (this.#numbers?.bytes() ?? 0) + (this.#values?.length ?? 0) * 8;
  }

  /** `value` as a number of the list's tag; `undefined` when it is not one. */
  #encode(value: Value | number | null): number | undefined {
    if (this.#values) return undefined;
    if (typeof value === "number") {
      if (this.#tag === undefined) this.#tag = null;
      return this.#tag === null ? value : undefined;
    }
    const tag = value === null || value === "unit" ? null : soleTag(value);
    if (tag === null || !NUMERIC.has(tag)) return undefined;
    if (this.#tag === undefined) this.#tag = tag;
    const n = (value as Record<string, unknown>)[tag];
    return this.#tag === tag && typeof n === "number" ? n : undefined;
  }

  #get(i: number): Value | number | null {
    if (this.#values) return this.#values[i]!;
    const n = this.#numbers!.get(i);
    return this.#tag ? ({ [this.#tag]: n } as Value) : n;
  }

  #generic() {
    if (this.#values) return;
    this.#values = Array.from({ length: this.steps.length }, (_, i) => this.#get(i));
    this.#numbers = null;
  }
}

/** The tag of a value with one: `{ "f64": 1 }` is `f64`. */
function soleTag(value: Value): string | null {
  if (value === "unit") return null;
  const keys = Object.keys(value);
  return keys.length === 1 ? keys[0]! : null;
}

/** Whether `value` is the unit value an unset output reads as. */
const isUnit = (value: Value) =>
  (value as unknown) === "unit" || (typeof value === "object" && value !== null && "unit" in value);

/**
 * The revision of the behavior a device runs, a `u64` its interpreter
 * increases at each load and each edit it accepts: `arora-behavior`'s
 * `built_in::BEHAVIOR_REVISION`.
 */
export const REVISION_KEY = "arora/behavior/revision";

const defaultIgnore = (key: string) => key.startsWith("arora/tasks/");

/**
 * A clock's nanoseconds as a number: past 2^53 − 1 (about 104 days) a bridge
 * may hand them over as their digits (`JSON.rawJSON`), which the clock shown
 * rounds; the store keeps the value exact.
 */
function nanoseconds(u64: unknown): number {
  if (typeof u64 === "number") return u64;
  const raw = (u64 as { rawJSON?: unknown } | null)?.rawJSON;
  return typeof raw === "string" ? Number(raw) : NaN;
}

/**
 * A device's steps, from the history's start, kept whole: each push carrying the
 * device's clock is a step, and what a push without it carries belongs to the
 * step before it, as a call the device applies at once does.
 *
 * Only changes are kept: for each store key the steps its value changed at, for
 * each node the steps its status, activity or return value changed at, folded
 * from the trace's reports (each a delta since the one before). The state at any
 * step is a binary search per key and per node. A trace's first report (no
 * `since`) states every node anew; nodes it leaves out leave the view.
 */
export class DeviceHistory {
  readonly #options: DeviceHistoryOptions;
  /** Each step's clock, in seconds (NaN while the device pushed none). */
  readonly #times = new Numbers(1024);
  readonly #store = new Map<string, Changes>();
  readonly #status = new Map<string, Changes>();
  readonly #activity = new Map<string, Changes>();
  readonly #values = new Map<string, Changes>();
  /** The tick of each report folded in, at the step it came with. */
  readonly #ticks = new Changes();
  /** The trace whose reports are folded in: its feedback key and its last report's tick. */
  #trace: { key: string; tick: number } | null = null;
  /** The view the reports folded in leave, to keep only what changes. */
  readonly #now = { status: new Map<string, number>(), activity: new Map<string, number>(), values: new Map<string, Value>() };
  readonly #listeners = new Set<() => void>();
  /** The behavior the device ran at each revision recorded, by revision. */
  readonly #behaviors = new Map<number, Graph>();

  constructor(options: DeviceHistoryOptions = {}) {
    this.#options = options;
    const ignore = options.ignore ?? defaultIgnore;
    for (const [key, value] of options.base ?? []) {
      if (!ignore(key)) this.#change(this.#store, key, -1, value);
    }
  }

  /** The steps kept: indices `0 … length − 1`. */
  get length(): number {
    return this.#times.length;
  }

  /** The device's clock at step `index`, in seconds; `null` before it pushed one. */
  time(index: number): number | null {
    if (index < 0 || index >= this.length) return null;
    const t = this.#times.get(index);
    return Number.isNaN(t) ? null : t;
  }

  /** The last step at or before `seconds` on the device's clock (its clock rising); 0 before the first. */
  indexAt(seconds: number): number {
    return Math.max(0, this.#times.lastAtMost(seconds));
  }

  /** The interpreter's tick at step `index`, as `HistoryState.tick`. */
  tick(index: number): number | null {
    const i = this.#ticks.steps.lastAtMost(index);
    if (i < 0) return null;
    const at = this.#ticks.steps.get(i);
    return (this.#ticks.at(at) as number) + (index - at);
  }

  /** Listen to the history growing; the function returned stops listening. */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** About how many bytes the history holds: its steps and its changes. */
  bytes(): number {
    let bytes = this.#times.bytes() + this.#ticks.bytes();
    for (const map of [this.#store, this.#status, this.#activity, this.#values]) {
      for (const [key, changes] of map) bytes += changes.bytes() + key.length * 2 + 64;
    }
    return bytes;
  }

  /**
   * Record that the device's behavior at revision `revision` is `graph`: the
   * steps whose revision it is show it. A later record of the revision
   * replaces it.
   */
  recordBehavior(revision: number, graph: Graph) {
    if (this.#behaviors.get(revision) === graph) return;
    this.#behaviors.set(revision, graph);
    for (const listener of [...this.#listeners]) listener();
  }

  /** The revision of the device's behavior at step `index`; `null` where it kept none. */
  revision(index: number): number | null {
    const changes = this.#store.get(REVISION_KEY);
    const value = changes?.at(Math.min(Math.max(index, 0), this.length - 1));
    if (value === undefined || value === null) return null;
    return (typeof value === "number" ? value : valueNumber(value)) ?? null;
  }

  /** The behavior recorded for revision `revision`; `null` when none was. */
  behavior(revision: number | null): Graph | null {
    return revision === null ? null : (this.#behaviors.get(revision) ?? null);
  }

  /** Take in one push of the device, as its client delivered it. */
  record(values: Record<string, Value>) {
    const ignore = this.#options.ignore ?? defaultIgnore;
    if (TIME_KEY in values || this.length === 0) {
      const time = values[TIME_KEY];
      const ns = time !== undefined && time !== "unit" && "u64" in time ? nanoseconds(time.u64) : NaN;
      this.#times.push(ns / 1e9);
    }
    const step = this.length - 1;
    for (const [key, value] of Object.entries(values)) {
      const report = this.#options.report?.(key, value);
      if (report) this.#fold(key, report, step);
      else if (!ignore(key)) this.#change(this.#store, key, step, value);
    }
    for (const listener of [...this.#listeners]) listener();
  }

  /**
   * The numbers (a boolean as 0 or 1, as the live plot has it) store key `key` held over the `count` steps ending at step
   * `end`, one a step (`null` where it held none, or no number): a plot of the
   * past up to the step shown.
   */
  series(key: string, end: number, count: number): (number | null)[] {
    const changes = this.#store.get(key);
    const last = Math.min(end, this.length - 1);
    const out: (number | null)[] = [];
    for (let step = Math.max(0, last - count + 1); step <= last; step++) {
      const value = changes?.at(step);
      out.push(value === undefined || value === null || typeof value === "number" ? null : valuePlotted(value));
    }
    return out;
  }

  /** The device's state at step `index` (clamped to the steps kept). */
  at(index: number): HistoryState {
    const step = Math.min(Math.max(index, 0), this.length - 1);
    const store = new Map<string, Value>();
    for (const [key, changes] of this.#store) {
      const value = changes.at(step);
      if (value !== undefined && value !== null && typeof value !== "number") store.set(key, value);
    }
    const coded = <T>(map: Map<string, Changes>, decode: (code: number) => T | undefined) => {
      // Without a prototype: a node id such as `__proto__` is an entry like any other.
      const out = Object.create(null) as Record<string, T>;
      for (const [node, changes] of map) {
        const value = decode(changes.at(step) as number);
        if (value !== undefined) out[node] = value;
      }
      return out;
    };
    const values = Object.create(null) as Record<string, Value>;
    for (const [node, changes] of this.#values) {
      const value = changes.at(step);
      if (value !== undefined && value !== null && typeof value !== "number") values[node] = value;
    }
    const revision = this.revision(step);
    return {
      index: step,
      time: this.time(step),
      tick: this.tick(step),
      revision,
      behavior: this.behavior(revision),
      store,
      statuses: coded(this.#status, (code) => CODE_STATUS[code]),
      detached: coded(this.#activity, (code) => CODE_ACTIVITY[code]),
      values,
    };
  }

  #change(map: Map<string, Changes>, key: string, step: number, value: Value | number | null) {
    let changes = map.get(key);
    const last = changes?.last;
    if (changes && last !== undefined && sameValue(last, value)) return;
    if (!changes) map.set(key, (changes = new Changes()));
    changes.set(step, value);
  }

  /**
   * Fold a trace's report in. A first report starts the trace whose reports are
   * folded from then on, and states every node anew; a report of another trace,
   * or one already read, changes nothing.
   */
  #fold(key: string, report: TraceReport, step: number) {
    const now = this.#now;
    if (report.since === undefined) {
      this.#trace = { key, tick: report.tick };
      const stated = new Set((report.status ?? []).map(([node]) => node));
      for (const node of now.status.keys()) if (!stated.has(node)) this.#setStatus(node, NONE, step);
      const active = new Set((report.activity ?? []).map(([node]) => node));
      for (const node of now.activity.keys()) if (!active.has(node)) this.#setActivity(node, NONE, step);
      const valued = new Set((report.values ?? []).filter((v) => v.port === RET).map((v) => v.node));
      for (const node of now.values.keys()) if (!valued.has(node)) this.#setValue(node, null, step);
    } else {
      const trace = this.#trace;
      // A delta from another tick than the last folded (a report lost between) is
      // not folded onto an incomplete view: the next full report states it again.
      if (!trace || trace.key !== key || report.tick === trace.tick || report.since !== trace.tick) return;
      trace.tick = report.tick;
    }
    for (const node of report.restarted ?? []) {
      this.#setStatus(node, NONE, step);
      this.#setActivity(node, NONE, step);
      this.#setValue(node, null, step);
    }
    for (const [node, status] of report.status ?? []) {
      this.#setStatus(node, status === "not_reached" ? NONE : STATUS_CODE[status === "success" ? "S" : status === "failure" ? "F" : "R"], step);
    }
    for (const [node, activity] of report.activity ?? []) this.#setActivity(node, ACTIVITY_CODE[activity], step);
    for (const { node, port, value } of report.values ?? []) {
      if (port === RET) this.#setValue(node, isUnit(value) ? null : value, step);
    }
    this.#ticks.set(step, report.tick);
  }

  #setStatus(node: string, code: number, step: number) {
    if ((this.#now.status.get(node) ?? NONE) === code) return;
    if (code === NONE) this.#now.status.delete(node);
    else this.#now.status.set(node, code);
    this.#change(this.#status, node, step, code);
  }

  #setActivity(node: string, code: number, step: number) {
    if ((this.#now.activity.get(node) ?? NONE) === code) return;
    if (code === NONE) this.#now.activity.delete(node);
    else this.#now.activity.set(node, code);
    this.#change(this.#activity, node, step, code);
  }

  #setValue(node: string, value: Value | null, step: number) {
    const was = this.#now.values.get(node) ?? null;
    if (valueEquals(was, value)) return;
    if (value === null) this.#now.values.delete(node);
    else this.#now.values.set(node, value);
    this.#change(this.#values, node, step, value);
  }
}

function sameValue(a: Value | number | null, b: Value | number | null): boolean {
  if (typeof a === "number" || typeof b === "number") return a === b;
  return valueEquals(a, b);
}
