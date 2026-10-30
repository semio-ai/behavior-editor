import { type ReactNode, useId, useState } from "react";
import type { Graph, GraphDiff } from "../model/graph";
import type { Loaded } from "../text/language";
import type { FunctionIndex } from "./functions";
import type { DeviceMode } from "./use-device-mode";

/** A diff from the device's behavior to the file's, by what it does to each node. */
export interface DiffSummary {
  /** The nodes the file has and the device's behavior has not. */
  added: string[];
  /** The nodes the device's behavior has and the file has not. */
  removed: string[];
  /** The nodes both have, whose function or children differ. */
  changed: string[];
  /** The nodes both have, the same but for the ports they bind. */
  rebound: string[];
  /** Whether the root differs. */
  root: boolean;
}

/** What `diff`, from `device` to the file, does to each node. */
export function summarize(diff: GraphDiff, device: Graph): DiffSummary {
  const had = new Set((device.nodes ?? []).map((n) => n.id));
  const set = (diff.set ?? []).map((n) => n.id);
  const whole = new Set(set);
  const ports = [...(diff.bind ?? []), ...(diff.unbind ?? [])].map((p) => p.node);
  return {
    added: set.filter((id) => !had.has(id)),
    removed: [...(diff.remove ?? [])],
    changed: set.filter((id) => had.has(id)),
    rebound: [...new Set(ports)].filter((id) => had.has(id) && !whole.has(id)),
    root: diff.root !== undefined,
  };
}

export interface DeviceBannerProps {
  device: DeviceMode;
  /** The file as it resolves, when it runs. */
  loaded: Loaded | null;
  /**
   * Why the file cannot run on the device, when it cannot: told beside the
   * buttons that would run it, which it disables.
   */
  blocked: string | null;
  index: FunctionIndex;
  /** Whether the file has changes not saved: opening another asks first. */
  dirty: boolean;
  /** Open the device's behavior in place of the file. */
  onView(graph: Graph): void;
  /** Read the device's behavior again, and open it in place of the file. */
  onReload(): void;
  /** Select the file's node of graph id `id`. */
  onSelect(id: string): void;
}

/**
 * What the device runs, when the file does not run on it, and what the
 * person may do about it: view the device's behavior, run the file on it,
 * compare the two; or, once another client changed it, reload it or
 * overwrite it.
 */
