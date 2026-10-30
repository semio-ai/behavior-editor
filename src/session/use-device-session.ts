import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { BridgeClient } from "../bridge/bridge-client";
import { DeviceSession, type DeviceSessionOptions, type SessionState } from "./device-session";

/** A device connection a host offers the person: the session, where it stands, and how to make and end it. */
export interface DeviceConnection {
  /** The session, from the connection asked for until it is let go of. */
  session: DeviceSession | null;
  /** Where the session stands; `null` with none. */
  state: SessionState | null;
  /**
   * Connect over `bridge`, a connection, or the one `bridge()` opens (again
   * after a loss), in place of any session: the one before is closed first.
   * `label` names what it connects to.
   */
  connect(bridge: BridgeClient | (() => Promise<BridgeClient>), label?: string): void;
  /** Close the session, the device left running its behavior. */
  disconnect(): void;
}

/**
 * A device session the person makes and ends, over whatever bridge the host
 * hands `connect`: the session before is closed before the next connects,
 * as a bridge may serve one client. The session closes as the component
 * unmounts.
 */
export function useDeviceSession(options: Omit<DeviceSessionOptions, "label">): DeviceConnection {
  const [session, setSession] = useState<DeviceSession | null>(null);
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  /** Settles once the session let go of last is closed. */
  const released = useRef<Promise<void>>(Promise.resolve());
  /** Counts the connections asked for: one asked for again before it started is not made. */
  const asked = useRef(0);
  const current = useRef<DeviceSession | null>(null);

  const release = useCallback(() => {
    const before = current.current;
    current.current = null;
    if (before) released.current = released.current.then(() => before.close());
  }, []);

  const connect = useCallback(
    (bridge: BridgeClient | (() => Promise<BridgeClient>), label?: string) => {
      const attempt = ++asked.current;
      release();
      released.current = released.current.then(() => {
        if (asked.current !== attempt) {
          if (typeof bridge !== "function") bridge.close();
          return;
        }
        const next = new DeviceSession(bridge, {
          ...latest.current,
          ...(label === undefined ? {} : { label }),
        });
        current.current = next;
        setSession(next);
      });
    },
    [release],
  );

  const disconnect = useCallback(() => {
    asked.current += 1;
    release();
    setSession(null);
  }, [release]);

  // Unmounted, a connection still waiting for the one before to close is not made.
  useEffect(
    () => () => {
      asked.current += 1;
      release();
    },
    [release],
  );

  const state = useSessionState(session);
  return { session, state, connect, disconnect };
}

/** Where `session` stands, kept current; `null` with none. */
export function useSessionState(session: DeviceSession | null): SessionState | null {
  const subscribe = useCallback(
    (changed: () => void) => (session ? session.on("state", changed) : () => {}),
    [session],
  );
  // A server renders no connection: one exists in the browser alone.
  return useSyncExternalStore(
    subscribe,
    () => session?.state ?? null,
    () => null,
  );
}
