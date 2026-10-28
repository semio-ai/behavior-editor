/**
 * A test double of the language service, over the examples' fixtures. It
 * parses no language: it knows the examples' texts, and the documents and
 * graphs written out for them, and nothing else.
 *
 * - `parse` answers an example's text with its document. Any other text is
 *   read as the double's own encoding of a document, the JSON its `format`
 *   writes; anything else is an error.
 * - `format` writes an example's document back as its text, and any other
 *   document as JSON.
 * - `resolve` answers an example's document with its graph, and any other
 *   document with an error and no graph.
 */
import type { FrozenTy, MethodSignature } from "../src/model/signature";
import * as N from "../src/runtime/natives";
import type { BehaviorDocument } from "../src/text/ast";
import type { BehaviorText, Loaded } from "../src/text/language";
import { EXAMPLES, type Example } from "./examples";

/** The module id the double gives the natives. */
export const NATIVE_MODULE = "00000000-0000-0000-0000-000000000000";

const ANY: FrozenTy = {
  type: "frozenScalar",
  value: { reference: { id: "00000000-0000-0000-0000-00000000001a", version: "1.0.0" } },
};
const OPTIONAL_STRING: FrozenTy = {
  type: "frozenOption",
  value: { element: { type: "primitive", value: { kind: "string" } } },
};
const STATUS: FrozenTy = {
  type: "frozenScalar",
  value: { reference: { id: N.STATUS_ENUMERATION, version: "1.0.0" } },
};

function native(
  name: string,
  id: string,
  params: [string, string, FrozenTy, boolean?][] = [],
): MethodSignature {
  return {
    module_id: NATIVE_MODULE,
    id,
    name,
    function: {
      parameters: Object.fromEntries(
        params.map(([param, pid, type, mutable]) => [
          pid,
          { name: param, type, mutable: mutable ?? false },
        ]),
      ),
      parameterOrdering: params.map(([, pid]) => pid),
      returnType: STATUS,
    },
  };
}

/** The natives as the double describes them. */
export const NATIVES: MethodSignature[] = [
  native("sequence", N.SEQUENCE),
  native("sequence_star", N.SEQUENCE_STAR),
  native("fallback", N.FALLBACK),
  native("parallel", N.PARALLEL),
  native("succeed", N.SUCCEED),
  native("fail", N.FAIL),
  native("running", N.RUNNING),
  native("equal", N.EQUAL, [
    ["a", N.EQUAL_A, ANY],
    ["b", N.EQUAL_B, ANY],
  ]),
  native("set_string", N.SET_STRING, [
    ["variable", N.SET_STRING_VARIABLE, OPTIONAL_STRING, true],
    ["value", N.SET_STRING_VALUE, OPTIONAL_STRING],
  ]),
  native("is_string_set", N.IS_STRING_SET, [["value", N.IS_STRING_SET_VALUE, OPTIONAL_STRING]]),
];

const same = (a: BehaviorDocument, b: BehaviorDocument) => JSON.stringify(a) === JSON.stringify(b);

const NO_SPAN = { start: 0, end: 0, line: 1, column: 1 };

export function fixtureLanguage(examples: readonly Example[] = EXAMPLES): BehaviorText {
  return {
    parse(text) {
      const example = examples.find((e) => e.text === text);
      if (example) return { document: example.document, diagnostics: [] };
      if (text.trim() === "") return { document: { nodes: [], comments: [] }, diagnostics: [] };
      try {
        return { document: JSON.parse(text) as BehaviorDocument, diagnostics: [] };
      } catch {
        return {
          document: { nodes: [], comments: [] },
          diagnostics: [
            {
              severity: "error",
              message: "the fixture language knows no such text",
              span: NO_SPAN,
            },
          ],
        };
      }
    },
    format(document) {
      return (
        examples.find((e) => same(e.document, document))?.text ?? JSON.stringify(document, null, 2)
      );
    },
    resolve(document): Loaded {
      const example = examples.find((e) => same(e.document, document));
      if (example) return example.loaded;
      return {
        graph: { nodes: {}, links: [], variables: {} },
        nodes: [],
        diagnostics: document.nodes.length
          ? [
              {
                severity: "error",
                message: "the fixture language resolves only its examples",
                span: NO_SPAN,
              },
            ]
          : [],
      };
    },
    natives: () => NATIVES,
    spawnGraphCall: (graph) => JSON.stringify({ spawn_graph: graph }),
  };
}
