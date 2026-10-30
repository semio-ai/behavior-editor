/**
 * An arora `Value` in its serde JSON form: externally tagged, `{ "f64": 1.5 }`,
 * with the unit value as the bare string `"unit"`. This is the form values take
 * across every boundary of the package — the graph's literals, a device's store,
 * a runtime's reports.
 */
export type Value =
  | "unit"
  | { bool: boolean }
  | { u8: number }
  | { u16: number }
  | { u32: number }
  | { u64: number }
  | { i8: number }
  | { i16: number }
  | { i32: number }
  | { i64: number }
  | { f32: number }
  | { f64: number }
  | { str: string }
  | { option: Value | null }
  | { struct: { id: string; fields: StructureField[] } }
  | { enum: { id: string; variant_id: string; value: Value } }
  | { bools: boolean[] }
  | { u8s: number[] }
  | { u16s: number[] }
  | { u32s: number[] }
  | { u64s: number[] }
  | { i8s: number[] }
  | { i16s: number[] }
  | { i32s: number[] }
  | { i64s: number[] }
  | { f32s: number[] }
  | { f64s: number[] }
  | { strs: string[] }
  | { values: Value[] }
  | { structs: { id: string; elements: { fields: StructureField[] }[] } }
  | { enums: { id: string; elements: { variant_id: string; value: Value }[] } }
  | { keyvalue: unknown }
  | { uuid: string };

/** One field of a structure: its id and its value. */
export interface StructureField {
  id: string;
  value: Value;
}

/** The tags of the scalar numeric variants. */
export type NumericTag =
  | "u8"
  | "u16"
  | "u32"
  | "u64"
  | "i8"
  | "i16"
  | "i32"
  | "i64"
  | "f32"
  | "f64";

const NUMERIC_TAGS: readonly NumericTag[] = [
  "u8",
  "u16",
  "u32",
  "u64",
  "i8",
  "i16",
  "i32",
  "i64",
  "f32",
  "f64",
];

/** The tag of `value`: its variant's serde name. */
export function valueTag(value: Value): string {
  return value === "unit" ? "unit" : Object.keys(value)[0]!;
}

/** The numeric tag of `value`, when it is a scalar number. */
export function numericTag(value: Value): NumericTag | undefined {
  const tag = valueTag(value);
  return NUMERIC_TAGS.find((t) => t === tag);
}

/** The number a scalar numeric value holds. */
export function valueNumber(value: Value | null | undefined): number | undefined {
  if (value == null) return undefined;
  const tag = numericTag(value);
  return tag ? (value as Record<NumericTag, number>)[tag] : undefined;
}

/** The boolean a `bool` value holds. */
export function valueBoolean(value: Value | null | undefined): boolean | undefined {
  return value != null && value !== "unit" && "bool" in value ? value.bool : undefined;
}

/** The string a `str` value holds. */
export function valueString(value: Value | null | undefined): string | undefined {
  return value != null && value !== "unit" && "str" in value ? value.str : undefined;
}

/** `n` as a scalar of the numeric variant `tag`. */
export function numberValue(tag: NumericTag, n: number): Value {
  return { [tag]: n } as Value;
}

/**
 * Whether two values are equal as Rust compares them: the same variant and the
 * same contents, so `{u32: 1}` and `{u64: 1}` differ, and NaN equals nothing.
 */
export function valueEquals(a: Value | null | undefined, b: Value | null | undefined): boolean {
  if (a == null || b == null) return a == null && b == null;
  return deepEqual(a, b);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      Object.hasOwn(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/**
 * Whether every 64-bit integer in `value` is one a JavaScript number holds
 * exactly, within ±(2^53 − 1). Decoding JSON rounds a larger one, so a value
 * read with one is not the value that was written.
 */
export function holdsExactly(value: Value): boolean {
  if (value === "unit") return true;
  if ("i64" in value) return Number.isSafeInteger(value.i64);
  if ("u64" in value) return Number.isSafeInteger(value.u64);
  if ("i64s" in value) return value.i64s.every((n) => Number.isSafeInteger(n));
  if ("u64s" in value) return value.u64s.every((n) => Number.isSafeInteger(n));
  if ("option" in value) return value.option === null || holdsExactly(value.option);
  if ("values" in value) return value.values.every(holdsExactly);
  if ("struct" in value) return value.struct.fields.every((f) => holdsExactly(f.value));
  if ("enum" in value) return holdsExactly(value.enum.value);
  if ("structs" in value)
    return value.structs.elements.every((e) => e.fields.every((f) => holdsExactly(f.value)));
  if ("enums" in value) return value.enums.elements.every((e) => holdsExactly(e.value));
  return true;
}

/** `value` as a short text for a person: `0.25`, `true`, `"text"`, `none`. */
export function formatValue(value: Value | null | undefined): string {
  if (value == null) return "·";
  if (value === "unit") return "()";
  const n = valueNumber(value);
  if (n !== undefined) return formatNumber(n);
  if ("bool" in value) return value.bool ? "true" : "false";
  if ("str" in value) return JSON.stringify(value.str);
  if ("option" in value)
    return value.option === null ? "none" : `some(${formatValue(value.option)})`;
  if ("uuid" in value) return `uuid(${value.uuid})`;
  if ("enum" in value) return `enum(${value.enum.variant_id.slice(0, 8)}…)`;
  const tag = valueTag(value);
  const contents = (value as Record<string, unknown>)[tag];
  if (Array.isArray(contents)) {
    const items = contents.map((x) =>
      typeof x === "number" ? formatNumber(x) : typeof x === "object" ? "…" : String(x),
    );
    return `${tag.replace(/s$/, "")}[${items.join(", ")}]`;
  }
  return tag;
}

/** A number as the editor shows it: at most three decimals, no trailing zeros. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Math.abs(n) >= 1e6) return n.toExponential(2);
  const fixed = (Math.abs(n) < 5e-4 ? 0 : n).toFixed(3);
  return fixed.replace(/\.?0+$/, "") || "0";
}
