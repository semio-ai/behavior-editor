import { describe, expect, it } from "vitest";
import { GREET } from "../../fixtures/examples";
import { RET } from "./natives";
import { TraceView, watchedNodes } from "./trace";

const NODES = new Set(["a", "b", "c"]);

describe("TraceView", () => {
  it("folds each report into the nodes as they stand", () => {
    const view = new TraceView();
    expect(
      view.read({
        tick: 1,
        status: [
          ["a", "running"],
          ["b", "success"],
        ],
        activity: [["c", "called"]],
        values: [{ node: "c", port: RET, value: { f64: 1 } }],
      }),
    ).toBe(true);
    // Only what changed: `b` was not reached, `c` answered from its cache.
    expect(
      view.read({
        tick: 2,
        since: 1,
        status: [["b", "not_reached"]],
        activity: [["c", "cached"]],
      }),
    ).toBe(true);
    expect(view.report("a", NODES)).toEqual({
      root: "R",
      statuses: { a: "R" },
      detached: { c: "cached" },
      values: { c: { f64: 1 } },
    });
  });

  it("reads a report once, and says when one was missed", () => {
    const view = new TraceView();
    view.read({ tick: 1, status: [["a", "success"]] });
    expect(view.read({ tick: 1, status: [["a", "failure"]] })).toBe(true);
    expect(view.report("a", NODES).root).toBe("S");
    expect(view.read({ tick: 5, since: 4, status: [["a", "failure"]] })).toBe(false);
    expect(view.report("a", NODES).root).toBe("S");
  });

  it("starts afresh at a first report", () => {
    const view = new TraceView();
    view.read({ tick: 1, status: [["a", "success"]], activity: [["c", "called"]] });
    view.read({ tick: 9, status: [["b", "running"]] });
    expect(view.report(undefined, NODES)).toEqual({
      statuses: { b: "R" },
      detached: {},
      values: {},
    });
  });

  it("states a restarted node anew, and an unset output as no value", () => {
    const view = new TraceView();
    view.read({
      tick: 1,
      status: [["a", "running"]],
      values: [
        { node: "a", port: RET, value: { f64: 2 } },
        { node: "a", port: "another port", value: { f64: 3 } },
        { node: "b", port: RET, value: { f64: 4 } },
      ],
    });
    view.read({
      tick: 2,
      since: 1,
      restarted: ["a"],
      values: [{ node: "b", port: RET, value: "unit" as never }],
    });
    expect(view.report(undefined, NODES)).toEqual({ statuses: {}, detached: {}, values: {} });
  });

  it("reports the behavior's nodes alone", () => {
    const view = new TraceView();
    view.read({
      tick: 1,
      status: [
        ["a", "running"],
        ["interpreter's own", "running"],
      ],
    });
    expect(view.report(undefined, NODES).statuses).toEqual({ a: "R" });
  });
});

describe("watchedNodes", () => {
  it("watches the nodes the text names and those outside the tree", () => {
    const named = GREET.loaded.nodes.filter((n) => n.name !== null || !n.attached);
    expect(watchedNodes(GREET.loaded)).toEqual(named.map((n) => n.id));
    expect(named.length).toBeGreaterThan(0);
    expect(named.length).toBeLessThan(GREET.loaded.nodes.length);
  });
});
