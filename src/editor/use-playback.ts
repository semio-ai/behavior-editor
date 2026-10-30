import { useCallback, useEffect, useRef, useState } from "react";
import { type Graph, type GraphDiff, isEmptyDiff } from "../model/graph";
import type { MethodSignature } from "../model/signature";
import { type Value, valueBoolean, valueNumber } from "../model/value";
import type { BehaviorRuntime, KeyInfo, TickReport } from "../runtime/runtime";
import type { Loaded } from "../text/language";

export const RATES = [10, 30, 60] as const;
export type Rate = (typeof RATES)[number];

/** How many ticks a plotted key keeps. */
export const HISTORY = 240;

export interface Playback {
  report: TickReport | null;
  /** The report of the tick before `report`'s. */
  previous: TickReport | null;
  playing: boolean;
  setPlaying(playing: boolean): void;
  rate: Rate;
  setRate(rate: Rate): void;
  /** Advance one tick. */
  step(): void;
  /** Start the behavior again from its first tick. */
  reset(): void;
  /** Why the runtime refused the behavior or a tick, until the next start. */
  error: string | null;
  /** The store, key by key, a pending write shown as written. */
  store: ReadonlyMap<string, Value>;
  /** What the runtime says of each key: whether a person may write it, its type. */
  keys: ReadonlyMap<string, KeyInfo>;
  /** The keys written since the last tick: a device applies a write at its next step. */
  pending: ReadonlySet<string>;
  /** The numbers each key held over the last ticks, oldest first. */
  history: ReadonlyMap<string, readonly (number | null)[]>;
  write(key: string, value: Value | null): void;
}

/** The behavior on one runtime, as the hook ran it. */
interface OnRuntime {
  /** Whether a behavior was started, and not stopped since. */
  started: boolean;
  /** The graph the runtime runs, which an edit is the diff from; `null` when none runs. */
  running: Graph | null;
  /** Whether the runtime refused the last edit: the error shown is that refusal. */
  refused: boolean;
  /** Whether a step is under way. */
  stepping: boolean;
}

/**
 * Each runtime's calls, in the order they were made: whichever editor made
 * them, a call waits for every call before it. An editor closing a file and
 * one opening the next on the same runtime stop the first before starting
 * the second.
 */
const queues = new WeakMap<BehaviorRuntime, Promise<unknown>>();

/**
 * Settles once every call queued on `runtime` so far has: what lets go of a
 * runtime waits for, the stop of the editor that let go of it among them.
 */
