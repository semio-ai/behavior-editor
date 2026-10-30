/**
 * The functions `cosine_tree.groot.xml` and `cosine_tree_groot_edited.groot.xml`
 * call, as a device's `describeMethods` lists them: `Increase` and `Cos` of
 * arora-sdk's `test-behavior-tree-nodes` module, under the ids Groot's palette
 * gives them (`crates/arora-behavior-tree/src/nodes.rs`).
 */
import type { FrozenTy, MethodSignature } from "../../src/model/signature";
import { STATUS_ENUMERATION } from "../../src/runtime/natives";

const F32: FrozenTy = { type: "primitive", value: { kind: "f32" } };
const STATUS: FrozenTy = {
  type: "frozenScalar",
  value: { reference: { id: STATUS_ENUMERATION, version: "1.0.0" } },
};
const MODULE = "a7e2b1c4-5d6f-4a8b-9c0d-1e2f3a4b5c6d";

export const GROOT_TEST_FUNCTIONS: MethodSignature[] = [
  {
    module_id: MODULE,
    id: "7f6fc4a9-567c-4f15-87cc-7ca34ae1456f",
    name: "increase",
    function: {
      parameters: {
        "e898fe88-cc61-46d2-aecc-b4fc0beb862f": { name: "storage", type: F32, mutable: true },
        "1018eb85-2d04-4995-a349-b6c83c27f287": { name: "delta", type: F32, mutable: false },
      },
      parameterOrdering: [
        "e898fe88-cc61-46d2-aecc-b4fc0beb862f",
        "1018eb85-2d04-4995-a349-b6c83c27f287",
      ],
      returnType: STATUS,
    },
  },
  {
    module_id: MODULE,
    id: "104b9710-5d43-4a93-944c-d64bddb30ef8",
    name: "cos",
    function: {
      parameters: {
        "272fbafd-c2a5-4ffe-a294-9cabe6e6c1e7": { name: "angle", type: F32, mutable: false },
        "1d101686-05d8-47b4-9292-fdc9e5a0daeb": { name: "res", type: F32, mutable: true },
      },
      parameterOrdering: [
        "272fbafd-c2a5-4ffe-a294-9cabe6e6c1e7",
        "1d101686-05d8-47b4-9292-fdc9e5a0daeb",
      ],
      returnType: STATUS,
    },
  },
];
