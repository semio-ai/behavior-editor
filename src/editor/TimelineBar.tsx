import { useId } from "react";
import { SPEEDS, type Timeline } from "./use-timeline";

/** Seconds as the bar shows them. */
const seconds = (s: number | null) => (s === null ? "–" : `${s.toFixed(2)} s`);

/**
 * The device's past, kept as it was pushed: a scrubber over every step since
 * the connection, Replay / Hold to replay it at a speed, and Live to follow the
 * device's newest step again. The history goes on growing meanwhile; nothing
 * of this reaches the device.
 */
export function TimelineBar({ timeline }: { timeline: Timeline }) {
  const speedId = useId();
  const { history, length, cursor, playing, speed } = timeline;
  if (!history || length === 0) return null;
  const last = length - 1;
  const at = cursor ?? last;
  const live = cursor === null;
  const speeds: readonly number[] = SPEEDS.includes(speed as (typeof SPEEDS)[number])
    ? SPEEDS
    : [...SPEEDS, speed].sort((a, b) => a - b);
  return (
    <div className="be-playback be-timeline" role="group" aria-label="Timeline">
      <button
        type="button"
        className={live ? "be-primary" : undefined}
        aria-pressed={live}
        title="Follow the device's newest step"
        onClick={timeline.goLive}
      >
        Live
      </button>
      <button
        type="button"
        aria-pressed={playing}
        disabled={length < 2}
        title={playing ? "Hold the step shown" : "Replay the past from the step shown"}
        onClick={playing ? timeline.pause : timeline.play}
      >
        {playing ? "Hold" : "Replay"}
      </button>
      <input
        type="range"
        className="be-timeline-scrub"
        aria-label="Step shown"
        min={0}
        max={last}
        step={1}
        value={at}
        onChange={(event) => timeline.seek(Number(event.target.value))}
      />
      <output className="be-readout" aria-label="Time shown">
        {`${seconds(history.time(at))} / ${seconds(history.time(last))}`}
      </output>
      <label className="be-inline" htmlFor={speedId}>
        speed
        <select
          id={speedId}
          value={speed}
          onChange={(event) => timeline.setSpeed(Number(event.target.value))}
        >
          {speeds.map((s) => (
            <option key={s} value={s}>{`${s}×`}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
