import { useCallback, useId, useSyncExternalStore } from "react";
import type { ClockState, DeviceSession } from "../session/device-session";

/** The rates a person picks for an Arora the page steps, in steps per second. */
export const RATES = [10, 30, 60] as const;

/** `session`'s clock, kept current. */
function useClockState(session: DeviceSession): ClockState {
  const subscribe = useCallback((changed: () => void) => session.on("clock", changed), [session]);
  return useSyncExternalStore(
    subscribe,
    () => session.clockState,
    () => session.clockState,
  );
}

/**
 * The clock of an Arora the page steps, the local one: play, pause, a step
 * at a time, and the rate. An Arora on its own clock has none: it steps
 * itself.
 */
export function PlaybackBar({ session }: { session: DeviceSession }) {
  const rateId = useId();
  const { playing, rate } = useClockState(session);
  const state = useSyncExternalStore(
    useCallback((changed: () => void) => session.on("state", changed), [session]),
    () => session.state,
    () => session.state,
  );
  if (state.status !== "connected" || session.clock !== "driven") return null;
  const rates: readonly number[] = RATES.includes(rate as (typeof RATES)[number])
    ? RATES
    : [...RATES, rate].sort((a, b) => a - b);
  return (
    <div className="be-playback" role="group" aria-label="Playback">
      <button
        type="button"
        className="be-primary"
        aria-pressed={playing}
        onClick={() => (playing ? session.pause() : session.play())}
      >
        {playing ? "Pause" : "Play"}
      </button>
      <button
        type="button"
        disabled={playing}
        onClick={() => void session.step().catch(() => undefined)}
      >
        Step
      </button>
      <label className="be-inline" htmlFor={rateId}>
        rate
        <select
          id={rateId}
          value={rate}
          onChange={(event) => session.setRate(Number(event.target.value))}
        >
          {rates.map((r) => (
            <option key={r} value={r}>{`${r} Hz`}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
