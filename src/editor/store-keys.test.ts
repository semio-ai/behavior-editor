import { beforeAll, describe, expect, it } from "vitest";
import { GREET, SMILE } from "../../fixtures/examples";
import { loadLanguage } from "../../fixtures/language";
import { DATAFLOW_FUNCTIONS } from "../../fixtures/local-arora";
import type { BehaviorText } from "../text/language";
import { functionIndex } from "./functions";
import { behaviorKeys } from "./store-keys";

let language: BehaviorText;
beforeAll(async () => {
  language = await loadLanguage();
});

const keysOf = (text: string) => {
  const loaded = language.resolve(language.parse(text).document, DATAFLOW_FUNCTIONS);
  return behaviorKeys(loaded, functionIndex(language.natives(), DATAFLOW_FUNCTIONS));
};

describe("the keys a behavior reads and writes", () => {
  it("tell a sink's key, published every tick, from what it reads", () => {
    const { reads, writes } = keysOf(SMILE.text);
    expect(Object.fromEntries(writes)).toEqual({
      "rig/mouth_corner": "sink",
      "rig/cheek_raise": "sink",
    });
    expect([...reads].sort()).toEqual(["arora/dt", "face/smile"]);
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

  it("count a key read through a selection", () => {
    const { reads } = keysOf("running\n\nx: add(operand_0: {pose}[x], operand_1: 1f32)\n");
    expect([...reads]).toEqual(["pose"]);
  });
});
