import { useEffect, useState } from "react";
import type { MethodSignature } from "../model/signature";
import { type Value, valueBoolean, valueNumber } from "../model/value";

/** Whatever says the module functions it offers: an Arora's session. */
export interface FunctionSource {
  functions(): Promise<MethodSignature[]>;
}

/** How many ticks a plotted key keeps. */
export const HISTORY = 240;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A key's value as a number to plot: a number, or a boolean as 0 or 1. */
function plotted(value: Value | undefined): number | null {
  const n = valueNumber(value);
  if (n !== undefined) return n;
  const b = valueBoolean(value);
  return b === undefined ? null : Number(b);
}

/** `history` with one more tick, the store as `store` holds it. */
export function withTick(
  history: ReadonlyMap<string, readonly (number | null)[]>,
  store: ReadonlyMap<string, Value>,
): ReadonlyMap<string, readonly (number | null)[]> {
  const out = new Map<string, readonly (number | null)[]>();
  for (const key of new Set([...history.keys(), ...store.keys()])) {
    const series = [...(history.get(key) ?? []), plotted(store.get(key))];
    out.set(key, series.slice(-HISTORY));
  }
  return out;
}

/**
 * The module functions `runtime` offers, once it has said; and why it could
 * not. `known` is false until the runtime of this render has said: what
 * another runtime said is not this one's. A change of `asked` asks again,
 * what the runtime said before showing until it answers: a device reached
 * again may offer other functions, and one asked while unreachable answers
 * none.
 */
export function useRuntimeFunctions(
  runtime: FunctionSource,
  asked?: unknown,
): {
  functions: MethodSignature[];
  error: string | null;
  known: boolean;
} {
  const [state, setState] = useState<{
    runtime: FunctionSource | null;
    functions: MethodSignature[];
    error: string | null;
  }>({ runtime: null, functions: [], error: null });
  useEffect(() => {
    let current = true;
    runtime
      .functions()
      .then((functions) => current && setState({ runtime, functions, error: null }))
      .catch((e: unknown) => current && setState({ runtime, functions: [], error: message(e) }));
    return () => {
      current = false;
    };
  }, [runtime, asked]);
  return state.runtime === runtime
    ? { functions: state.functions, error: state.error, known: true }
    : { functions: [], error: null, known: false };
}
