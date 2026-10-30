import { type FormEvent, useId, useState } from "react";
import { ConnectionStatus, isLive } from "../session/ConnectionStatus";
import type { DeviceConnection } from "../session/use-device-session";
import { LOCAL_BRIDGE_URL, WebSocketBridge, type WebSocketBridgeOptions } from "./websocket-bridge";

export interface WebSocketConnectionBarProps {
  /** The connection, as `useDeviceSession` gives it. */
  connection: DeviceConnection;
  /** The URL the field starts with: the local bridge's by default. */
  defaultUrl?: string;
  /** How the bridge client connects. */
  options?: WebSocketBridgeOptions;
}

/**
 * A device connection over its open local bridge: the bridge's URL to
 * connect to, and where the connection stands.
 */
export function WebSocketConnectionBar({
  connection,
  defaultUrl = LOCAL_BRIDGE_URL,
  options,
}: WebSocketConnectionBarProps) {
  const [url, setUrl] = useState(defaultUrl);
  const fieldId = useId();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const at = url.trim();
    connection.connect(() => WebSocketBridge.connect(at, options), at);
  };
  return (
    <form className="be-connection" aria-label="Device connection" onSubmit={submit}>
      <ConnectionStatus connection={connection} />
      {!isLive(connection.state) && (
        <>
          <label className="be-inline" htmlFor={fieldId}>
            Device&apos;s bridge
          </label>
          <input
            id={fieldId}
            type="text"
            inputMode="url"
            spellCheck={false}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            size={26}
          />
          <button type="submit" className="be-primary" disabled={!url.trim()}>
            Connect
          </button>
        </>
      )}
    </form>
  );
}
