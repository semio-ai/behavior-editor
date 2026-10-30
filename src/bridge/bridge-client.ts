/**
 * A client's end of an Arora bridge: what any remote client of a device asks
 * of it, whatever carries the asking. The operations are `arora_bridge`'s
 * `BridgeOp`s, and the values the device pushes as it steps are its outbound
 * `StateChange`s; every shape is the serde JSON Arora gives it. The open local
 * WebSocket bridge (`@semio/behavior-editor/websocket`), Semio Studio's
 * bridge, a ROS 2 bridge or a device in the page each implement it.
 */
import type { MethodSignature } from "../model/signature";
import type { Value } from "../model/value";

/** A call of a module function by ids: `arora_types::call::Call`. */
export interface Call {
  module_id?: string | null;
  id: string;
  args: unknown[];
}

/** What a call answers: `arora_types::call::CallResult`. */
export interface CallResult {
  ret: Value | null;
  mutated: unknown[];
}

/** What a device's store says a key is: `arora_types::data::KeyMeta`, as far as a client reads it. */
export interface KeyMeta {
  ty?: string;
  min?: number;
  max?: number;
  /** Whether a client may write it. */
  editable?: boolean;
}

/** A key of the device and what its store says it is: `arora_bridge::client::KeyInfo`. */
export interface BridgeKey {
  path: string;
  __meta?: KeyMeta;
}

/** How a connection to a device ended. */
export interface BridgeClosure {
  /** What ended it, in words. */
  reason: string;
  /**
   * - `closed`: this side closed it.
   * - `refused`: the device ended it on purpose, saying why, as a bridge
   *   serving one client does when another takes it: connecting again would
   *   take it back.
   * - `lost`: it dropped, or the device stopped answering: connecting again
   *   may find the device.
   */
  cause: "closed" | "refused" | "lost";
}

/**
 * One connection to a device, through its bridge. Each operation answers when
 * the device does; a refusal rejects with the device's reason, and so does
 * every operation once the connection ended.
 *
 * The device steps on its own, and a client does not step it, save the one
 * client of a device the page itself steps, the local Arora's, which offers
 * `step`. It pushes what each step changed, its clock `arora/time` among it,
 * to `onValues`' listeners.
 * Values cross as the JSON of Arora's `Value`, an integer past ±(2^53 − 1)
 * keeping its digits where the transport parses with `parseExact`.
 *
 * An answer and the pushes keep the order the device sent them in: what
 * `readValues` answers is current as of every push delivered before it, and a
 * push delivered after it is newer.
 */
export interface BridgeClient {
  /** `BridgeOp::DescribeMethods`: the module functions whose name starts with `prefix`, all without. */
  describeMethods(prefix?: string): Promise<MethodSignature[]>;
  /** `BridgeOp::Call`: call a module function, the interpreter's among them. */
  call(call: Call): Promise<CallResult>;
  /** `BridgeOp::Get`: the values `keys` hold; a key that holds none is absent. */
  readValues(keys: readonly string[]): Promise<Record<string, Value>>;
  /**
   * `BridgeOp::Update`: write `values`, applied at the device's next step. A
   * key the device keeps closed to clients is refused, the whole write with it.
   */
  writeValues(values: Record<string, Value>): Promise<void>;
  /** `BridgeOp::ListKeys`: the keys whose path starts with `prefix`, all without. */
  listKeys(prefix?: string): Promise<BridgeKey[]>;
  /**
   * Listen to the values the device pushes, each push what one step set; with
   * `prefixes`, only the keys starting with one of them. The function
   * returned stops listening.
   */
  onValues(listener: (values: Record<string, Value>) => void, prefixes?: readonly string[]): () => void;
  /**
   * Step the device by `dtMs` milliseconds, pushing what the step changed
   * before answering: offered by the client of a device the page steps, as
   * the local Arora's is, and absent on a device that steps itself, as every
   * remote one does.
   */
  step?(dtMs: number): Promise<void>;
  /** End the connection. The device goes on running its behavior. */
  close(): void;
  /** Settles when the connection ends, with why. */
  readonly closed: Promise<BridgeClosure>;
}
