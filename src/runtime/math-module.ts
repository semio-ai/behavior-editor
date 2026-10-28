import type { FrozenTy, MethodSignature, PrimitiveKind } from "../model/signature";
import { type Value, valueBoolean, valueNumber } from "../model/value";
import type { CallResult, MockFunction, MockModule } from "./mock-arora";
import { STATUS_ENUMERATION, STATUS_RUNNING, STATUS_SUCCESS } from "./natives";

/**
 * The mock device's math module: the operations of the NGBT spectrum's
 * examples, as module functions a behavior calls. Numbers are `f64`.
 *
 * | function | returns |
 * |---|---|
 * | `add(a, b)`, `mul(a, b)` | the sum, the product |
 * | `clamp(x, min?, max?)` | `x` within the bounds given |
 * | `remap(x, in_min, in_max, out_min, out_max)` | `x` mapped linearly |
 * | `lt(a, b)` | `a < b` |
 * | `not(x)` | `!x` |
 * | `osc(t, frequency)` | `sin(2π · frequency · t)`, `t` in seconds |
 * | `damp(target, half_life, state, initial?)` | `state` eased one 1/30 s step toward `target`, and written back; from `initial`, or else `target`, when absent |
 * | `number(x)`, `boolean(x)` | `x`: a value to write to a key |
 * | `wait(seconds, now, since)` | Running until `seconds` have passed since `since`, which it sets at its first tick and clears when it succeeds |
 */
export const MATH_MODULE_ID = "77a83264-60a2-467c-9292-092cc08f051a";

/** The function ids, and each function's parameter ids by name. */
export const MATH = {
  add: {
    id: "0980a4fb-f244-4418-8dad-4769d6abd61f",
    a: "aca709f7-de40-445d-b70f-2668a07751a0",
    b: "953c94c9-51ae-45f8-ae93-2d261d0fd7dd",
  },
  mul: {
    id: "9e13f357-a393-4467-94f8-6f4d59f31847",
    a: "0949c51e-a64d-48dc-8d74-03df5743a4a3",
    b: "e03a1de0-7482-42c5-b964-b7ea9e4e08b3",
  },
  clamp: {
    id: "237f75b8-accb-49ef-b4b2-5f67b88f5a6a",
    x: "0108755b-d924-4797-8d36-cae855046019",
    min: "1639665f-f46f-4012-aa35-be5a76a8c6b3",
    max: "de7de5db-2b50-4c67-aa85-ea14e98fba88",
  },
  remap: {
    id: "0406ea4b-5e31-4502-a277-2211994328c9",
    x: "ae0f747b-47d3-476c-9de7-4f83d46ea226",
    in_min: "a0e5558d-65b3-4c64-8057-600ef8b17a19",
    in_max: "bced5bd6-fe62-4079-9169-617b095a4db9",
    out_min: "96d15d93-e10e-4b11-95db-935e8fcf7ee6",
    out_max: "cea07974-0ce9-4fe2-aad2-1cb209cdaebb",
  },
  lt: {
    id: "ab66b65e-1b4d-47f1-97fd-a6787d749b5c",
    a: "3f70f3a1-3175-49dd-9238-25d31a293cec",
    b: "e9295d00-bcce-4c60-80f6-7c0c8359d785",
  },
  not: { id: "2de0a3c4-1753-47d2-825c-b6a87e8fc423", x: "35c3e6b4-5753-4fd4-82fc-5dd9fbf1ef94" },
  osc: {
    id: "9eeb64aa-0dd8-427e-acc1-8f9091c6337b",
    t: "8c0fa32d-35b1-4c47-9128-c2bf32d78af8",
    frequency: "76b94d5d-d499-41aa-a081-81e06b311a16",
  },
  damp: {
    id: "6b1c3151-028a-4a3a-8d50-399ea282d178",
    target: "5261f2a1-cf5d-4e9d-909e-2f6a8e35c1bd",
    half_life: "117dee0e-7c74-45ef-9204-ec668e2945e8",
    state: "5a406a4b-237f-4ce9-afff-0c34bc61494f",
    initial: "dd905236-76c2-4647-bc1c-cb23fcf316b0",
  },
  number: { id: "cc908913-db81-4005-8c7d-1a14dddd160d", x: "da6b84e4-8fc3-46d4-9344-918256b518e0" },
  boolean: {
    id: "fceca348-b738-432e-b41c-79a7b4884cbf",
    x: "c8b12b5d-0be8-420f-9575-4563deb77368",
  },
  wait: {
    id: "2d3612fc-331c-40f2-b82b-4373c191db29",
    seconds: "bb8e4052-a0a6-41e9-890b-ca61d9d52e32",
    now: "f0d47a02-224f-4720-9bad-15a27fe6faf2",
    since: "2be59968-c699-4f7f-a8d3-f853cf62d38c",
  },
} as const;

/** The time one `damp` call advances its state by, in seconds. */
const DAMP_STEP = 1 / 30;

const primitive = (kind: PrimitiveKind): FrozenTy => ({ type: "primitive", value: { kind } });
const F64 = primitive("f64");
const BOOL = primitive("boolean");
const OPTIONAL_F64: FrozenTy = { type: "frozenOption", value: { element: F64 } };
const STATUS: FrozenTy = {
  type: "frozenScalar",
  value: { reference: { id: STATUS_ENUMERATION, version: "1.0.0" } },
};

