import type { Value } from "../model/value";
import type { Status } from "./runtime";

/**
 * The ids `arora-behavior-tree` ticks natively, and the `Status` enumeration a
 * module function returns, as `crates/arora-behavior-tree/src/nodes.rs`,
 * `schema.rs` and `arora-behavior`'s `status.rs` define them.
 */

/** The parameter a node's return value is bound through: "_ret" in ASCII. */
export const RET = "5f726574-0000-4000-8000-000000000000";

export const SUCCEED = "6696f0bd-e781-40cd-aeb5-8dc616f810d2";
export const FAIL = "3abbbfb6-d00d-41eb-88bb-97874267eaf6";
export const RUNNING = "41ae5ed0-1d12-4b71-aab8-02e7efedf177";

export const SEQUENCE = "32246df6-ab5d-4f18-9221-23e28731de93";
export const SEQUENCE_STAR = "c2d5ed72-798c-4174-94f7-13378bd9bf1f";
export const SEQUENCE_STAR_INDEX = "4de502df-3f48-4541-94d8-dd68fe92bc8e";
export const FALLBACK = "bfa89a4e-c369-430e-be78-0dc07311391c";
export const PARALLEL = "a9340289-1f30-411f-9faa-0f07d54613e8";

export const EQUAL = "a67583f5-7b1f-4081-a210-b710bd41d88a";
export const EQUAL_A = "75664d78-aa45-44a7-b1fc-0ab220b933ee";
export const EQUAL_B = "9399b82f-7ace-41fc-8732-38a42a800698";

export const UNPACK = "72d3c388-9fe0-4fe9-9b04-38f9e92d6c78";
export const UNPACK_VALUES = "aa7e72c3-f979-4e94-b11f-f69014ace7cd";
/** `out_0`; `out_i` adds `i` to its last byte. */
const UNPACK_OUT_BASE = "ae061284-22e5-4149-909a-e74a02524800";
export const UNPACK_PORTS = 64;

export const SCATTER = "eb0a42a1-6596-46f7-83c3-990632bfff94";
export const SCATTER_VALUES = "40940dc9-27ce-41b2-be54-4203665eda66";
export const SCATTER_KEYS = "4056190c-ced0-4547-90c3-26d6a93c30b4";
export const SCATTER_WITHIN = "4d773cff-49a7-4b2f-88c8-c6af05f96673";

export const SET_STRING = "c803889f-4757-4b56-908f-4b2b47041eff";
export const SET_STRING_VARIABLE = "8fa2f965-1eb5-40d9-baca-8facef0d31a8";
export const SET_STRING_VALUE = "88438955-7872-44ad-8464-d636dc5fe26f";
export const UNSET_STRING = "7dce01ed-9818-4b7d-b45a-2e7fdece3633";
export const UNSET_STRING_VARIABLE = "2c84bf0f-4ec2-41a4-83ee-3f92a53be79d";
export const IS_STRING_SET = "20ba3f0f-309e-4cd2-adfc-aca6cc432526";
export const IS_STRING_SET_VALUE = "c4f1e72d-30fe-400b-a584-f08e93944026";
export const WAIT_STRING_SET = "3180977c-25a1-458e-ab82-11f36c654518";
export const WAIT_STRING_SET_VALUE = "8f190079-e519-44d3-ac36-3bfc322e87eb";
export const REGEX_MATCH = "8e3dbcc1-1a81-4cf6-a457-6e0c075456fd";
export const REGEX_MATCH_VALUE = "3267f093-8a7f-4b77-b74c-3bd2e7ad40f9";
export const REGEX_MATCH_MATCHER = "6702e02d-f6ba-4c5d-acab-9ade0a690afa";
export const REGEX_MATCH_FIRST_MATCH = "e8b71df7-2bb5-4498-8bc3-833c5bc8eadc";

/** The task-run scaffolding a spawned run is made of. */
export const RUN_CALL = "5d2e8a41-0b67-4c25-913f-6ed82b94a710";
export const RUN_STATUS = "1e84d06a-932c-4571-b64d-180a73c59236";

/** The `Status` enumeration and its variants. */
export const STATUS_ENUMERATION = "325a5767-e344-4532-860e-0749bcf2e428";
export const STATUS_SUCCESS = "766e9e9a-446d-4e46-83e6-14b7ca101169";
export const STATUS_FAILURE = "2468f46c-bb60-425c-9a4d-9ad326ccc7e2";
export const STATUS_RUNNING = "acd79ec6-0c44-401a-82f8-5da5422d3eec";

/** The id of `out_i`, the `i`th output port of `unpack`. */
export function unpackOut(i: number): string {
  return UNPACK_OUT_BASE.slice(0, -2) + i.toString(16).padStart(2, "0");
}

/** The index `i` of `param` when it is `unpack`'s `out_i`. */
export function unpackOutIndex(param: string): number | undefined {
  if (!param.startsWith(UNPACK_OUT_BASE.slice(0, -2))) return undefined;
  const i = parseInt(param.slice(-2), 16);
  return i < UNPACK_PORTS ? i : undefined;
}

/** The control nodes: they tick their children. */
export const CONTROL_NODES: ReadonlySet<string> = new Set([
  SEQUENCE,
  SEQUENCE_STAR,
  FALLBACK,
  PARALLEL,
]);

/** Every function the tree ticks without a module. */
export const NATIVE_FUNCTIONS: ReadonlySet<string> = new Set([
  SUCCEED,
  FAIL,
  RUNNING,
  SEQUENCE,
  SEQUENCE_STAR,
  FALLBACK,
  PARALLEL,
  EQUAL,
  UNPACK,
  SCATTER,
  SET_STRING,
  UNSET_STRING,
  IS_STRING_SET,
  WAIT_STRING_SET,
  REGEX_MATCH,
  RUN_CALL,
  RUN_STATUS,
]);

/** The status a `Status` value holds; `undefined` for any other value. */
export function statusOf(value: Value | null | undefined): Status | undefined {
  if (value == null || value === "unit" || !("enum" in value)) return undefined;
  if (value.enum.id !== STATUS_ENUMERATION) return undefined;
  switch (value.enum.variant_id) {
    case STATUS_SUCCESS:
      return "S";
    case STATUS_FAILURE:
      return "F";
    case STATUS_RUNNING:
      return "R";
    default:
      return undefined;
  }
}
