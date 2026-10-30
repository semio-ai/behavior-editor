import { describe, expect, it } from "vitest";
import { EXAMPLES } from "../../fixtures/examples";
import { loadLanguage } from "../../fixtures/language";
import { DATAFLOW_FUNCTIONS } from "../../fixtures/local-arora";

describe("the examples' text", () => {
  it.each(EXAMPLES.map((e) => [e.file, e] as const))(
    "%s parses, formats as written, and resolves against @arora/dataflow's functions",
    async (_, example) => {
      const language = await loadLanguage();
      const parsed = language.parse(example.text);
      expect(parsed.diagnostics).toEqual([]);
      expect(language.format(parsed, DATAFLOW_FUNCTIONS)).toBe(example.text);
      const loaded = language.resolve(parsed.document, DATAFLOW_FUNCTIONS);
      expect(loaded.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    },
  );
});

describe("a 64-bit literal", () => {
  it("past what a JavaScript number holds exactly is an error, not a rounded value", async () => {
    const language = await loadLanguage();
    const resolve = (text: string) =>
      language
        .resolve(language.parse(text).document, DATAFLOW_FUNCTIONS)
        .diagnostics.filter((d) => d.severity === "error");
    const literals = [
      "9007199254740993u64",
      "u64[1, 9007199254740993]",
      "-9007199254740993i64",
      "u64[1, 9007199254740993][1]",
    ];
    for (const literal of literals) {
      const errors = resolve(`running\n\nx: add(operand_0: ${literal})\n`);
      expect(errors.map((d) => [d.span.line, d.message])).toEqual([
        [3, expect.stringContaining("cannot hold exactly")],
      ]);
    }
    expect(resolve("running\n\nx: add(operand_0: 9007199254740991u64)\n")).toEqual([]);
  });
});
