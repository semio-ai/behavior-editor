import { StrictMode, useCallback } from "react";
import { createRoot } from "react-dom/client";
import { EXAMPLES, INPUTS, VALUES } from "../fixtures/examples";
import {
  BehaviorEditor,
  type BehaviorExample,
  type BehaviorText,
  createBehaviorText,
  useDeviceSession,
} from "../src";
import { DATAFLOW_MODULE_ID, createLocalArora } from "../src/local-arora";
import { WebSocketConnectionBar } from "../src/websocket";
import "../src/styles.css";
import initDevice, * as device from "../device/pkg/dataflow_device.js";
import initBehaviorText, * as behaviorText from "../wasm/pkg/behavior_text.js";

const EXAMPLE_FILES: BehaviorExample[] = EXAMPLES.map((e) => ({
  title: e.title,
  fileName: e.file,
  text: e.text,
  plotKeys: e.plot,
}));

/**
 * The editor on a local Arora, started with the page and seeded with every
 * example's inputs, so the examples run at once; or on a device the person
 * connects to over its open local bridge. Disconnected, the editor is back on
 * the local Arora, as it was left.
 */
function Demo({ language }: { language: BehaviorText }) {
  const connection = useDeviceSession({ language });
  const localArora = useCallback(
    () => createLocalArora(device, language, { inputs: INPUTS, values: VALUES }),
    [language],
  );
  return (
    <div style={{ maxWidth: 1600, margin: "0 auto" }}>
      <div
        className="be-root"
        style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}
      >
        <WebSocketConnectionBar connection={connection} />
      </div>
      <BehaviorEditor
        language={language}
        session={connection.session}
        localArora={localArora}
        startLocalArora
        examples={EXAMPLE_FILES}
        moduleNames={{ [DATAFLOW_MODULE_ID]: "dataflow" }}
      />
    </div>
  );
}

await Promise.all([initBehaviorText(), initDevice()]);
const language = createBehaviorText(behaviorText);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Demo language={language} />
  </StrictMode>,
);
