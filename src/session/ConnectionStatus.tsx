import { useEffect, useState } from "react";
import type { SessionState } from "./device-session";
import type { DeviceConnection } from "./use-device-session";

/** The seconds left until `at`, on `Date.now()`'s clock, kept current. */
function useSecondsUntil(at: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at === null) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [at]);
  return at === null ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/** What a connection's state says, `label` naming what it connects to. */
export function sessionStateText(
  state: SessionState | null,
  label: string | undefined,
  seconds: number | null,
): string {
  const to = label ?? "the device";
  switch (state?.status) {
    case undefined:
      return "Not connected";
    case "connecting":
      return `Connecting to ${to}…`;
    case "connected":
      return `Connected to ${to}`;
    case "lost":
      return `Connection lost: ${state.reason}. ${
        seconds ? `Reconnecting in ${seconds} s…` : "Reconnecting…"
      }`;
    case "closed":
      if (state.reason === null) return "Not connected";
      return state.refused ? `Refused: ${state.reason}` : `Not connected: ${state.reason}`;
  }
}

/** Whether `state` is one a person can end: connecting, connected, or lost and connecting again. */
export function isLive(state: SessionState | null): boolean {
  return state?.status === "connecting" || state?.status === "connected" || state?.status === "lost";
}

/**
 * Where a device connection stands, whatever carries it: connecting,
 * connected, lost and reconnecting, refused with why, closed; and the button
 * that ends it, which leaves the device running its behavior.
 */
export function ConnectionStatus({ connection }: { connection: DeviceConnection }) {
  const { session, state, disconnect } = connection;
  const seconds = useSecondsUntil(state?.status === "lost" ? state.retryAt : null);
  const failed = state?.status === "closed" && state.reason !== null;
  const dot = state === null || (state.status === "closed" && !failed) ? "none" : state.status;
  return (
    <span className="be-connection-status">
      <span className={`be-connection-dot be-connection-${dot}`} aria-hidden="true" />
      <span role={failed ? "alert" : "status"}>
        {sessionStateText(state, session?.label, seconds)}
      </span>
      {isLive(state) && (
        <button type="button" onClick={disconnect}>
          {state?.status === "connected" ? "Disconnect" : "Cancel"}
        </button>
      )}
    </span>
  );
}
