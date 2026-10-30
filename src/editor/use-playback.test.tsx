// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ORDER } from "../../fixtures/examples";
import type { Graph, GraphDiff } from "../model/graph";
import { MockArora } from "../runtime/mock-arora";
import { usePlayback } from "./use-playback";

/** The diff of two graphs as the editor sees it: none between the same graph. */
const diff = (a: Graph, b: Graph): GraphDiff =>
  JSON.stringify(a) === JSON.stringify(b) ? {} : { remove: [] };

describe("usePlayback", () => {
  it("shows the store a tick states whole as it is, a key it leaves out gone", async () => {
    const runtime = new MockArora({ store: { ...ORDER.store, stale: { f64: 1 } } });
    runtime.step = () =>
      Promise.resolve({ tick: 1, whole: true, changes: [{ key: "v", value: { f64: 7 } }] });
    const { result } = renderHook(() => usePlayback(runtime, ORDER.loaded, false, diff));
    await waitFor(() => expect(result.current.store.get("stale")).toEqual({ f64: 1 }));
    await waitFor(() => expect(result.current.report).toBeNull());
    await new Promise((resolve) => setTimeout(resolve, 50));
    act(() => result.current.step());
    await waitFor(() => expect(result.current.store.get("v")).toEqual({ f64: 7 }));
    expect(result.current.store.has("stale")).toBe(false);
  });
});
