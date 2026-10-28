/**
 * A function a device exposes, as its `describeMethods` lists it: the serde
 * JSON of `arora_bridge::MethodSignature`. Native nodes are described alike.
 */
export interface MethodSignature {
  /** The module that exports the function: the `module_id` a call targets. */
  module_id: string;
  /** The function's id: the `id` a call targets. */
  id: string;
  name: string;
  function: FunctionSignature;
}

/** A frozen function record: `arora_types::record::module::frozen::Function`. */
export interface FunctionSignature {
  /** The parameters, by id. */
  parameters: Record<string, Parameter>;
  /** The parameter ids in declared order. */
  parameterOrdering: string[];
  returnType: FrozenTy;
}

export interface Parameter {
  name: string;
  type: FrozenTy;
  /** Whether the function writes the argument back: the node's state, or an output. */
  mutable: boolean;
}

/** A frozen type expression: `arora_types::record::ty::FrozenTy`. */
export type FrozenTy =
  | { type: "primitive"; value: { kind: PrimitiveKind } }
  | { type: "frozenScalar"; value: { reference: FrozenReference } }
  | { type: "frozenArray"; value: { reference: FrozenReference } }
  | { type: "frozenOption"; value: { element: FrozenTy } };

/** A record pinned to a version. */
export interface FrozenReference {
  id: string;
  version: string;
}

export type PrimitiveKind =
  | "unit"
  | "boolean"
  | "u8"
  | "u16"
  | "u32"
  | "u64"
  | "i8"
  | "i16"
  | "i32"
  | "i64"
  | "f32"
  | "f64"
  | "string"
  | "arrayBoolean"
  | "arrayU8"
  | "arrayU16"
  | "arrayU32"
  | "arrayU64"
  | "arrayI8"
  | "arrayI16"
  | "arrayI32"
  | "arrayI64"
  | "arrayF32"
  | "arrayF64"
  | "arrayString";

/** The parameters of `signature` in declared order, each with its id. */
export function orderedParameters(
  signature: FunctionSignature,
): { id: string; parameter: Parameter }[] {
  return signature.parameterOrdering.flatMap((id) => {
    const parameter = signature.parameters[id];
    return parameter ? [{ id, parameter }] : [];
  });
}

/** The primitive kind of `ty`, when it is a primitive. */
export function primitiveKind(ty: FrozenTy): PrimitiveKind | undefined {
  return ty.type === "primitive" ? ty.value.kind : undefined;
}

/** `ty` as a short text: `f64`, `option<bool>`, `[f64]`, `record 325a5767…`. */
export function formatType(ty: FrozenTy): string {
  switch (ty.type) {
    case "primitive":
      return ty.value.kind.startsWith("array")
        ? `[${ty.value.kind.slice(5).toLowerCase()}]`
        : ty.value.kind;
    case "frozenOption":
      return `option<${formatType(ty.value.element)}>`;
    case "frozenArray":
      return `[record ${ty.value.reference.id.slice(0, 8)}…]`;
    case "frozenScalar":
      return `record ${ty.value.reference.id.slice(0, 8)}…`;
  }
}
