import { type FormEvent, StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { EXAMPLES } from "../fixtures/examples";
import { DATAFLOW_INPUTS } from "../fixtures/devices/dataflow";
import dataflow from "../fixtures/devices/dataflow.bt?raw";
import {
  BehaviorEditor,
  type BehaviorExample,
  type BehaviorText,
  DeviceRuntime,
  LOCAL_BRIDGE_URL,
  MATH_MODULE_ID,
  MockArora,
  WebSocketDevice,
  createBehaviorText,
  whenIdle,
} from "../src";
import "../src/styles.css";
import initDataflowDevice, { DataflowDevice } from "../device/pkg/dataflow_device.js";
import initBehaviorText, * as behaviorText from "../wasm/pkg/behavior_text.js";

const DEVICE = "D";

/**
 * The NGBT spectrum's examples, each on a mock device seeded as the spectrum
 * seeds it, and a behavior calling `@arora/dataflow` on an Arora device
 * (`device/`), its inputs seeded.
 */
function examples(language: BehaviorText): BehaviorExample[] {
  const mocked: BehaviorExample[] = EXAMPLES.map((e) => ({
    title: e.title,
    fileName: e.file,
    text: e.text,
    plotKeys: e.plot,
    runtime: () => ({ runtime: new MockArora({ store: e.store }) }),
  }));
  const onDevice: BehaviorExample = {
    title: "Dataflow, on an Arora device",
    fileName: "dataflow.bt",
    text: dataflow,
    plotKeys: ["face/level", "rig/sway", "face/smile"],
    runtime: () => {
      const device = new DataflowDevice(DEVICE, JSON.stringify(DATAFLOW_INPUTS));
      device.update(
        JSON.stringify({ "sensor/distance": { f32: 0.3 }, "face/smile_target": { f32: 1 } }),
      );
      const runtime = new DeviceRuntime({
        device,
        deviceId: DEVICE,
        loadCall: (graph) => language.loadCall(graph),
        editCall: (diff) => language.editCall(diff),
      });
      return { runtime, dispose: () => device.free() };
    },
  };
  return [...mocked, onDevice];
}

/** A device the demo is connected to, over its open local bridge. */
interface Connected {
  device: WebSocketDevice;
  runtime: DeviceRuntime;
}

/**
 * The editor, on the mock until the person connects it to a device: then
 * every file but an example runs on that device.
 */
function Demo({ language, offered }: { language: BehaviorText; offered: BehaviorExample[] }) {
  const [connected, setConnected] = useState<Connected | null>(null);
  const [asking, setAsking] = useState(false);
  const [url, setUrl] = useState(LOCAL_BRIDGE_URL);
  const [connecting, setConnecting] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  /** Counts the connections asked for: one cancelled, or asked again, is let go as it opens. */
  const attempts = useRef(0);
  /** A connection the person let go of, closed once the editor stopped the behavior on it. */
  const [releasing, setReleasing] = useState<Connected | null>(null);
  /**
   * Settles once the connection let go of last is closed: the bridge serves
   * one client, so a new connection would take its place before the editor
   * stopped the behavior on it.
   */
  const released = useRef<Promise<void>>(Promise.resolve());
  /** Settles once the last attempt to connect has, its connection closed if let go of meanwhile. */
  const settled = useRef<Promise<unknown>>(Promise.resolve());
  // This runs after the editor queued the stop of the behavior on the device,
  // in the same commit: the connection closes once that ran.
  useEffect(() => {
    if (!releasing) return;
    released.current = whenIdle(releasing.runtime).then(() => releasing.device.close());
  }, [releasing]);

  // A connection the device closes, or that another client takes, says why.
  useEffect(() => {
    if (!connected) return undefined;
    let current = true;
    connected.device.closed.then((reason) => {
      if (!current) return;
      setConnected(null);
      setProblem(reason);
    });
    return () => {
      current = false;
    };
  }, [connected]);

  const connect = (event: FormEvent) => {
    event.preventDefault();
    const attempt = ++attempts.current;
    setConnecting(true);
    setProblem(null);
    // One attempt at a time: a cancelled one still opening would otherwise
    // take the bridge's one client slot from this one.
    const opening = Promise.all([released.current, settled.current]).then(() =>
      attempts.current === attempt ? WebSocketDevice.connect(url) : null,
    );
    settled.current = opening
      .then(async (device) => {
        if (device && attempts.current !== attempt) {
          device.close();
          await device.closed;
        }
      })
      .catch(() => undefined);
    opening
      .then((device) => {
        if (!device || attempts.current !== attempt) return;
        const runtime = new DeviceRuntime({
          device,
          loadCall: (graph) => language.loadCall(graph),
          editCall: (diff) => language.editCall(diff),
        });
        setConnected({ device, runtime });
        setAsking(false);
      })
      .catch((e: unknown) => {
        if (attempts.current === attempt) setProblem(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (attempts.current === attempt) setConnecting(false);
      });
  };
  const cancel = () => {
    attempts.current += 1;
    setConnecting(false);
    setAsking(false);
  };
  const disconnect = () => {
    setReleasing(connected);
    setConnected(null);
  };

  return (
    <div style={{ maxWidth: 1600, margin: "0 auto" }}>
      <div
        className="be-root"
        style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}
      >
        {connected ? (
          <>
            <span role="status">{`Connected to the device at ${connected.device.url}`}</span>
            <button type="button" onClick={disconnect}>
              Disconnect
            </button>
          </>
        ) : asking ? (
          <form onSubmit={connect} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <label className="be-inline">
              Device&apos;s bridge
              <input
                type="text"
                inputMode="url"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                size={28}
              />
            </label>
            <button type="submit" className="be-primary" disabled={connecting}>
              {connecting ? "Connecting…" : "Connect"}
            </button>
            <button type="button" onClick={cancel}>
              Cancel
            </button>
          </form>
        ) : (
          <button type="button" onClick={() => setAsking(true)}>
            Connect to a device…
          </button>
        )}
        {problem && (
          <span className="be-problem" role="alert">
            {problem}
          </span>
        )}
      </div>
      <BehaviorEditor
        language={language}
        runtime={connected?.runtime}
        examples={offered}
        moduleNames={{ [MATH_MODULE_ID]: "math" }}
      />
    </div>
  );
}

await Promise.all([initBehaviorText(), initDataflowDevice()]);
const language = createBehaviorText(behaviorText);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Demo language={language} offered={examples(language)} />
  </StrictMode>,
);
