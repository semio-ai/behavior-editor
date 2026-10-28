import { describe, expect, it } from "vitest";
import { EXAMPLES } from "../../fixtures/examples";
import { MATH_FUNCTIONS, loadLanguage } from "../../fixtures/language";

describe("the examples' text", () => {
  it.each(EXAMPLES.map((e) => [e.file, e] as const))(
    "%s parses, formats as written, and resolves against the mock device",
    async (_, example) => {
      const language = await loadLanguage();
      const parsed = language.parse(example.text);
      expect(parsed.diagnostics).toEqual([]);
      expect(language.format(parsed, MATH_FUNCTIONS)).toBe(example.text);
      const loaded = language.resolve(parsed.document, MATH_FUNCTIONS);
      expect(loaded.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(loaded.nodes.map((n) => [n.name, n.path, n.attached])).toEqual(
        example.loaded.nodes.map((n) => [n.name, n.path, n.attached]),
      );
    },
  );
});