type Ids = (typeof MATH)[keyof typeof MATH];
type Arguments = (name: string) => Value | undefined;

/** One function: its parameters in order, by name, with their types. */
function define(
  name: keyof typeof MATH,
  parameters: [string, FrozenTy, boolean?][],
  returnType: FrozenTy,
  run: (arg: Arguments) => CallResult,
): MockFunction {
  const ids = MATH[name] as Ids & Record<string, string>;
  const signature: MethodSignature = {
    module_id: MATH_MODULE_ID,
    id: ids.id,
    name,
    function: {
      parameters: Object.fromEntries(
        parameters.map(([param, type, mutable]) => [
          ids[param]!,
          { name: param, type, mutable: mutable ?? false },
        ]),
      ),
      parameterOrdering: parameters.map(([param]) => ids[param]!),
      returnType,
    },
  };
  return {
    signature,
    call: (args) => run((param) => args.get(ids[param]!)),
  };
}

function num(arg: Arguments, name: string): number {
  const n = valueNumber(arg(name));
  if (n === undefined) throw new Error(`${name} is not a number: ${JSON.stringify(arg(name))}`);
  return n;
}

/** The number in an optional argument, `undefined` when absent. */
function optional(arg: Arguments, name: string): number | undefined {
  const value = arg(name);
  if (value == null || value === "unit" || !("option" in value) || value.option === null) {
    return undefined;
  }
  return valueNumber(value.option);
}

function bool(arg: Arguments, name: string): boolean {
  const b = valueBoolean(arg(name));
  if (b === undefined) throw new Error(`${name} is not a boolean: ${JSON.stringify(arg(name))}`);
  return b;
}

const f64 = (n: number): CallResult => ({ ret: { f64: n }, mutated: [] });
const boolean = (b: boolean): CallResult => ({ ret: { bool: b }, mutated: [] });
const status = (variant: string): Value => ({
  enum: { id: STATUS_ENUMERATION, variant_id: variant, value: "unit" },
});

/** The math module, its functions answering in process. */
export function mathModule(): MockModule {
  return {
    id: MATH_MODULE_ID,
    functions: [
      define(
        "add",
        [
          ["a", F64],
          ["b", F64],
        ],
        F64,
        (arg) => f64(num(arg, "a") + num(arg, "b")),
      ),
      define(
        "mul",
        [
          ["a", F64],
          ["b", F64],
        ],
        F64,
        (arg) => f64(num(arg, "a") * num(arg, "b")),
      ),
      define(
        "clamp",
        [
          ["x", F64],
          ["min", OPTIONAL_F64],
          ["max", OPTIONAL_F64],
        ],
        F64,
        (arg) => {
          const min = optional(arg, "min") ?? -Infinity;
          const max = optional(arg, "max") ?? Infinity;
          return f64(Math.min(max, Math.max(min, num(arg, "x"))));
        },
      ),
      define(
        "remap",
        [
          ["x", F64],
          ["in_min", F64],
          ["in_max", F64],
          ["out_min", F64],
          ["out_max", F64],
        ],
        F64,
        (arg) => {
          const [x, a, b, c, d] = ["x", "in_min", "in_max", "out_min", "out_max"].map((p) =>
            num(arg, p),
          ) as [number, number, number, number, number];
          return f64(c + ((x - a) * (d - c)) / (b - a));
        },
      ),
      define(
        "lt",
        [
          ["a", F64],
          ["b", F64],
        ],
        BOOL,
        (arg) => boolean(num(arg, "a") < num(arg, "b")),
      ),
      define("not", [["x", BOOL]], BOOL, (arg) => boolean(!bool(arg, "x"))),
      define(
        "osc",
        [
          ["t", F64],
          ["frequency", F64],
        ],
        F64,
        (arg) => f64(Math.sin(2 * Math.PI * num(arg, "frequency") * num(arg, "t"))),
      ),
      define(
        "damp",
        [
          ["target", F64],
          ["half_life", F64],
          ["state", OPTIONAL_F64, true],
          ["initial", OPTIONAL_F64],
        ],
        F64,
        (arg) => {
          const target = num(arg, "target");
          const from = optional(arg, "state") ?? optional(arg, "initial") ?? target;
          let next = from + (target - from) * (1 - Math.pow(2, -DAMP_STEP / num(arg, "half_life")));
          if (Math.abs(target - next) < 1e-4) next = target;
          return {
            ret: { f64: next },
            mutated: [{ id: MATH.damp.state, value: { option: { f64: next } } }],
          };
        },
      ),
      define("number", [["x", F64]], F64, (arg) => f64(num(arg, "x"))),
      define("boolean", [["x", BOOL]], BOOL, (arg) => boolean(bool(arg, "x"))),
      define(
        "wait",
        [
          ["seconds", F64],
          ["now", F64],
          ["since", OPTIONAL_F64, true],
        ],
        STATUS,
        (arg) => {
          const now = num(arg, "now");
          const since = optional(arg, "since") ?? now;
          const done = now - since >= num(arg, "seconds") - 1e-9;
          return {
            ret: status(done ? STATUS_SUCCESS : STATUS_RUNNING),
            mutated: [{ id: MATH.wait.since, value: { option: done ? null : { f64: since } } }],
          };
        },
      ),
    ],
  };
}
