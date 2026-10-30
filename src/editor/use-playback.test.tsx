// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ORDER } from "../../fixtures/examples";
import type { Graph, GraphDiff } from "../model/graph";
import { MockArora } from "../runtime/mock-arora";
import type { BehaviorRuntime } from "../runtime/runtime";
import type { Loaded } from "../text/language";
import { usePlayback } from "./use-playback";

/** The diff of two graphs as the editor sees it: none between the same graph. */
const diff = (a: Graph, b: Graph): GraphDiff =>
  JSON.stringify(a) === JSON.stringify(b) ? {} : { remove: [] };

describe("usePlayback", () => {
  it("tells the runtime of a behavior whose graph stays and whose nodes are named anew", async () => {
    const runtime = new MockArora({ store: ORDER.store });
    const edits: [GraphDiff, Loaded | undefined][] = [];
    const { edit } = runtime;
    const spy: BehaviorRuntime["edit"] = (change, next) => {
      edits.push([change, next]);
      return edit.call(runtime, change);
    };
    Object.assign(runtime, { edit: spy });
    const renamed: Loaded = {
      ...ORDER.loaded,
      nodes: ORDER.loaded.nodes.map((n) => ({ ...n, name: n.name ?? `n${n.path}` })),
    };
    const { rerender } = renderHook(({ loaded }) => usePlayback(runtime, loaded, false, diff), {
      initialProps: { loaded: ORDER.loaded },
    });
    // The same graph, the same nodes: nothing to tell.
    rerender({ loaded: { ...ORDER.loaded } });
    rerender({ loaded: renamed });
    await waitFor(() => expect(edits).toEqual([[{}, renamed]]));
  });

  it("shows the store anew after telling the runtime of nodes named anew", async () => {
    const runtime = new MockArora({ store: ORDER.store });
    const renamed: Loaded = {
      ...ORDER.loaded,
      nodes: ORDER.loaded.nodes.map((n) => ({ ...n, name: n.name ?? `n${n.path}` })),
    };
    const { result, rerender } = renderHook(
      ({ loaded }) => usePlayback(runtime, loaded, false, diff),
      { initialProps: { loaded: ORDER.loaded } },
    );
    await waitFor(() => expect(result.current.store.size).toBeGreaterThan(0));
    // The store changes with no tick the editor sees.
    await runtime.write("outside", { f64: 3 });
    rerender({ loaded: renamed });
    await waitFor(() => expect(result.current.store.get("outside")).toEqual({ f64: 3 }));
  });

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
