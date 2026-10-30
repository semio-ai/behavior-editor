import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EXAMPLES } from "../fixtures/examples";
import { DATAFLOW_INPUTS } from "../fixtures/devices/dataflow";
import dataflow from "../fixtures/devices/dataflow.bt?raw";
import {
  BehaviorEditor,
  type BehaviorExample,
  type BehaviorText,
  DeviceRuntime,
  MATH_MODULE_ID,
  MockArora,
  createBehaviorText,
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

await Promise.all([initBehaviorText(), initDataflowDevice()]);
const language = createBehaviorText(behaviorText);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div style={{ maxWidth: 1600, margin: "0 auto" }}>
      <BehaviorEditor
        language={language}
        examples={examples(language)}
        moduleNames={{ [MATH_MODULE_ID]: "math" }}
      />
    </div>
  </StrictMode>,
);
