// @vitest-environment jsdom
import "../../fixtures/dom";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ORDER } from "../../fixtures/examples";
import { loadLanguage } from "../../fixtures/language";
import { loadDevice } from "../../fixtures/local-arora";
import { createLocalArora } from "../local-arora/local-arora";
import type { DeviceSession } from "../session/device-session";
import { useLocalArora } from "./use-local-arora";

afterEach(() => cleanup());

describe("useLocalArora", () => {
  it("keeps the local Arora while the start flag changes, and lets it go as it unmounts", async () => {
    const [device, language] = await Promise.all([loadDevice(), loadLanguage()]);
    const made: DeviceSession[] = [];
    const create = () => {
      const session = createLocalArora(device, language, {
        inputs: ORDER.inputs,
        values: ORDER.values,
        playing: false,
      });
      made.push(session);
      return session;
    };
    const { result, rerender, unmount } = renderHook(
      ({ atStart }) => useLocalArora(create, atStart),
      { initialProps: { atStart: false } },
    );
    expect(result.current.session).toBeNull();
    act(() => result.current.start!());
    const started = result.current.session;
    expect(started).not.toBeNull();

    rerender({ atStart: true });
    expect(result.current.session).toBe(started);
    rerender({ atStart: false });
    expect(result.current.session).toBe(started);
    expect(made).toHaveLength(1);
    expect(started!.state.status).not.toBe("closed");

    unmount();
    expect(started!.state.status).toBe("closed");
  });

  it("offers no start without a local Arora to make", () => {
    const { result } = renderHook(() => useLocalArora(undefined, true));
    expect(result.current.start).toBeUndefined();
    expect(result.current.session).toBeNull();
  });
});
