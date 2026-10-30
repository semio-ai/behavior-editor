import { beforeAll, describe, expect, it } from "vitest";
import { MATH_FUNCTIONS, loadLanguage } from "../../fixtures/language";
import type { BehaviorText } from "../text/language";
import { functionIndex, missingFunctions } from "./functions";

let language: BehaviorText;
beforeAll(async () => {
  language = await loadLanguage();
});

const missing = (text: string, functions = MATH_FUNCTIONS) =>
  missingFunctions(language.parse(text).document, functionIndex(language.natives(), functions));

describe("missingFunctions", () => {
  it("names each function called and not offered once, nested calls included, in file order", () => {
    expect(missing("sequence\n  nope(x: mul(a: gone(), b: 1))\n  nope(x: 2)\n")).toEqual([
      "nope",
      "gone",
    ]);
    expect(missing("sequence\n  truthy(x: true)\n")).toEqual([]);
  });

  it("takes a name two modules offer as ambiguous, not missing", () => {
    const other = MATH_FUNCTIONS.map((f) => ({ ...f, module_id: "another-module" }));
    expect(missing("add(a: 1, b: 2)\n", [...MATH_FUNCTIONS, ...other])).toEqual([]);
    expect(missing("elsewhere::add(a: 1, b: 2)\n", [...MATH_FUNCTIONS, ...other])).toEqual([
      "elsewhere::add",
    ]);
  });
});
