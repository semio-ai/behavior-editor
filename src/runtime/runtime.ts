import type { GraphDiff } from "../model/graph";
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
  /** Whether `changes` states every key of the store: a key it leaves out is unset. */
  whole?: boolean;
}

/** A store key as its runtime describes it. */
export interface KeyInfo {
  key: string;
  /**
   * Whether a person may write it: a device's meta opens it, or the mock
   * takes it as an input. A key the runtime writes itself, its clock, is not.
   */
  editable: boolean;
  /** The value tag its values take (`f64`, `bool`, `str`…), when the runtime says. */
  ty?: string;
  min?: number;
  max?: number;
}

/** Where a behavior runs: a device, or a mock of one. */
export interface BehaviorRuntime {
  /** The modules' functions; the natives come from the language service. */
  functions(): Promise<MethodSignature[]>;
  /**
   * Run this behavior from its first tick, in place of the previous one:
   * every node starts afresh.
   */
  start(loaded: Loaded): Promise<void>;
  /**
   * Apply `diff` to the behavior running, the diff from the graph it runs
   * to the next: the nodes the diff sets or binds restart, and every other
   * node keeps its state and goes on from where it was. Refused when no
   * behavior runs. `next` is the behavior the edit makes, for a runtime that
   * follows its nodes by what the text says of them.
   */
  edit(diff: GraphDiff, next?: Loaded): Promise<void>;
  /**
   * Advance one tick of `dtMs` milliseconds. A runtime following a device on
   * its own clock makes no tick: it waits for the device's next step, and
   * reports what changed since the last tick it reported.
   */
  step(dtMs: number): Promise<TickReport>;
  /** Write a store key; `null` unsets it. */
  write(key: string, value: Value | null): Promise<void>;
  read(key: string): Promise<Value | null>;
  /** The store's keys, each with what a person may do with it. */
  keys(): Promise<KeyInfo[]>;
  /** Stop the behavior. The store keeps its values. */
  stop(): Promise<void>;
}
