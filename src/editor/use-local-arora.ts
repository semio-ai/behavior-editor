import { useCallback, useEffect, useRef, useState } from "react";
import type { DeviceSession } from "../session/device-session";

/** The local Arora an editor keeps: its session once started, and how to start it. */
export interface LocalArora {
  session: DeviceSession | null;
  /** Start it; absent when the host offers no local Arora. */
  start: (() => void) | undefined;
  /** Why it did not start. */
  error: string | null;
}

/**
 * The local Arora `create` makes, started when asked, or as the component
 * mounts with `atStart`, and kept until it unmounts: switching to another
 * Arora and back finds it as it was left.
 */
export function useLocalArora(
  create: (() => DeviceSession) | undefined,
  atStart: boolean,
): LocalArora {
  const [session, setSession] = useState<DeviceSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<DeviceSession | null>(null);
  const made = useRef(create);
  made.current = create;

  const start = useCallback(() => {
    const make = made.current;
    if (current.current || !make) return;
    try {
      const next = make();
      current.current = next;
      setSession(next);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (atStart) start();
    // Unmounted, the local Arora goes, its device with it.
    return () => {
      const started = current.current;
      current.current = null;
      setSession(null);
      void started?.close();
    };
  }, [atStart, start]);

  return { session, start: create ? start : undefined, error };
}
