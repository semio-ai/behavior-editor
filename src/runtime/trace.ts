/**
 * A trace of a behavior running on a device: `arora-behavior`'s task run that
 * reports, tick by tick, what the nodes did (its `docs/trace.md`). The
 * language's wasm encodes the call that starts one and decodes its reports;
 * `TraceView` folds the reports into the nodes as they stand.
 */
import type { Value } from "../model/value";
import type { Loaded } from "../text/language";
import { RET } from "./natives";
import type { DetachedActivity, Status, TickReport } from "./runtime";

/** What a trace follows: `arora_behavior::trace::TraceOptions`. */
export interface TraceOptions {
  /** The nodes whose outputs the reports carry. */
  values?: string[];
  /** The least time between two reports, in nanoseconds of `arora/time`. */
  min_interval_ns?: number;
}

/** A trace's handle, `arora_behavior::TaskHandle`: how to stop it, and where it reports. */
export interface TraceHandle {
  id: string;
  /** The `Call` that halts it. */
  stop: unknown;
  /** Its lifecycle status key. */
  status: string;
  /** The key its reports are written to, first. */
  feedback: string[];
}

/** A node's status in a report: `arora_behavior::trace::NodeStatus`. */
export type TraceStatus = "success" | "failure" | "running" | "not_reached";

/** One report: what changed since the trace's previous one, `arora_behavior::trace::TraceReport`. */
export interface TraceReport {
  /** The interpreter's tick it was written at. */
  tick: number;
  /** The tick of the previous report; absent in a first report, which states everything. */
  since?: number;
  status?: [string, TraceStatus][];
  activity?: [string, DetachedActivity][];
  values?: { node: string; port: string; value: Value }[];
  /** The nodes an edit restarted: their status, activity and values are stated anew. */
  restarted?: string[];
}

const STATUS: Record<Exclude<TraceStatus, "not_reached">, Status> = {
  success: "S",
  failure: "F",
  running: "R",
};

/** Whether `value` is the unit value an unset output reads as. */
const isUnit = (value: Value) =>
  (value as unknown) === "unit" || (typeof value === "object" && value !== null && "unit" in value);

/**
 * The nodes a trace watches the outputs of, by default: those the text names,
 * and those outside the tree, whose values the diagram shows.
 */
export function watchedNodes(loaded: Loaded): string[] {
  return loaded.nodes.filter((n) => n.name !== null || !n.attached).map((n) => n.id);
}

/**
 * A trace's reports folded together: each node's status, each detached
 * node's activity and each watched node's return value, as the last report
 * read leaves them.
 */
export class TraceView {
  #status = new Map<string, Status>();
  #activity = new Map<string, DetachedActivity>();
  #values = new Map<string, Value>();
  #last: number | null = null;

  /** The interpreter's tick the last report read was written at; `null` before the first. */
  get tick(): number | null {
    return this.#last;
  }

  /**
   * Fold `report` in. A first report starts the view afresh; a later report
   * already read changes nothing. `false` when the report follows one not
   * read: the view is no longer whole, and the trace must start over.
   */
  read(report: TraceReport): boolean {
    // A first report states everything, whatever tick it was written at: a
    // new trace's first may share its tick with the old trace's last.
    if (report.since === undefined) this.#clear();
    else if (report.tick === this.#last) return true;
    else if (report.since !== this.#last) return false;
    for (const node of report.restarted ?? []) {
      this.#status.delete(node);
      this.#activity.delete(node);
      this.#values.delete(node);
    }
    for (const [node, status] of report.status ?? []) {
      if (status === "not_reached") this.#status.delete(node);
      else this.#status.set(node, STATUS[status]);
    }
    for (const [node, activity] of report.activity ?? []) this.#activity.set(node, activity);
    for (const { node, port, value } of report.values ?? []) {
      if (port !== RET) continue;
      if (isUnit(value)) this.#values.delete(node);
      else this.#values.set(node, value);
    }
    this.#last = report.tick;
    return true;
  }

  /**
   * Expect a new trace's first report: the view keeps what it shows until
   * then, and takes no report that follows another.
   */
  awaitFirst() {
    this.#last = null;
  }

  /**
   * The view as a tick report states it, for the behavior's `nodes`: a trace
   * also reports the interpreter's own. The root's status is `root`'s.
   */
  report(
    root: string | undefined,
    nodes: ReadonlySet<string>,
  ): Pick<TickReport, "root" | "statuses" | "detached" | "values"> {
    const of = <T>(map: Map<string, T>) =>
      Object.fromEntries([...map].filter(([node]) => nodes.has(node)));
    const statuses = of(this.#status);
    return {
      ...(root !== undefined && statuses[root] ? { root: statuses[root] } : {}),
      statuses,
      detached: of(this.#activity),
      values: of(this.#values),
    };
  }

  #clear() {
    this.#last = null;
    this.#status.clear();
    this.#activity.clear();
    this.#values.clear();
  }
}
