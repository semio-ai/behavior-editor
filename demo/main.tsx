import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EXAMPLES } from "../fixtures/examples";
import { DATAFLOW_INPUTS } from "../fixtures/devices/dataflow";
import dataflow from "../fixtures/devices/dataflow.bt?raw";
import { PageBridge } from "../fixtures/page-bridge";
import {
  BehaviorEditor,
  type BehaviorExample,
  type BehaviorText,
  DeviceRuntime,
  MATH_MODULE_ID,
  MockArora,
  createBehaviorText,
  useDeviceSession,
} from "../src";
import { WebSocketConnectionBar } from "../src/websocket";
import "../src/styles.css";
import initDataflowDevice, { DataflowDevice } from "../device/pkg/dataflow_device.js";
import initBehaviorText, * as behaviorText from "../wasm/pkg/behavior_text.js";

const DEVICE = "D";
const PAGE_DEVICE = "P";

/**
 * The NGBT spectrum's examples, which call the mock's math module, each on a
 * mock device seeded as the spectrum seeds it; and a behavior calling
 * `@arora/dataflow`, on an Arora device in the page (`device/`), its inputs
 * seeded. Connected to a device, every example works on that device: the
 * dataflow one runs on a device carrying `@arora/dataflow`.
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
    title: "Dataflow (@arora/dataflow)",
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
        trace: language,
      });
      return { runtime, dispose: () => device.free() };
    },
  };
  return [...mocked, onDevice];
}

/**
 * The editor, on the mock until the person connects it to a device: over a
 * device's open local bridge, by URL, or to an Arora device in the page, a
 * bridge the host makes itself. Every file, examples included, then works on
 * that device.
 */
function Demo({ language, offered }: { language: BehaviorText; offered: BehaviorExample[] }) {
  const connection = useDeviceSession({ language });
  const inPage = () => {
    const device = new DataflowDevice(PAGE_DEVICE, JSON.stringify(DATAFLOW_INPUTS));
    const bridge = new PageBridge(device, { namespace: PAGE_DEVICE });
    // The device goes with its connection.
    void bridge.closed.then(() => device.free());
    connection.connect(bridge, "the Arora device in this page");
  };
  return (
    <div style={{ maxWidth: 1600, margin: "0 auto" }}>
      <div
        className="be-root"
        style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}
      >
        <WebSocketConnectionBar connection={connection} />
        {connection.state?.status !== "connected" && (
          <button type="button" onClick={inPage}>
            Use an Arora device in this page
          </button>
        )}
      </div>
      <BehaviorEditor
        language={language}
        session={connection.session}
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
