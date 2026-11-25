import { StrictMode, useCallback, useEffect, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { EXAMPLES, INPUTS, VALUES } from "../fixtures/examples";
import {
  BehaviorEditor,
  type BehaviorExample,
  type BehaviorText,
  createBehaviorText,
  formatNamed,
  useDeviceSession,
} from "../src";
import { DATAFLOW_MODULE_ID, createLocalArora } from "../src/local-arora";
import { LOCAL_BRIDGE_URL, WebSocketBridge, WebSocketConnectionBar } from "../src/websocket";
import "../src/styles.css";
import initDevice, * as device from "../device/pkg/dataflow_device.js";
import initBehaviorText, * as behaviorText from "../wasm/pkg/behavior_text.js";
import { type Startup, hostFiles, setUnsaved, startup } from "./host";

const EXAMPLE_FILES: BehaviorExample[] = EXAMPLES.map((e) => ({
  title: e.title,
  fileName: e.file,
  text: e.text,
  plotKeys: e.plot,
}));

/**
 * The editor as a desktop app: the person's files through native dialogs,
 * a local Arora, and a device connected to over its open local bridge, the
 * one the command line names as the app starts.
 */
function App({ language, start }: { language: BehaviorText; start: Startup }) {
  const connection = useDeviceSession({ language });
  const { connect } = connection;
  const localArora = useCallback(
    () => createLocalArora(device, language, { inputs: INPUTS, values: VALUES }),
    [language],
  );
  useEffect(() => {
    const url = start.device;
    if (url) connect(() => WebSocketBridge.connect(url), url);
  }, [connect, start.device]);
  const initialFile = useMemo(
    () =>
      start.file && {
        name: start.file.name,
        format: formatNamed(start.file.name),
        handle: start.file.path,
        text: start.file.text,
      },
    [start.file],
  );
  return (
    <>
      <div
        className="be-root"
        style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}
      >
        <WebSocketConnectionBar connection={connection} defaultUrl={start.device ?? LOCAL_BRIDGE_URL} />
      </div>
      <BehaviorEditor
        language={language}
        session={connection.session}
        localArora={localArora}
        // A device to connect to is where the file runs: no local Arora competes with it.
        startLocalArora={!start.device}
        examples={EXAMPLE_FILES}
        moduleNames={{ [DATAFLOW_MODULE_ID]: "dataflow" }}
        plotKeys={start.plot}
        fileAccess={hostFiles}
        initialFile={initialFile ?? undefined}
        onDirtyChange={setUnsaved}
      />
    </>
  );
}

// The webview's reload keys (F5, Ctrl+R; WebView2 keeps them on) would reload
// the page over changes not saved, without the window's close asking first:
// an app's window has no use for them.
window.addEventListener(
  "keydown",
  (event) => {
    const key = event.key.toLowerCase();
    if (key === "f5" || ((event.ctrlKey || event.metaKey) && key === "r")) event.preventDefault();
  },
  { capture: true },
);

const root = createRoot(document.getElementById("root")!);
try {
  const [start] = await Promise.all([startup(), initBehaviorText(), initDevice()]);
  root.render(
    <StrictMode>
      <App language={createBehaviorText(behaviorText)} start={start} />
    </StrictMode>,
  );
} catch (error) {
  root.render(
    <p className="be-root be-alert" role="alert">
      {error instanceof Error ? error.message : String(error)}
    </p>,
  );
}
