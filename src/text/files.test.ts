import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { EXAMPLES, GREET, SMILE } from "../../fixtures/examples";
import { GROOT_TEST_FUNCTIONS } from "../../fixtures/files/functions";
import { MATH_FUNCTIONS, loadLanguage } from "../../fixtures/language";
import type { Graph } from "../model/graph";
import type { MethodSignature } from "../model/signature";
import type { BehaviorText, FileOutcome, GraphFileFormat, Loaded } from "./language";

const files = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures", "files");

let language: BehaviorText;
beforeAll(async () => {
  language = await loadLanguage();
});

/** `graph` with its nodes in id order: their order means nothing to an interpreter. */
const sorted = (graph: Graph): Graph => ({
  ...graph,
  nodes: [...(graph.nodes ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
});

const resolved = (text: string, functions: MethodSignature[] = MATH_FUNCTIONS): Loaded => {
  const loaded = language.resolve(language.parse(text).document, functions);
  expect(loaded.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return loaded;
};

const textOf = (outcome: FileOutcome): string => {
  if ("problems" in outcome) throw new Error(JSON.stringify(outcome.problems));
  return outcome.text;
};

/** `text` written in `format`, opened again, and resolved. */
function roundTrip(text: string, format: GraphFileFormat, functions = MATH_FUNCTIONS) {
  const before = resolved(text, functions);
  const file = textOf(language.writeFile(before, format, functions));
  const after = resolved(textOf(language.openFile(file, format, functions)), functions);
  return { before, file, after };
}

/** A behavior Groot holds: a tree alone, its bindings values and keys. */
const TREE = [
  "sequence",
  "  sequence_star",
  "    truthy(x: {person/visible})",
  '    set_string(variable: {face/mood}, value: "near")',
  "  {rig/arm_raise} = damp(target: 1, half_life: 0.12, state: none, initial: {rig/arm_raise})",
  "  wait(seconds: 2, now: {arora/time}, since: none)",
  "",
].join("\n");

describe("a behavior file in another form than the text", () => {
  it.each(["json", "yaml"] as const)("reads back from a readable graph in %s as the same graph, every example", (format) => {
    for (const example of EXAMPLES) {
      const { before, file, after } = roundTrip(example.text, format);
      expect(sorted(after.graph), example.file).toEqual(sorted(before.graph));
      // References by name: no port is written by its id.
      expect(file).not.toMatch(/5f726574-0000-4000-8000-000000000000/);
    }
  });

  it("keeps a node's name, and writes a node the text names not by its path", () => {
    const { file, after } = roundTrip(GREET.text, "yaml");
    expect(file).toContain("- id: fresh\n");
    expect(file).toContain("root: root\n");
    expect(file).toContain("x:\n      port:\n        node: fresh\n        port: _ret\n");
    expect(after.nodes.find((n) => n.name === "fresh")).toBeTruthy();
  });

  it("reads back from Groot as the same graph", () => {
    const { before, file, after } = roundTrip(TREE, "groot");
    expect(file).toContain("<SequenceStar");
    expect(file).toContain('half_life="0.12f64"');
    expect(sorted(after.graph)).toEqual(sorted(before.graph));
  });

  it("refuses Groot for what it cannot hold, naming it", () => {
    const outcome = language.writeFile(resolved(GREET.text), "groot", MATH_FUNCTIONS);
    expect("problems" in outcome && outcome.problems.map((p) => p.message)).toEqual([
      // A call in an argument is a node of its own, which reads into its caller.
      "Groot holds no node outside the tree: `root.0.2.1.a`, `fresh`",
      "Groot has no form for a port reading another node, as `root.0.1`'s `x` does",
      "Groot has no form for a port reading another node, as `root.0.2.1`'s `a` does",
    ]);
    const named = language.writeFile(resolved(`watch: ${TREE}`), "groot", MATH_FUNCTIONS);
    expect("problems" in named && named.problems.map((p) => p.message)).toEqual([
      "Groot keeps no node name: `watch`",
    ]);
  });

  it("answers a YAML file too deep to open again as a problem, not an exception", () => {
    const depth = 126;
    const text = `running\n\nx: equal(a: ${"some(".repeat(depth)}1f64${")".repeat(depth)}, b: 1f64)\n`;
    const outcome = language.writeFile(resolved(text), "yaml", MATH_FUNCTIONS);
    expect("problems" in outcome && outcome.problems[0]!.message).toMatch(/recursion limit/);
    expect("text" in language.writeFile(resolved(text), "json", MATH_FUNCTIONS)).toBe(true);
  });

  it("says why a file does not load, and where", () => {
    const json = language.openFile('{"root": "a",\n "nodes": [{"id": "a", "function": 1}]}', "json", []);
    expect(json).toEqual({
      problems: [expect.objectContaining({ line: 2, message: expect.stringMatching(/JSON/) })],
    });
    const yaml = "root: near\nnodes:\n- id: near\n  function: lt\n  bind:\n    low: {value: {f64: 1.0}}\n";
    expect(language.openFile(yaml, "yaml", MATH_FUNCTIONS)).toEqual({
      problems: [{ at: "nodes[0].bind.low", message: "`lt` has no parameter `low`" }],
    });
    const groot = language.openFile("<root>\n<BehaviorTree>\n<Fly/>\n</BehaviorTree>\n</root>", "groot", []);
    expect("problems" in groot && groot.problems[0]!.message).toMatch(/Fly/);
  });
});

describe("the files of fixtures/files", () => {
  const open = async (name: string, format: GraphFileFormat, functions: MethodSignature[]) =>
    textOf(language.openFile(await readFile(join(files, name), "utf8"), format, functions));

  it("opens a readable graph in JSON as its text", async () => {
    const text = await open("greet.json", "json", MATH_FUNCTIONS);
    expect(sorted(resolved(text).graph)).toEqual(sorted(resolved(GREET.text).graph));
  });

  it("opens a readable graph in YAML as its text", async () => {
    const text = await open("smile.yaml", "yaml", MATH_FUNCTIONS);
    expect(sorted(resolved(text).graph)).toEqual(sorted(resolved(SMILE.text).graph));
  });

  it("opens a Groot tree, its module function's attributes typed", async () => {
    const text = await open("cosine_tree.groot.xml", "groot", GROOT_TEST_FUNCTIONS);
    expect(text).toBe(
      "sequence\n  increase(storage: {angle}, delta: 0.1f32)\n  cos(angle: {angle}, res: {cos})\n",
    );
    resolved(text, GROOT_TEST_FUNCTIONS);
  });

  it("opens a Groot tree whose unconnected port is an empty attribute, leaving it unbound", async () => {
    const text = await open("cosine_tree_groot_edited.groot.xml", "groot", GROOT_TEST_FUNCTIONS);
    expect(text).toBe(
      "sequence\n  increase(storage: {angle}, delta: 0.1f32)\n  sequence_star\n    cos(angle: {angle})\n",
    );
    resolved(text, GROOT_TEST_FUNCTIONS);
  });
});
