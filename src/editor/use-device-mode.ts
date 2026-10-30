import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Graph, type GraphDiff, isEmptyDiff } from "../model/graph";
import type { Value } from "../model/value";
import type { KeyInfo, TickReport } from "../runtime/runtime";
import type {
  DeviceBehavior,
  DeviceSession,
  DeviceStatus,
  SessionState,
} from "../session/device-session";
import { useSessionState } from "../session/use-device-session";
import type { Loaded } from "../text/language";
import { withTick } from "./use-playback";

/**
 * How the file open stands to the behavior the device runs:
 *
 * - `reading`: the device's behavior is being read.
 * - `unreported`: the device does not say what it runs.
 * - `differs`: it runs another behavior than the file's.
 * - `running`: it runs the file, as this editor sent it or as the file was
 *   when the editor found it running: the editor's changes go to it.
 * - `changed`: it ran the file, until another client changed it.
 */
export type Relation = "reading" | "unreported" | "differs" | "running" | "changed";

/** The editor on a device, through a session: what the device runs and does, and what the person may do. */
export interface DeviceMode {
  state: SessionState | null;
  relation: Relation;
  /** The device's behavior as last read; `null` when it does not say. */
  behavior: DeviceBehavior | null;
  status: DeviceStatus;
  /** The diff from the device's behavior to the file's, while they differ and the file runs. */
  difference: GraphDiff | null;
  /** Whether each change of the file goes to the device as it is made. */
  liveEdits: boolean;
  setLiveEdits(on: boolean): void;
  /** How many changes of the file the device does not have yet. */
  pendingChanges: number;
  /** Send the changes the device does not have. */
  apply(): void;
  /** Load the file on the device. */
  run(): void;
  /** Load the empty behavior on the device. */
  stop(): void;
  /** Why the device refused the last operation, until the next succeeds. */
  error: string | null;
  /** The last step's report, with the nodes' states only while the device runs the file. */
  report: TickReport | null;
  previous: TickReport | null;
  store: ReadonlyMap<string, Value>;
  keys: ReadonlyMap<string, KeyInfo>;
  pending: ReadonlySet<string>;
  history: ReadonlyMap<string, readonly (number | null)[]>;
  write(key: string, value: Value | null): void;
}

const NO_STATUS: DeviceStatus = { tick: null, time: null, rate: null, revision: null };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The number of changes `diff` makes: nodes removed and set, ports unbound and bound, the root. */
export function changeCount(diff: GraphDiff): number {
  return (
    (diff.remove?.length ?? 0) +
    (diff.set?.length ?? 0) +
    (diff.unbind?.length ?? 0) +
    (diff.bind?.length ?? 0) +
    (diff.root === undefined ? 0 : 1)
  );
}

/**
 * The file `loaded` on the device `session` follows, `null` while the file
 * does not run; with no session, nothing. Attaching changes nothing on the device: the hook reads what
 * the device runs, and takes it as the file running when their graphs are
 * the same. From then on, each change of the file goes to the device as an
 * edit, or waits for `apply` while `liveEdits` is off. A change of the
 * device's behavior another client makes is told as `changed`, and nothing
 * more is sent until the person runs the file again.
 */
