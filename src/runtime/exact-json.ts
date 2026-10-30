/**
 * JSON whose integers past ±(2^53 − 1) keep their digits on their way to
 * Rust: parsed with each number's source text, and written back as that
 * text, where the engine offers both (JSON.parse's source text access and
 * `JSON.rawJSON`); as plain JSON elsewhere. A trace report's watched values
 * travel this way, as the Rust decoder refuses a rounded `u64`.
 */

interface RawJson {
  rawJSON?(text: string): unknown;
}

type Reviver = (key: string, value: unknown, context?: { source?: string }) => unknown;

/** `text` parsed, each integer JavaScript cannot hold kept as its digits. */
export function parseExact(text: string): unknown {
  const { rawJSON } = JSON as unknown as RawJson;
  if (!rawJSON) return JSON.parse(text);
  const reviver: Reviver = (_key, value, context) =>
    typeof value === "number" &&
    !Number.isSafeInteger(value) &&
    context?.source !== undefined &&
    /^-?\d+$/.test(context.source)
      ? rawJSON(context.source)
      : value;
  return JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
}
