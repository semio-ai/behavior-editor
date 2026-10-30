export { BehaviorEditor, type BehaviorEditorProps } from "./editor/BehaviorEditor";

export type {
  BehaviorText,
  Diagnostic,
  FileOutcome,
  FileProblem,
  GraphFileFormat,
  Loaded,
  LoadedNode,
  ParseResult,
} from "./text/language";
export { FILE_FORMATS, type FileFormat, formatOf } from "./editor/file-formats";
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
export type { Binding, Graph, GraphDiff, GraphNode, Port, Source } from "./model/graph";
export { EMPTY_GRAPH } from "./model/graph";
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
