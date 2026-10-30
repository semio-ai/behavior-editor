// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { type FunctionSource, useRuntimeFunctions } from "./use-functions";

afterEach(() => {
  cleanup();
});

describe("useRuntimeFunctions", () => {
  it("asks again when told, keeping what was said until the answer", async () => {
    const answers: (() => Promise<{ name: string }[]>)[] = [
      () => Promise.reject(new Error("the connection to the device is lost")),
      () => Promise.resolve([{ name: "damp" }]),
    ];
    const source = { functions: () => answers.shift()!() } as unknown as FunctionSource;
    const { result, rerender } = renderHook(({ asked }) => useRuntimeFunctions(source, asked), {
      initialProps: { asked: 0 },
    });
    await waitFor(() => expect(result.current.error).toMatch(/lost/));
    rerender({ asked: 1 });
    expect(result.current.known).toBe(true);
    await waitFor(() => expect(result.current.functions.map((f) => f.name)).toEqual(["damp"]));
    expect(result.current.error).toBeNull();
  });

  it("knows nothing a source switched away from said", async () => {
    let answer: (functions: { name: string }[]) => void = () => {};
    const first = {
      functions: () => new Promise((resolve) => (answer = resolve)),
    } as unknown as FunctionSource;
    const second = { functions: () => Promise.resolve([{ name: "add" }]) } as unknown as FunctionSource;
    const { result, rerender } = renderHook(({ source }) => useRuntimeFunctions(source), {
      initialProps: { source: first },
    });
    rerender({ source: second });
    answer([{ name: "damp" }]);
    await waitFor(() => expect(result.current.functions.map((f) => f.name)).toEqual(["add"]));
    expect(result.current.known).toBe(true);
  });
});
