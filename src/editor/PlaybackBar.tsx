import { useId } from "react";
import type { Status } from "../runtime/runtime";
import { RATES, type Rate } from "./use-playback";

export interface PlaybackBarProps {
  playing: boolean;
  onPlayingChange(playing: boolean): void;
  onStep(): void;
  onReset(): void;
  rate: Rate;
  onRateChange(rate: Rate): void;
  tick: number;
  root: Status | undefined;
  /** Whether a behavior runs: nothing to play while the document does not resolve. */
  runnable: boolean;
}

const ROOT_WORDS: Record<Status, string> = { S: "Success", F: "Failure", R: "Running" };

/** The clock: play, pause, step and reset, the tick rate, the tick count and the root's status. */
export function PlaybackBar({
  playing,
  onPlayingChange,
  onStep,
  onReset,
  rate,
  onRateChange,
  tick,
  root,
  runnable,
}: PlaybackBarProps) {
  const rateId = useId();
  return (
    <div className="be-playback" role="group" aria-label="Playback">
      <button
        type="button"
        className="be-primary"
        aria-pressed={playing}
        disabled={!runnable}
        onClick={() => onPlayingChange(!playing)}
      >
        {playing ? "Pause" : "Play"}
      </button>
      <button type="button" disabled={!runnable || playing} onClick={onStep}>
        Step
      </button>
      <button type="button" disabled={!runnable} onClick={onReset}>
        Reset
      </button>
      <label className="be-inline" htmlFor={rateId}>
        rate
        <select
          id={rateId}
          value={rate}
          onChange={(event) => onRateChange(Number(event.target.value) as Rate)}
        >
          {RATES.map((r) => (
            <option key={r} value={r}>{`${r} Hz`}</option>
          ))}
        </select>
      </label>
      <output className="be-readout" aria-label="Tick">
        {`tick ${tick}`}
      </output>
      <output className={`be-root-status be-${root ?? "none"}`} aria-label="Root status">
        {root ? ROOT_WORDS[root] : "–"}
      </output>
    </div>
  );
}
