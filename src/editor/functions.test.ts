import { beforeAll, describe, expect, it } from "vitest";
import { loadLanguage } from "../../fixtures/language";
import { DATAFLOW_FUNCTIONS } from "../../fixtures/local-arora";
import type { BehaviorText } from "../text/language";
import { functionIndex, missingFunctions } from "./functions";

let language: BehaviorText;
beforeAll(async () => {
  language = await loadLanguage();
});

const missing = (text: string, functions = DATAFLOW_FUNCTIONS) =>
  missingFunctions(language.parse(text).document, functionIndex(language.natives(), functions));

describe("missingFunctions", () => {
  it("names each function called and not offered once, nested calls included, in file order", () => {
    expect(missing("sequence\n  nope(x: multiply(operand_0: gone(), operand_1: 1f32))\n  nope(x: 2)\n")).toEqual([
      "nope",
      "gone",
    ]);
    expect(missing("sequence\n  equal(a: true, b: true)\n")).toEqual([]);
  });

  it("takes a name two modules offer as ambiguous, not missing", () => {
    const other = DATAFLOW_FUNCTIONS.map((f) => ({ ...f, module_id: "another-module" }));
    expect(missing("add(operand_0: 1f32, operand_1: 2f32)\n", [...DATAFLOW_FUNCTIONS, ...other])).toEqual([]);
    expect(missing("elsewhere::add(operand_0: 1f32, operand_1: 2f32)\n", [...DATAFLOW_FUNCTIONS, ...other])).toEqual([
      "elsewhere::add",
    ]);
  });
});
