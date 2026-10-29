import type { FileProblem, GraphFileFormat } from "../text/language";

/** The forms a behavior file takes: the text, a readable graph, or a Groot tree. */
export type FileFormat = "bt" | GraphFileFormat;

export interface FormatInfo {
  format: FileFormat;
  /** What a person picks it by. */
  label: string;
  /** Its extensions, the first the one a file is saved with. */
  extensions: readonly string[];
  mime: string;
}

/**
 * Every format a behavior is opened from and saved to. Which to use where is
 * `arora-behavior-tree`'s `docs/text.md` rule: the text to write and read
 * behaviors, a readable graph for files people review and for tools.
 */
export const FILE_FORMATS: readonly FormatInfo[] = [
  { format: "bt", label: "Behavior text (.bt)", extensions: [".bt"], mime: "text/plain" },
  { format: "json", label: "Graph, JSON", extensions: [".json"], mime: "application/json" },
  { format: "yaml", label: "Graph, YAML", extensions: [".yaml", ".yml"], mime: "application/yaml" },
  { format: "groot", label: "Groot XML", extensions: [".xml"], mime: "application/xml" },
];

const info = (format: FileFormat) => FILE_FORMATS.find((f) => f.format === format)!;

/** The format a file's name says it is in; `null` for a name no format has. */
export function formatOf(name: string): FileFormat | null {
  const lower = name.toLowerCase();
  return FILE_FORMATS.find((f) => f.extensions.some((e) => lower.endsWith(e)))?.format ?? null;
}

/** `name` with the extension of `format` in place of its own. */
export function withExtension(name: string, format: FileFormat): string {
  const own = formatOf(name);
  const base = own
    ? name.slice(0, name.length - info(own).extensions.find((e) => name.toLowerCase().endsWith(e))!.length)
    : name.replace(/\.[^./]*$/, "");
  return `${base || "behavior"}${info(format).extensions[0]}`;
}

export function labelOf(format: FileFormat): string {
  return info(format).label;
}

export function mimeOf(format: FileFormat): string {
  return info(format).mime;
}

export function extensionsOf(format: FileFormat): readonly string[] {
  return info(format).extensions;
}

/** The problems a file operation met, each with its place, as one message. */
export function problemsText(problems: readonly FileProblem[]): string {
  return problems
    .map((p) => {
      const place =
        p.line !== undefined
          ? `line ${p.line}${p.column !== undefined ? `, column ${p.column}` : ""}: `
          : p.at !== undefined
            ? `${p.at}: `
            : "";
      return `${place}${p.message}`;
    })
    .join("; ");
}
