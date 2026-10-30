export { BehaviorEditor, type BehaviorEditorProps } from "./editor/BehaviorEditor";
export { whenIdle } from "./editor/use-playback";
export type { BehaviorExample } from "./editor/StartScreen";

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
  followed,
  type AroraDevice,
  type DeviceAnswer,
  type DeviceRuntimeOptions,
  type FollowedBehavior,
} from "./runtime/device-runtime";
export { parseExact } from "./runtime/exact-json";

export type {
  BridgeClient,
  BridgeClosure,
  BridgeKey,
  Call as AroraCall,
  CallResult as AroraCallResult,
  KeyMeta,
} from "./bridge/bridge-client";
export { BridgeDevice } from "./bridge/bridge-device";
export {
  DeviceSession,
  DT_KEY,
  REVISION_KEY,
  type Backoff,
  type BehaviorChange,
  type DeviceBehavior,
  type DeviceSessionOptions,
  type DeviceStatus,
  type SessionEvents,
  type SessionLanguage,
  type SessionState,
  type SessionTick,
} from "./session/device-session";
export {
  useDeviceSession,
  useSessionState,
  type DeviceConnection,
} from "./session/use-device-session";
export { ConnectionStatus } from "./session/ConnectionStatus";