export function useDeviceMode(
  session: DeviceSession | null,
  loaded: Loaded | null,
  diff: (previous: Graph, next: Graph) => GraphDiff,
): DeviceMode {
  const state = useSessionState(session);
  const connected = state?.status === "connected";
  const [behavior, setBehavior] = useState<DeviceBehavior | null | undefined>(undefined);
  /** The graph the device runs as this editor knows it ran the file: `null` when it does not. */
  const [runningState, setRunningState] = useState<Graph | null>(null);
  const running = runningState;
  const runningRef = useRef<Graph | null>(null);
  const setRunningGraph = useCallback((graph: Graph | null) => {
    runningRef.current = graph;
    setRunningState(graph);
  }, []);
  const [changedState, setChangedState] = useState(false);
  const changed = changedState;
  /** Whether another client changed the behavior the file ran as, read when an edit goes. */
  const changedRef = useRef(false);
  const markChanged = useCallback((next: boolean) => {
    changedRef.current = next;
    setChangedState(next);
  }, []);
  const [liveEdits, setLiveEdits] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<DeviceStatus>(session?.status ?? NO_STATUS);
  const [reports, setReports] = useState<{
    report: TickReport | null;
    previous: TickReport | null;
  }>({ report: null, previous: null });
  const [storeState, setStoreState] = useState<ReadonlyMap<string, Value>>(new Map());
  const storeRef = useRef(storeState);
  const setStore = (next: ReadonlyMap<string, Value>) => {
    storeRef.current = next;
    setStoreState(next);
  };
  const [keys, setKeys] = useState<ReadonlyMap<string, KeyInfo>>(new Map());
  const [pendingState, setPendingState] = useState<ReadonlySet<string>>(new Set());
  const pendingRef = useRef(pendingState);
  const setPending = (next: ReadonlySet<string>) => {
    pendingRef.current = next;
    setPendingState(next);
  };
  const [history, setHistory] = useState<ReadonlyMap<string, readonly (number | null)[]>>(
    new Map(),
  );
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  /**
   * The session whose answers the hook shows: one switched away from, or a
   * hook unmounted, has its late answers dropped.
   */
  const shown = useRef(session);
  useEffect(
    () => () => {
      shown.current = null;
    },
    [],
  );
  /** Why following the device failed at its last step, until the next succeeds. */
  const [followError, setFollowError] = useState<string | null>(null);

  /**
   * Operations on the device, one after the other, as the person asked for
   * them. A task is given whether its session is still the one shown, which
   * it checks before showing what it did.
   */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const enqueue = useCallback((task: (live: () => boolean) => Promise<void>) => {
    const owner = shown.current;
    const live = () => owner !== null && shown.current === owner;
    queue.current = queue.current
      .then(() => (live() ? task(live) : undefined))
      .then(
        () => live() && setError(null),
        (e: unknown) => live() && setError(message(e)),
      );
  }, []);

  // What the editor knew of another session's device is not this one's.
  const [known, setKnown] = useState(session);
  if (known !== session) {
    shown.current = session;
    setKnown(session);
    setFollowError(null);
    setBehavior(undefined);
    setRunningGraph(null);
    markChanged(false);
    setError(null);
    setStatus(session?.status ?? NO_STATUS);
    setReports({ report: null, previous: null });
    setStore(new Map());
    setKeys(new Map());
    setPending(new Set());
    setHistory(new Map());
  }

  const read = useCallback(() => {
    if (!session) return;
    enqueue(async (live) => {
      const answer = await session.deviceBehavior();
      if (live()) setBehavior(answer);
    });
  }, [session, enqueue]);

  // Each connection, the first and any made again, reads what the device runs.
  useEffect(() => {
    if (connected) read();
  }, [connected, read]);

  // A change another client made: the file no longer runs as the editor
  // sent it; while it did not run, the device's behavior is read again.
  useEffect(
    () =>
      session?.on("behaviorChanged", (change) => {
        if (!change.external) return;
        if (runningRef.current !== null) markChanged(true);
        else read();
      }),
    [session, read, markChanged],
  );

  useEffect(
    () =>
      session?.on("tick", (tick) => {
        setFollowError(null);
        setStatus(tick.status);
        setReports((last) => ({ report: tick.report, previous: last.report }));
        const next = new Map(tick.report.whole ? [] : storeRef.current);
        for (const { key, value } of tick.report.changes) {
          if (value === null) next.delete(key);
          else next.set(key, value);
        }
        setKeys(new Map(tick.keys.map((info) => [info.key, info])));
        const written = [...pendingRef.current];
        setPending(new Set());
        // A written key now holds what the device made of the write.
        Promise.all(written.map((key) => session.read(key)))
          .then((values) => {
            written.forEach((key, i) => {
              const value = values[i];
              if (value == null) next.delete(key);
              else next.set(key, value);
            });
          })
          .catch(() => undefined)
          .finally(() => {
            if (shown.current !== session) return;
            setStore(next);
            setHistory((h) => withTick(h, next));
          });
      }),
    [session],
  );

  // A step the session failed to follow says why, until the next succeeds.
  useEffect(() => session?.on("error", (e) => setFollowError(e.message)), [session]);

  // The device runs the file when their graphs are the same: the editor
  // follows the file's nodes, and sends its changes from then on.
  useEffect(() => {
    if (!session || running !== null || changed || !behavior || !loaded) return;
    if (!isEmptyDiff(diff(behavior.graph, loaded.graph))) return;
    setRunningGraph(behavior.graph);
    enqueue(() => session.follow(loaded));
  }, [running, changed, behavior, loaded, diff, session, enqueue, setRunningGraph]);

  /** Send the file's changes the device does not have, as one edit. */
  const send = useCallback(() => {
    if (!session) return;
    // Another client's change, told before the edit goes, refuses it: it is
    // a diff from the behavior the file ran as, not from theirs.
    const unchangedSince = session.externalChanges;
    enqueue(async (live) => {
      const from = runningRef.current;
      const next = loadedRef.current;
      if (changedRef.current || from === null || next === null) return;
      await session.edit(diff(from, next.graph), next, { unchangedSince });
      if (live()) setRunningGraph(next.graph);
    });
  }, [session, diff, enqueue, setRunningGraph]);

  const sending = running !== null && !changed && connected && liveEdits;
  useEffect(() => {
    if (sending && loaded) send();
  }, [sending, loaded, send]);

  const run = useCallback(() => {
    const next = loadedRef.current;
    if (!session || !next) return;
    enqueue(async (live) => {
      await session.run(next);
      if (!live()) return;
      setRunningGraph(next.graph);
      markChanged(false);
      setBehavior((b) => (b ? { ...b, graph: next.graph } : b));
    });
  }, [session, enqueue, setRunningGraph, markChanged]);

  const stop = useCallback(() => {
    if (!session) return;
    enqueue(async (live) => {
      await session.stop();
      if (!live()) return;
      setRunningGraph(null);
      markChanged(false);
      setBehavior((b) => (b ? { ...b, graph: {} } : b));
    });
  }, [session, enqueue, setRunningGraph, markChanged]);

  const write = useCallback(
    (key: string, value: Value | null) => {
      session
        ?.write(key, value)
        .then(() => {
          if (shown.current !== session) return;
          const next = new Map(storeRef.current);
          if (value === null) next.delete(key);
          else next.set(key, value);
          setStore(next);
          setPending(new Set([...pendingRef.current, key]));
        })
        .catch((e: unknown) => shown.current === session && setError(message(e)));
    },
    [session],
  );

  const relation: Relation = changed
    ? "changed"
    : running !== null
      ? "running"
      : behavior === undefined
        ? "reading"
        : behavior === null
          ? "unreported"
          : "differs";
  const graph = loaded?.graph ?? null;
  const waiting = useMemo(
    () => (running !== null && graph ? diff(running, graph) : null),
    [running, graph, diff],
  );
  const pendingChanges = waiting && !sending ? changeCount(waiting) : 0;
  const deviceGraph = relation === "differs" ? (behavior?.graph ?? null) : null;
  const difference = useMemo(
    () => (deviceGraph && graph ? diff(deviceGraph, graph) : null),
    [deviceGraph, graph, diff],
  );
  // The nodes' states are the file's only while the device runs it.
  const report =
    relation === "running" || !reports.report
      ? reports.report
      : { tick: reports.report.tick, changes: reports.report.changes };

  return {
    state,
    relation,
    behavior: behavior ?? null,
    status,
    difference,
    liveEdits,
    setLiveEdits,
    pendingChanges,
    apply: send,
    run,
    stop,
    error: error ?? followError,
    report,
    previous: relation === "running" ? reports.previous : null,
    store: storeState,
    keys,
    pending: pendingState,
    history,
    write,
  };
}
