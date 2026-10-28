import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { EXAMPLES } from "../fixtures/examples";
import dataflow from "../fixtures/devices/dataflow.bt?raw";
import {
  BehaviorEditor,
  type BehaviorRuntime,
  type BehaviorText,
  DeviceRuntime,
  MATH_MODULE_ID,
  MockArora,
  createBehaviorText,
} from "../src";
import "../src/styles.css";
import initBehaviorText, * as behaviorText from "../wasm/pkg/behavior_text.js";

/** An example the demo opens: its file, and the runtime it runs on. */
interface DemoExample {
  id: string;
  title: string;
  file: string;
  text: string;
  plot: string[];
  /** A runtime for it, and how to let it go. */
  runtime(): { runtime: BehaviorRuntime; dispose(): void };
}

const DEVICE = "D";

/**
 * The NGBT spectrum's examples, each on a mock device seeded as the spectrum
 * seeds it; and, when `@semio/studio-arora`'s wasm build is present, a
 * behavior calling `@arora/dataflow` on an emulated device of Studio's World.
 */
async function examples(language: BehaviorText): Promise<DemoExample[]> {
  const mocked: DemoExample[] = EXAMPLES.map((e) => ({
    ...e,
    runtime: () => ({ runtime: new MockArora({ store: e.store }), dispose: () => {} }),
  }));
  const studioArora = await import("@semio/studio-arora")
    .then(async (module) => {
      await module.default();
      return module;
    })
    .catch(() => null);
  if (!studioArora) return mocked;
  const device: DemoExample = {
    id: "dataflow",
    title: "Dataflow, on an emulated device",
    file: "dataflow.bt",
    text: dataflow,
    plot: ["face/level", "rig/sway", "face/smile"],
    runtime: () => {
      const world = new studioArora.StudioAroraWorld();
      world.spawnEntity("E", "[]");
      world.attachEmulated("E", DEVICE);
      for (const key of ["sensor/distance", "face/smile_target"]) {
        world.setMeta(DEVICE, key, JSON.stringify({ ty: "f32", editable: true }));
      }
      world.update(DEVICE, JSON.stringify({ "sensor/distance": { f32: 0.3 } }));
      world.update(DEVICE, JSON.stringify({ "face/smile_target": { f32: 1 } }));
      const runtime = new DeviceRuntime({
        device: {
          describeMethods: (prefix) => world.describeMethods(DEVICE, prefix),
          call: (callJson) => world.call(DEVICE, callJson),
          update: (changesJson) => world.update(DEVICE, changesJson),
          read: (key) => world.read(key),
          listKeys: (prefix) => world.listKeys(DEVICE, prefix),
          step: (dtMs) => world.step(dtMs),
        },
        deviceId: DEVICE,
        loadCall: (graph) => language.loadCall(graph),
      });
      return { runtime, dispose: () => world.free() };
    },
  };
  return [...mocked, device];
}

function Demo({ language, all }: { language: BehaviorText; all: DemoExample[] }) {
  const [id, setId] = useState(all[0]!.id);
  const example = all.find((e) => e.id === id)!;
  // The runtime of the example shown: made when it opens, let go when it closes.
  const [held, setHeld] = useState<{ id: string; runtime: BehaviorRuntime } | null>(null);
  useEffect(() => {
    const created = example.runtime();
    setHeld({ id: example.id, runtime: created.runtime });
    return () => created.dispose();
  }, [example]);
  return (
    <div className="be-root" style={{ maxWidth: 1600, margin: "0 auto" }}>
      <label className="be-inline" style={{ fontSize: 13 }}>
        Example
        <select value={id} onChange={(event) => setId(event.target.value)}>
          {all.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title}
            </option>
          ))}
        </select>
      </label>
      {held?.id === example.id && (
        <BehaviorEditor
          key={example.id}
          language={language}
          runtime={held.runtime}
          defaultText={example.text}
          fileName={example.file}
          moduleNames={{ [MATH_MODULE_ID]: "math" }}
          plotKeys={example.plot}
        />
      )}
    </div>
  );
}

await initBehaviorText();
const language = createBehaviorText(behaviorText);
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Demo language={language} all={await examples(language)} />
  </StrictMode>,
);
