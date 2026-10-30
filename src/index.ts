export { BehaviorEditor, type BehaviorEditorProps } from "./editor/BehaviorEditor";

export type { BehaviorText, Diagnostic, Loaded, LoadedNode, ParseResult } from "./text/language";
export { createBehaviorText, type BehaviorTextExports } from "./text/wasm-language";
export type {
  Argument,
  BehaviorDocument,
  Call,
  Comment,
  Expression,
  ExpressionKind,
  FunctionName,
  Name,
  SourceNode,
  Span,
} from "./text/ast";
export type { Graph, GraphNode, Io, Link, LinkSource, Port, TypeRef } from "./model/graph";
export type {
  FrozenReference,
  FrozenTy,
  FunctionSignature,
  MethodSignature,
  Parameter,
  PrimitiveKind,
} from "./model/signature";
export type { StructureField, Value } from "./model/value";

export type { BehaviorRuntime, DetachedActivity, Status, TickReport } from "./runtime/runtime";
export {
  MockArora,
  TIME_KEY,
  type CallResult,
  type MockAroraOptions,
  type MockFunction,
  type MockModule,
} from "./runtime/mock-arora";
export { MATH_MODULE_ID } from "./runtime/math-module";
export {
  DeviceRuntime,
  type AroraDevice,
  type DeviceRuntimeOptions,
} from "./runtime/device-runtime";
