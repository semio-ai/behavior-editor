import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { TickReport } from "../runtime/runtime";
import type { DeviceHistory, HistoryState } from "../session/device-history";
import { DT_KEY, type DeviceSession, REVISION_KEY } from "../session/device-session";
import { valueNumber, valuePlotted } from "../model/value";
import { HISTORY } from "./use-functions";
import type { DeviceMode } from "./use-device-mode";

/** The speeds a person replays the past at. */
export const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4] as const;

/** How often the timeline shows the history growing, at most, in milliseconds. */
const GROWTH_MS = 100;
/** How often a replay of the past moves on, in milliseconds. */
const PLAY_MS = 33;
/** The steps a second a replay moves through a history whose device pushed no clock. */
const STEPS_PER_S = 30;

/** Where a replay of the past stands: the step shown, and the time on the device's clock it has reached. */
export interface ReplayPosition {
  cursor: number;
  /** Seconds on the device's clock; `null` where its steps have none, replayed a step at a time. */
  time: number | null;
  /** Where a replay a step at a time stands between two steps, as a fraction of a step. */
  part?: number;
}

/** Where a replay starts from step `cursor`. */
export function replayFrom(history: Pick<DeviceHistory, "time">, cursor: number): ReplayPosition {
  return { cursor, time: history.time(cursor) };
}

/**
 * Where a replay at `at` stands `dtS` seconds later at `speed`: on the
 * device's clock where it has one, `STEPS_PER_S` steps a second (at `speed`,
 * fractions of a step adding up) where it has none, taking up the clock at
 * the first step that has it. `null` once it reaches the newest step: the
 * timeline is live again.
 */
export function advanceReplay(
  history: Pick<DeviceHistory, "length" | "time" | "indexAt">,
  at: ReplayPosition,
  dtS: number,
  speed: number,
): ReplayPosition | null {
  const last = history.length - 1;
  let next: ReplayPosition;
  if (at.time === null) {
    const steps = (at.part ?? 0) + dtS * speed * STEPS_PER_S;
    // A step at a time up to the first that has the clock; what is left of
    // the elapsed time runs on that clock from there.
    let cursor = at.cursor;
    let time: number | null = null;
    for (let taken = 1; taken <= Math.floor(steps) && cursor < last; taken++) {
      cursor += 1;
      time = history.time(cursor);
      if (time !== null) {
        time += (steps - taken) / STEPS_PER_S;
        cursor = Math.max(cursor, history.indexAt(time));
        break;
      }
    }
    next = time === null ? { cursor, time: null, part: steps % 1 } : { cursor, time };
  } else {
    const time = at.time + dtS * speed;
    next = { cursor: Math.max(at.cursor, history.indexAt(time)), time };
  }
  return next.cursor >= last ? null : next;
}

/** The timeline of the device the editor follows: live, or a step of its past, replayed or held. */
export interface Timeline {
  /** The history of the device's steps; `null` with no device, or a session that keeps none. */
  history: DeviceHistory | null;
  /** The steps the history holds. */
  length: number;
  /** The step shown; `null` while the timeline is live, following the device's newest. */
  cursor: number | null;
  /** The device's state at `cursor`, and at the step before; `null` while live. */
  shown: HistoryState | null;
  previous: HistoryState | null;
  /** Whether the past replays, at `speed`. */
  playing: boolean;
  speed: number;
  /** Show step `index` of the past, holding there unless it replays. */
  seek(index: number): void;
  /** Follow the device's newest step again. */
  goLive(): void;
  play(): void;
  pause(): void;
  setSpeed(speed: number): void;
}

/** The history `session` keeps for its connection, kept current. */
function useHistory(session: DeviceSession | null): DeviceHistory | null {
  const subscribe = useCallback(
    (changed: () => void) => session?.on("history", changed) ?? (() => {}),
    [session],
  );
  return useSyncExternalStore(
    subscribe,
    () => session?.history ?? null,
    () => session?.history ?? null,
  );
}

/**
 * How many steps `history` holds, and a count of its changes, told at most
 * every `GROWTH_MS`: a push without the clock changes the last step without
 * adding one.
 */
function useGrowth(history: DeviceHistory | null): { length: number; revision: number } {
  const [growth, setGrowth] = useState({ length: history?.length ?? 0, revision: 0 });
  useEffect(() => {
    if (!history) {
      setGrowth((was) => ({ length: 0, revision: was.revision + 1 }));
      return;
    }
    setGrowth((was) => ({ length: history.length, revision: was.revision + 1 }));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stop = history.onChange(() => {
      timer ??= setTimeout(() => {
        timer = null;
        setGrowth((was) => ({ length: history.length, revision: was.revision + 1 }));
      }, GROWTH_MS);
    });
    return () => {
      stop();
      if (timer) clearTimeout(timer);
    };
  }, [history]);
  return growth;
}

/**
 * The timeline of `session`'s device. Live, the editor shows the device as the
 * session follows it; on a step of the past, as the history rebuilds it,
 * while the history goes on growing. Going back and forth changes nothing on
 * the device, nor the connection.
 */
