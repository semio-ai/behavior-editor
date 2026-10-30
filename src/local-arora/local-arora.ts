import type { KeyMeta } from "../bridge/bridge-client";
import type { Value } from "../model/value";
import { DeviceSession, type SessionLanguage } from "../session/device-session";
import { type PageDevice, PageBridge } from "./page-bridge";

/** `@arora/dataflow`'s module id, the module the local Arora carries. */
export const DATAFLOW_MODULE_ID = "64617461-666c-6f77-0000-000000000001";

/** The local Arora's device: `DataflowDevice` of `@semio/behavior-editor/device`. */
export interface LocalDevice extends PageDevice {
  /** Release the device's memory; it answers nothing after. */
  free(): void;
}

/** `@semio/behavior-editor/device`, once its wasm is initialized. */
export interface DeviceModule {
  /**
   * A device whose keys sit under `namespace`, its inputs described by
   * `inputsJson`: device-relative keys to their `KeyMeta`.
   */
  DataflowDevice: new (namespace: string, inputsJson: string) => LocalDevice;
}

export interface LocalAroraOptions {
  /**
   * The keys a person sets, device-relative, each with what its store says
   * of it: its type, its bounds, and `editable`, without which the device
   * refuses a write from outside it.
   */
  inputs?: Readonly<Record<string, KeyMeta>>;
  /** The values keys start from: inputs, each open to the write. */
  values?: Readonly<Record<string, Value>>;
  /** What the session names it: "Local Arora" by default. */
  label?: string;
  /** Its steps per second: 30 by default. */
  rate?: number;
  /** Whether the session steps it from the start: `true` by default. */
  playing?: boolean;
}

/** The namespace the device's keys sit under in its host store, one device to a store. */
const NAMESPACE = "local";

/**
 * A session with a local Arora: a real Arora device in the page, carrying
 * `@arora/dataflow`, reached through a bridge client as a remote device is
 * (`PageBridge`). The session drives its clock (`clock` is `driven`): it
 * steps the device at its rate while it plays, or a step at a time. Closing
 * the session releases the device.
 *
 * ```ts
 * import initDevice, * as device from "@semio/behavior-editor/device";
 * await initDevice();
 * const local = createLocalArora(device, language, { inputs, values });
 * ```
 *
 * Throws when a value to start from is refused: a key no input opens, or a
 * value not of its input's type.
 */
export function createLocalArora(
  device: DeviceModule,
  language: SessionLanguage,
  { inputs = {}, values = {}, label = "Local Arora", rate, playing }: LocalAroraOptions = {},
): DeviceSession {
  const made = new device.DataflowDevice(NAMESPACE, JSON.stringify(inputs));
  try {
    if (Object.keys(values).length) {
      made.update(JSON.stringify(values));
      // The step that applies the write refuses one the inputs do not open.
      made.step(0);
    }
  } catch (error) {
    made.free();
    throw error;
  }
  const bridge = new PageBridge(made, { namespace: NAMESPACE });
  // The device goes with its connection.
  void bridge.closed.then(() => made.free());
  return new DeviceSession(bridge, {
    language,
    label,
    ...(rate === undefined ? {} : { rate }),
    ...(playing === undefined ? {} : { playing }),
  });
}
