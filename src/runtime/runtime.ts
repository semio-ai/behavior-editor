import type { MethodSignature } from "../model/signature";
import type { Value } from "../model/value";
import type { Loaded } from "../text/language";

/** A node's status after a tick: Success, Failure or Running. */
export type Status = "S" | "F" | "R";

/** What became of a detached node in a tick. */
export type DetachedActivity =
  /** Brought up to date by calling its function: its arguments changed. */
  | "called"
  /** Brought up to date from its cache: its arguments had not changed. */
  | "cached"
  /** Not brought up to date: nothing read it. */
  | "idle";

/** What one tick did. */
export interface TickReport {
  /** The number of this tick since the behavior started, from 1. */
  tick: number;
  root?: Status;
  /** The nodes ticked this tick, by graph node id. Absent when the runtime cannot say. */
  statuses?: Record<string, Status>;
  /** The detached nodes, by graph node id. Absent when the runtime cannot say. */
  detached?: Record<string, DetachedActivity>;
  /**
   * Each node's return value (`_ret`) after the tick, by graph node id: a
   * detached node's from its last call, a module leaf's when it ticked.
   * Absent when the runtime cannot say.
   */
  values?: Record<string, Value>;
  /** The store keys the tick changed, each at its value after the tick; `null` unset. */
  changes: { key: string; value: Value | null }[];
}

/** Where a behavior runs: a device, or a mock of one. */
export interface BehaviorRuntime {
  /** The modules' functions; the natives come from the language service. */
  functions(): Promise<MethodSignature[]>;
  /** Run this behavior, in place of the previous one. */
  start(loaded: Loaded): Promise<void>;
  /** Advance one tick of `dtMs` milliseconds. */
  step(dtMs: number): Promise<TickReport>;
  /** Write a store key; `null` unsets it. */
  write(key: string, value: Value | null): Promise<void>;
  read(key: string): Promise<Value | null>;
  /** The store's keys. */
  keys(): Promise<string[]>;
  /** Stop the behavior. The store keeps its values. */
  stop(): Promise<void>;
}
