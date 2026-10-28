import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { EXAMPLES } from "../fixtures/examples";
import {
  BehaviorEditor,
  type BehaviorText,
  MATH_MODULE_ID,
  MockArora,
  createBehaviorText,
} from "../src";
import "../src/styles.css";
import initBehaviorText, * as behaviorText from "../wasm/pkg/behavior_text.js";

/**
 * The editor over a mock device, one per example, seeded as the NGBT spectrum
 * seeds it, and the language from the package's wasm build (`npm run
 * build:wasm`).
 */
function Demo({ language }: { language: BehaviorText }) {
  const [id, setId] = useState(EXAMPLES[0]!.id);
  const example = EXAMPLES.find((e) => e.id === id)!;
  const runtime = useMemo(() => new MockArora({ store: example.store }), [example]);
  return (
    <div className="be-root" style={{ maxWidth: 1600, margin: "0 auto" }}>
      <label className="be-inline" style={{ fontSize: 13 }}>
        Example
        <select value={id} onChange={(event) => setId(event.target.value)}>
          {EXAMPLES.map((e) => (
            <option key={e.id} value={e.id}>
              {e.title}
            </option>
          ))}
        </select>
      </label>
      <BehaviorEditor
        key={example.id}
        language={language}
        runtime={runtime}
        defaultText={example.text}
        fileName={example.file}
        moduleNames={{ [MATH_MODULE_ID]: "math" }}
        plotKeys={example.plot}
      />
    </div>
  );
}

await initBehaviorText();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Demo language={createBehaviorText(behaviorText)} />
  </StrictMode>,
);
