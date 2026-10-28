import { useCallback, useEffect, useRef, useState } from "react";
import type { MethodSignature } from "../model/signature";
import { type Value, valueBoolean, valueNumber } from "../model/value";
import type { BehaviorRuntime, TickReport } from "../runtime/runtime";
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
  /** The store, key by key. */
  store: ReadonlyMap<string, Value>;
  /** The numbers each key held over the last ticks, oldest first. */
  history: ReadonlyMap<string, readonly (number | null)[]>;
  write(key: string, value: Value | null): void;
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
 * Run `loaded` on `runtime` whenever it changes and resolves: start it, tick
 * it at the chosen rate while playing, and keep the store as the ticks leave
 * it. Every call to the runtime waits for the one before, so a tick never
 * overtakes the start it follows.
 */
export function usePlayback(
  runtime: BehaviorRuntime,
  loaded: Loaded | null,
  autoPlay: boolean,
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
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const started = useRef(false);
  const stepping = useRef(false);

  const enqueue = useCallback(<T>(task: () => Promise<T>) => {
    const next = queue.current.then(task);
    queue.current = next.catch(() => undefined);
    return next;
  }, []);

  const readStore = useCallback(async () => {
    const keys = await runtime.keys();
    const values = await Promise.all(keys.map((k) => runtime.read(k)));
    const next = new Map<string, Value>();
    keys.forEach((k, i) => {
      const value = values[i];
      if (value != null) next.set(k, value);
    });
    setStore(next);
    return next;
  }, [runtime, setStore]);

  useEffect(() => {
    enqueue(readStore).catch((e: unknown) => setError(message(e)));
  }, [enqueue, readStore]);

  const start = useCallback(
    (behavior: Loaded) =>
      enqueue(async () => {
        await runtime.start(behavior);
        started.current = true;
        setError(null);
        setReports({ report: null, previous: null });
        setHistory(new Map());
        await readStore();
      }).catch((e: unknown) => {
        started.current = false;
        setError(message(e));
      }),
    [runtime, enqueue, readStore],
  );

  useEffect(() => {
    if (loaded) start(loaded);
  }, [loaded, start]);

  useEffect(
    () => () => {
      started.current = false;
      runtime.stop().catch(() => undefined);
    },
    [runtime],
  );

  const step = useCallback(() => {
    if (!started.current || stepping.current) return;
    stepping.current = true;
    enqueue(async () => {
      const tick = await runtime.step(1000 / rate);
      setReports((last) => ({ report: tick, previous: last.report }));
      const next = new Map(storeRef.current);
      for (const { key, value } of tick.changes) {
        if (value === null) next.delete(key);
        else next.set(key, value);
      }
      setStore(next);
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
        setError(message(e));
        setPlaying(false);
      })
      .finally(() => {
        stepping.current = false;
      });
  }, [runtime, rate, enqueue, setStore]);

  useEffect(() => {
    if (!playing) return undefined;
    const timer = setInterval(step, 1000 / rate);
    return () => clearInterval(timer);
  }, [playing, rate, step]);

  const reset = useCallback(() => {
    if (!loaded) return;
    enqueue(() => runtime.stop()).catch(() => undefined);
    start(loaded);
  }, [loaded, runtime, enqueue, start]);

  const write = useCallback(
    (key: string, value: Value | null) => {
      enqueue(async () => {
        await runtime.write(key, value);
        const read = await runtime.read(key);
        const next = new Map(storeRef.current);
        if (read === null) next.delete(key);
        else next.set(key, read);
        setStore(next);
      }).catch((e: unknown) => setError(message(e)));
    },
    [runtime, enqueue, setStore],
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
