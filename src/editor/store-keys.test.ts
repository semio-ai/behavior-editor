import { beforeAll, describe, expect, it } from "vitest";
import { GREET, SMILE } from "../../fixtures/examples";
import { MATH_FUNCTIONS, loadLanguage } from "../../fixtures/language";
import type { BehaviorText } from "../text/language";
import { functionIndex } from "./functions";
import { behaviorKeys } from "./store-keys";

let language: BehaviorText;
beforeAll(async () => {
  language = await loadLanguage();
});

const keysOf = (text: string) => {
  const loaded = language.resolve(language.parse(text).document, MATH_FUNCTIONS);
  return behaviorKeys(loaded, functionIndex(language.natives(), MATH_FUNCTIONS));
};

describe("the keys a behavior reads and writes", () => {
  it("tell a sink's key, published every tick, from what it reads", () => {
    const { reads, writes } = keysOf(SMILE.text);
    expect(Object.fromEntries(writes)).toEqual({
      "rig/mouth_corner": "sink",
      "rig/cheek_raise": "sink",
    });
    expect([...reads]).toEqual(["face/smile"]);
  });

  it("tell a key a tree node writes when it ticks", () => {
    const { reads, writes } = keysOf(GREET.text);
    expect(writes.get("social/greeted")).toBe("leaf");
    expect(writes.get("rig/arm_raise")).toBe("leaf");
    expect(reads.has("social/greeted")).toBe(true);
    expect(reads.has("person/visible")).toBe(true);
    expect(reads.has("arora/time")).toBe(true);
  });

  it("count a key a native writes, such as set_string's variable", () => {
    const { reads, writes } = keysOf(
      'sequence\n  set_string(variable: {face/mood}, value: "near")\n  set_string(variable: {.mood}, value: "x")\n',
    );
    expect(writes.get("face/mood")).toBe("leaf");
    // A tree-local variable is no store key.
    expect([...writes.keys()]).toEqual(["face/mood"]);
    expect(reads.size).toBe(0);
  });
});
