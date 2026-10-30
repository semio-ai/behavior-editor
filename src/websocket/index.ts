/**
 * `@semio/behavior-editor/websocket`: a device's open local bridge,
 * `arora-bridge-ws`, as a `BridgeClient`, and the bar that connects to it by
 * URL.
 */
import { DeviceSession, type DeviceSessionOptions } from "../session/device-session";
import { WebSocketBridge, type WebSocketBridgeOptions } from "./websocket-bridge";

export {
  LOCAL_BRIDGE_URL,
  WebSocketBridge,
  type WebSocketBridgeOptions,
  type WebSocketLike,
} from "./websocket-bridge";
export { WebSocketConnectionBar, type WebSocketConnectionBarProps } from "./WebSocketConnectionBar";

/**
 * A session with the device behind the open local bridge at `url`
 * (`LOCAL_BRIDGE_URL` on a device serving it with its defaults), connecting
 * as it is returned, and again after a loss unless `reconnect` is `false`.
 */
export function connectWebSocket(
  url: string,
  options: Omit<DeviceSessionOptions, "label"> & WebSocketBridgeOptions,
): DeviceSession {
  const { timeoutMs, open, ...session } = options;
  const bridge: WebSocketBridgeOptions = {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(open ? { open } : {}),
  };
  return new DeviceSession(() => WebSocketBridge.connect(url, bridge), { ...session, label: url });
}