export function whenIdle(runtime: BehaviorRuntime): Promise<void> {
  return (queues.get(runtime) ?? Promise.resolve()).then(() => undefined);
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A key's value as a number to plot: a number, or a boolean as 0 or 1. */
function plotted(value: Value | undefined): number | null {
  const n = valueNumber(value);
  if (n !== undefined) return n;
  const b = valueBoolean(value);
  return b === undefined ? null : Number(b);
}

/**
 * Run `loaded` on `runtime` whenever it changes and resolves, tick it at the
 * chosen rate while playing, and keep the store as the ticks leave it.
 *
 * The first behavior, and the first after a stop or a reset, starts: every
 * node afresh. Every later one is an edit of the behavior running, the diff
 * `diff` gives from the graph it runs to the next, so the nodes the change
 * leaves in place keep their state. Every call to the runtime waits for the
 * one before, whichever editor made it, so a tick never overtakes the start
 * or the edit it follows, and a file opened starts after the one it replaces
 * stopped.
 *
 * While `loaded` is `null`, the text being one that does not run, nothing
 * ticks: the behavior running stays as it last ticked, and the next behavior
 * that runs is an edit of it.
 */
export function usePlayback(
  runtime: BehaviorRuntime,
  loaded: Loaded | null,
  autoPlay: boolean,
  diff: (previous: Graph, next: Graph) => GraphDiff,
): Playback {
  const [reports, setReports] = useState<{
    report: TickReport | null;
    previous: TickReport | null;
  }>({ report: null, previous: null });
  const [playing, setPlaying] = useState(autoPlay);
  const [rate, setRate] = useState<Rate>(30);
  const [error, setError] = useState<string | null>(null);
  const [storeState, setStoreState] = useState<ReadonlyMap<string, Value>>(new Map());
  const storeRef = useRef<ReadonlyMap<string, Value>>(storeState);
  const setStore = useCallback((next: ReadonlyMap<string, Value>) => {
    storeRef.current = next;
    setStoreState(next);
  }, []);
  const [history, setHistory] = useState<ReadonlyMap<string, readonly (number | null)[]>>(
    new Map(),
  );
  // What the hook knows of the behavior on each runtime: a runtime let go of
  // keeps its own, which the stop queued on it clears, so it cannot clear
  // the next runtime's.
  const states = useRef(new WeakMap<BehaviorRuntime, OnRuntime>());
  let on = states.current.get(runtime);
  if (!on) {
    on = { started: false, running: null, refused: false, stepping: false };
    states.current.set(runtime, on);
  }
  const at = on;
  /** Show why an operation other than an edit failed: the error is no edit's refusal. */
  const fail = useCallback(
    (e: unknown) => {
      at.refused = false;
      setError(message(e));
    },
    [at],
  );
  /** Whether there is a behavior to tick: `loaded` is not `null`. */
  const runnable = useRef(loaded !== null);

  const enqueue = useCallback(
    <T>(task: () => Promise<T>) => {
      const next = (queues.get(runtime) ?? Promise.resolve()).then(task);
      queues.set(runtime, next.catch(() => undefined));
      return next;
    },
    [runtime],
  );

  const [keys, setKeys] = useState<ReadonlyMap<string, KeyInfo>>(new Map());
  const [pendingState, setPendingState] = useState<ReadonlySet<string>>(new Set());
  const pendingRef = useRef<ReadonlySet<string>>(pendingState);
  const setPending = useCallback((next: ReadonlySet<string>) => {
    pendingRef.current = next;
    setPendingState(next);
  }, []);

  const readKeys = useCallback(async () => {
    const infos = await runtime.keys();
    setKeys(new Map(infos.map((info) => [info.key, info])));
    return infos;
  }, [runtime]);

  // A key written since the last tick keeps showing the write.
  const readStore = useCallback(async () => {
    const infos = await readKeys();
    const values = await Promise.all(infos.map((info) => runtime.read(info.key)));
    const next = new Map<string, Value>();
    infos.forEach((info, i) => {
      const value = values[i];
      if (value != null) next.set(info.key, value);
    });
    for (const key of pendingRef.current) {
      const shown = storeRef.current.get(key);
      if (shown === undefined) next.delete(key);
      else next.set(key, shown);
    }
    setStore(next);
    return next;
  }, [runtime, readKeys, setStore]);

  // A runtime's store starts with no write of a person's pending: those were another's.
  useEffect(() => {
    enqueue(async () => {
      setPending(new Set());
      await readStore();
    }).catch(fail);
  }, [enqueue, readStore, setPending, fail]);

  /** Start `behavior` when none runs, or edit the one running into it. */
  const run = useCallback(
    (behavior: Loaded) =>
      enqueue(async () => {
        const previous = at.running;
        if (previous === null) {
          at.started = false;
          await runtime.start(behavior);
          at.running = behavior.graph;
          at.started = true;
          at.refused = false;
          setError(null);
          setReports({ report: null, previous: null });
          setHistory(new Map());
          await readStore();
          return;
        }
        const change = diff(previous, behavior.graph);
        if (isEmptyDiff(change)) {
          // Back to the behavior running: a refusal of another is moot.
          if (at.refused) setError(null);
          at.refused = false;
          return;
        }
        // A refused edit leaves the behavior running as it was, which the
        // next edit is the diff from.
        at.refused = true;
        await runtime.edit(change);
        at.refused = false;
        at.running = behavior.graph;
        setError(null);
        // An edit may write the store: a device applies a call with a step.
        await readStore();
      }).catch((e: unknown) => setError(message(e))),
    [runtime, at, enqueue, readStore, diff],
  );

  useEffect(() => {
    runnable.current = loaded !== null;
    if (loaded) run(loaded);
  }, [loaded, run]);

  const stop = useCallback(
    () =>
      enqueue(async () => {
        at.started = false;
        at.running = null;
        await runtime.stop();
      }),
    [runtime, at, enqueue],
  );

  // Stopping waits its turn, so a start still queued cannot run after it.
  useEffect(() => () => void stop().catch(() => undefined), [stop]);

  const step = useCallback(() => {
    if (!at.started || !runnable.current || at.stepping) return;
    at.stepping = true;
    enqueue(async () => {
      // A stop, or a text that does not run, may have come while this waited.
      if (!at.started || !runnable.current) return;
      const tick = await runtime.step(1000 / rate);
      setReports((last) => ({ report: tick, previous: last.report }));
      const next = new Map(storeRef.current);
      for (const { key, value } of tick.changes) {
        if (value === null) next.delete(key);
        else next.set(key, value);
      }
      // A written key now holds what the device made of the write.
      for (const key of pendingRef.current) {
        const value = await runtime.read(key);
        if (value === null) next.delete(key);
        else next.set(key, value);
      }
      setPending(new Set());
      setStore(next);
      await readKeys();
      setHistory((h) => {
        const out = new Map<string, readonly (number | null)[]>();
        for (const key of new Set([...h.keys(), ...next.keys()])) {
          const series = [...(h.get(key) ?? []), plotted(next.get(key))];
          out.set(key, series.slice(-HISTORY));
        }
        return out;
      });
    })
      .catch((e: unknown) => {
        fail(e);
        setPlaying(false);
      })
      .finally(() => {
        at.stepping = false;
      });
  }, [runtime, at, rate, enqueue, setStore, setPending, readKeys, fail]);

  const ticking = playing && loaded !== null;
  useEffect(() => {
    if (!ticking) return undefined;
    const timer = setInterval(step, 1000 / rate);
    return () => clearInterval(timer);
  }, [ticking, rate, step]);

  const reset = useCallback(() => {
    if (!loaded) return;
    stop().catch(() => undefined);
    run(loaded);
  }, [loaded, stop, run]);

  // A write shows as written until the next tick says what the runtime made of it.
  const write = useCallback(
    (key: string, value: Value | null) => {
      enqueue(async () => {
        await runtime.write(key, value);
        const next = new Map(storeRef.current);
        if (value === null) next.delete(key);
        else next.set(key, value);
        setStore(next);
        setPending(new Set([...pendingRef.current, key]));
      }).catch(fail);
    },
    [runtime, enqueue, setStore, setPending, fail],
  );

  return {
    report: reports.report,
    previous: reports.previous,
    playing,
    setPlaying,
    rate,
    setRate,
    step,
    reset,
    error,
    store: storeState,
    keys,
    pending: pendingState,
    history,
    write,
  };
}

/** The module functions `runtime` offers, once it has said; and why it could not. */
export function useRuntimeFunctions(runtime: BehaviorRuntime): {
  functions: MethodSignature[];
  error: string | null;
} {
  const [state, setState] = useState<{ functions: MethodSignature[]; error: string | null }>({
    functions: [],
    error: null,
  });
  useEffect(() => {
    let current = true;
    runtime
      .functions()
      .then((functions) => current && setState({ functions, error: null }))
      .catch((e: unknown) => current && setState({ functions: [], error: message(e) }));
    return () => {
      current = false;
    };
  }, [runtime]);
  return state;
}
