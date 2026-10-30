import { useId } from "react";
import type { Status } from "../runtime/runtime";
import type { DeviceMode } from "./use-device-mode";

const ROOT_WORDS: Record<Status, string> = { S: "Success", F: "Failure", R: "Running" };

/** A rate, in steps per second, as the bar shows it. */
const hertz = (rate: number) => `${rate >= 10 ? Math.round(rate) : rate.toFixed(1)} Hz`;

/**
 * The device's clock in place of the editor's: the device steps itself, so
 * its tick, step rate and clock show where Play, Step and the rate would.
 * While the device runs the file, the switch that sends each change as it is
 * made, the Apply that sends the changes waiting, and Stop on device.
 */
export function DeviceBar({ device }: { device: DeviceMode }) {
  const switchId = useId();
  const { status, relation, report } = device;
  const lost = device.state?.status !== "connected";
  const root = relation === "running" ? report?.root : undefined;
  return (
    <div className="be-playback be-device-bar" role="group" aria-label="Device">
      <output className="be-readout" aria-label="Device tick">
        {status.tick === null ? "tick –" : `tick ${status.tick}`}
      </output>
      <output className="be-readout" aria-label="Step rate">
        {status.rate === null ? "– Hz" : hertz(status.rate)}
      </output>
      <output className="be-readout" aria-label="Device clock">
        {status.time === null ? "– s" : `${status.time.toFixed(1)} s`}
      </output>
      {status.revision !== null && (
        <output className="be-readout be-fine" aria-label="Behavior revision">
          {`rev ${status.revision}`}
        </output>
      )}
      <output className={`be-root-status be-${root ?? "none"}`} aria-label="Root status">
        {root ? ROOT_WORDS[root] : "–"}
      </output>
      {relation === "running" && (
        <>
          <span className="be-switch">
            <input
              id={switchId}
              type="checkbox"
              role="switch"
              checked={device.liveEdits}
              onChange={(event) => device.setLiveEdits(event.target.checked)}
            />
            <label htmlFor={switchId}>Live edits</label>
          </span>
          {(!device.liveEdits || lost) && (
            <button
              type="button"
              className="be-primary"
              disabled={!device.pendingChanges || lost}
              onClick={device.apply}
            >
              {`Apply ${device.pendingChanges} ${device.pendingChanges === 1 ? "change" : "changes"}`}
            </button>
          )}
          <button type="button" className="be-danger" disabled={lost} onClick={device.stop}>
            Stop on device
          </button>
        </>
      )}
    </div>
  );
}