export function DeviceBanner({
  device,
  loaded,
  blocked,
  index,
  dirty,
  onView,
  onReload,
  onSelect,
}: DeviceBannerProps) {
  const [comparing, setComparing] = useState(false);
  const [asking, setAsking] = useState<(() => void) | null>(null);
  const lost = device.state?.status !== "connected";
  const guarded = (open: () => void) => () => (dirty ? setAsking(() => open) : open());
  const runnable = loaded !== null && blocked === null && !lost;
  const reasonId = useId();
  const reason = blocked && (
    <p className="be-banner-reason" id={reasonId}>
      {blocked}
    </p>
  );
  const describedBy = blocked ? reasonId : undefined;
  const run = (
    <button
      type="button"
      className="be-primary"
      disabled={!runnable}
      aria-describedby={describedBy}
      onClick={device.run}
    >
      Run this file on the device
    </button>
  );
  const confirm = asking && (
    <span className="be-confirm" role="alert">
      Discard unsaved changes?
      <button
        type="button"
        className="be-danger"
        onClick={() => {
          setAsking(null);
          asking();
        }}
      >
        Discard
      </button>
      <button type="button" onClick={() => setAsking(null)}>
        Keep editing
      </button>
    </span>
  );

  switch (device.relation) {
    case "running":
      // A change that keeps the file from running is not sent: the device
      // goes on running the file as it last ran.
      return blocked ? (
        <section className="be-banner be-banner-warn" aria-label="Device's behavior">
          {reason}
          <p role="status">
            The device goes on running this file as it last ran: your changes are not sent.
          </p>
        </section>
      ) : null;
    case "reading":
      return (
        <p className="be-banner" role="status">
          Reading the device&apos;s behavior…
        </p>
      );
    case "unreported":
      return (
        <section className="be-banner" aria-label="Device's behavior">
          <p role="status">
            This device doesn&apos;t report its behavior: the editor cannot show what it runs.
          </p>
          {reason}
          <div className="be-banner-actions">
            {run}
            <button type="button" disabled={lost} onClick={device.stop}>
              Stop on device
            </button>
          </div>
        </section>
      );
    case "changed":
      return (
        <section className="be-banner be-banner-warn" aria-label="Device's behavior">
          <p role="alert">
            {`Another client changed the device's behavior${
              device.status.revision === null ? "" : ` (revision ${device.status.revision})`
            }: this file no longer runs on it, and your changes are not sent.`}
          </p>
          {reason}
          <div className="be-banner-actions">
            <button type="button" disabled={lost} onClick={guarded(onReload)}>
              Reload from the device
            </button>
            <button
              type="button"
              className="be-danger"
              disabled={!runnable}
              aria-describedby={describedBy}
              onClick={device.run}
            >
              Overwrite with mine
            </button>
            {confirm}
          </div>
        </section>
      );
    case "differs": {
      const graph = device.behavior!.graph;
      if (!graph.nodes?.length) {
        return (
          <section className="be-banner" aria-label="Device's behavior">
            <p role="status">The device runs no behavior.</p>
            {reason}
            <div className="be-banner-actions">{run}</div>
          </section>
        );
      }
      return (
        <section className="be-banner" aria-label="Device's behavior">
          <p role="status">The device runs another behavior than this file.</p>
          {reason}
          <div className="be-banner-actions">
            <button type="button" onClick={guarded(() => onView(graph))}>
              View the device&apos;s behavior
            </button>
            {run}
            <button
              type="button"
              aria-expanded={comparing}
              aria-controls="be-compare"
              disabled={!device.difference}
              onClick={() => setComparing((c) => !c)}
            >
              Compare
            </button>
            {confirm}
          </div>
          {comparing && device.difference && loaded && (
            <Comparison
              summary={summarize(device.difference, graph)}
              device={graph}
              loaded={loaded}
              index={index}
              onSelect={onSelect}
            />
          )}
        </section>
      );
    }
  }
}

/** The differences between the device's behavior and the file, each change selecting its node. */
function Comparison({
  summary,
  device,
  loaded,
  index,
  onSelect,
}: {
  summary: DiffSummary;
  device: Graph;
  loaded: Loaded;
  index: FunctionIndex;
  onSelect(id: string): void;
}) {
  const functionName = (id: string) =>
    index.entries.find((e) => e.signature.id === id)?.signature.name ?? id;
  const nodes = new Map(loaded.nodes.map((n) => [n.id, n]));
  const inFile = (id: string) => {
    const node = nodes.get(id);
    const name = node?.name ?? node?.path ?? id;
    return (
      <li key={id}>
        <button type="button" className="be-link" onClick={() => onSelect(id)}>
          {`${name}: ${functionName(node?.function ?? "")}`}
        </button>
      </li>
    );
  };
  const onDevice = (id: string) => {
    const node = device.nodes?.find((n) => n.id === id);
    return <li key={id}>{`${id}: ${functionName(node?.function ?? "")}`}</li>;
  };
  const groups: [string, string[], (id: string) => ReactNode][] = [
    ["Only in this file", summary.added, inFile],
    ["Only on the device", summary.removed, onDevice],
    ["Changed: function or children", summary.changed, inFile],
    ["Bindings changed", summary.rebound, inFile],
  ];
  return (
    <div className="be-compare" id="be-compare" role="region" aria-label="Comparison">
      {summary.root && <p className="be-fine">The root differs.</p>}
      {groups
        .filter(([, ids]) => ids.length)
        .map(([title, ids, item]) => (
          <div key={title}>
            <h3>{`${title} (${ids.length})`}</h3>
            <ul>{ids.map(item)}</ul>
          </div>
        ))}
    </div>
  );
}