export function useTimeline(session: DeviceSession | null): Timeline {
  const history = useHistory(session);
  const { length, revision } = useGrowth(history);
  const [cursor, setCursor] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  /**
   * The step the replay going on was started, sought or sped up from: a new
   * object each time, so that seeking the same step again starts it there anew.
   */
  const [startedAt, setStartedAt] = useState<{ step: number } | null>(null);
  // Another device's history, or another connection's, starts live.
  const [known, setKnown] = useState(history);
  if (known !== history) {
    setKnown(history);
    setCursor(null);
    setStartedAt(null);
    setPlaying(false);
  }

  // A replay moves on from where it was started, sought or sped up.
  const position = useRef<ReplayPosition | null>(null);
  useEffect(() => {
    if (!history || !playing || startedAt === null) return;
    position.current = replayFrom(history, startedAt.step);
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      const next = position.current && advanceReplay(history, position.current, (now - last) / 1000, speed);
      last = now;
      position.current = next;
      if (next === null) {
        setCursor(null);
        setPlaying(false);
      } else setCursor(next.cursor);
    }, PLAY_MS);
    return () => clearInterval(timer);
  }, [history, playing, startedAt, speed]);

  /** Show step `index`, a replay going on from it. */
  const show = useCallback((index: number) => {
    setCursor(index);
    setStartedAt({ step: index });
  }, []);
  const seek = useCallback(
    (index: number) => {
      if (!history || !history.length) return;
      show(Math.min(Math.max(0, Math.round(index)), history.length - 1));
    },
    [history, show],
  );
  const goLive = useCallback(() => {
    setCursor(null);
    setStartedAt(null);
    setPlaying(false);
  }, []);
  const play = useCallback(() => {
    if (!history || history.length < 2) return;
    // Live, a replay starts from the beginning.
    show(cursor ?? 0);
    setPlaying(true);
  }, [history, cursor, show]);
  const pause = useCallback(() => {
    // Live, a pause holds the newest step.
    const at = cursor ?? (history && history.length ? history.length - 1 : null);
    if (at !== null) show(at);
    setPlaying(false);
  }, [history, cursor, show]);
  const changeSpeed = useCallback(
    (next: number) => {
      // A replay goes on from the step it shows, at the new speed.
      if (cursor !== null) setStartedAt({ step: cursor });
      setSpeed(next);
    },
    [cursor],
  );

  // Rebuilt as the history changes too: a push can complete the step shown.
  const shown = useMemo(
    () => (history && cursor !== null && history.length ? history.at(cursor) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `revision` stands for the history's contents.
    [history, cursor, revision],
  );
  const previous = useMemo(
    () => (history && cursor !== null && cursor > 0 ? history.at(cursor - 1) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `revision` stands for the history's contents.
    [history, cursor, revision],
  );
  return {
    history,
    length,
    cursor,
    shown,
    previous,
    playing,
    speed,
    seek,
    goLive,
    play,
    pause,
    setSpeed: changeSpeed,
  };
}

/** A tick report of the state `state` rebuilds: the nodes' only when the device runs the file. */
export function historyReport(
  state: HistoryState,
  root: string | undefined,
  nodes: boolean,
): TickReport {
  const report: TickReport = { tick: state.tick ?? 0, changes: [] };
  if (!nodes) return report;
  const rootStatus = root === undefined ? undefined : state.statuses[root];
  return {
    ...report,
    ...(rootStatus ? { root: rootStatus } : {}),
    statuses: state.statuses,
    detached: state.detached,
    values: state.values,
  };
}

/** The device's step rate at a step of its past, in Hz, from its `arora/dt`. */
function rateOf(state: HistoryState): number | null {
  const ns = valueNumber(state.store.get(DT_KEY));
  return ns ? 1e9 / ns : null;
}

/** The device's behavior revision at a step of its past. */
function revisionOf(state: HistoryState): number | null {
  return valueNumber(state.store.get(REVISION_KEY)) ?? null;
}

/**
 * The device as the editor shows it at the timeline's step: as `device` has it
 * live, or rebuilt from the history at a step of the past, its report, store,
 * tick and clock then, the nodes' states those of `root`'s behavior when
 * `nodes` says the editor shows the behavior the device ran then. Writing
 * goes to the device as ever: it acts on its present.
 */
export function atTimeline(
  device: DeviceMode,
  timeline: Timeline,
  root: string | undefined,
  nodes: boolean,
): DeviceMode {
  const { shown, previous, history } = timeline;
  if (!shown || !history) return device;
  // The plots end at the step shown, a point a step, as many as the live plot
  // holds; a key the live plots never sampled has a window of its own.
  const plotted = new Map<string, (number | null)[]>();
  for (const [key, live] of device.history) plotted.set(key, history.series(key, shown.index, live.length));
  for (const [key, value] of shown.store) {
    if (!plotted.has(key) && valuePlotted(value) !== null) plotted.set(key, history.series(key, shown.index, HISTORY));
  }
  return {
    ...device,
    report: historyReport(shown, root, nodes),
    previous: previous ? historyReport(previous, root, nodes) : null,
    store: shown.store,
    history: plotted,
    // The rate and the revision as they were then too: `null` where the step's store lacks them.
    status: { ...device.status, tick: shown.tick, time: shown.time, rate: rateOf(shown), revision: revisionOf(shown) },
  };
}
