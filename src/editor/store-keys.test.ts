import { beforeAll, describe, expect, it } from "vitest";
import { GREET, SMILE } from "../../fixtures/examples";
import { MATH_FUNCTIONS, loadLanguage } from "../../fixtures/language";
import type { BehaviorText } from "../text/language";
import { functionIndex } from "./functions";
import { outputKeys } from "./store-keys";

let language: BehaviorText;
beforeAll(async () => {
  language = await loadLanguage();
});

const outputs = (text: string) => {
  const loaded = language.resolve(language.parse(text).document, MATH_FUNCTIONS);
  return outputKeys(loaded.graph, functionIndex(language.natives(), MATH_FUNCTIONS));
};

describe("the store's output keys", () => {
  it("are the runtime's own and the keys the behavior writes without reading them", () => {
    const isOutput = outputs(SMILE.text);
    expect(["arora/time", "arora/dt", "rig/mouth_corner", "rig/cheek_raise"].map(isOutput)).toEqual(
      [true, true, true, true],
    );
    expect(isOutput("face/smile")).toBe(false);
  });

  it("leave a key the behavior also reads an input", () => {
    const isOutput = outputs(GREET.text);
    // `social/greeted` is set by the greeting and read by `fresh`: a person resets it.
    expect(isOutput("social/greeted")).toBe(false);
    expect(isOutput("person/visible")).toBe(false);
  });

  it("count a key a native writes, such as set_string's variable", () => {
    const isOutput = outputs('sequence\n  set_string(variable: {face/mood}, value: "near")\n');
    expect(isOutput("face/mood")).toBe(true);
  });
});
