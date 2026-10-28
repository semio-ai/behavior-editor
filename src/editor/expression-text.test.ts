import { describe, expect, it } from "vitest";
import { variableText } from "./expression-text";

describe("variableText", () => {
  it("writes a key bare when it reads back as itself, and quoted otherwise", () => {
    expect(variableText("face/smile")).toBe("{face/smile}");
    expect(variableText(".mood")).toBe("{.mood}");
    expect(variableText("a key")).toBe('{"a key"}');
    expect(variableText("")).toBe('{""}');
    expect(variableText("=x")).toBe('{"=x"}');
    expect(variableText('say "hi"')).toBe('{"say \\"hi\\""}');
    expect(variableText("5f726574-0000-4000-8000-000000000000")).toBe(
      '{"5f726574-0000-4000-8000-000000000000"}',
    );
  });
});
