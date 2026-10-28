import { useEffect, useId, useState } from "react";
import { call, expression, name, withArgument, withoutArgument } from "../model/edit";
import { type FrozenTy, formatType, orderedParameters, primitiveKind } from "../model/signature";
import type { Expression, ExpressionKind } from "../text/ast";
import { expressionText } from "./expression-text";
import type { FunctionIndex } from "./functions";

/** A node other nodes can read: its name and the parameters it writes back. */
export interface Producer {
  name: string;
  /** Its mutable parameters, which `@name.parameter` reads. */
  ports: string[];
}

/** What feeds an argument. */
type Mode = "unset" | "literal" | "key" | "local" | "node" | "call" | "other";

const MODE_LABELS: Record<Mode, string> = {
  unset: "unset",
  literal: "value",
  key: "store key {key}",
  local: "local variable {.name}",
  node: "node @name",
  call: "call",
  other: "as written",
};

function modeOf(value: Expression | undefined): Mode {
  if (!value) return "unset";
  switch (value.kind.type) {
    case "variable":
      return value.kind.name.startsWith(".") ? "local" : "key";
    case "port":
      return "node";
    case "call":
      return "call";
    case "select":
    case "json":
    case "variable_id":
      return "other";
    default:
      return "literal";
  }
}

const NUMBER = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$|^-?(NaN|inf)$/;
const NUMERIC_KINDS = new Set(["u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64", "f32", "f64"]);

const number = (text: string, suffix: string | null = null) =>
  expression({ type: "number", text, suffix });

/** The literal a parameter of type `ty` starts from. */
function defaultLiteral(ty: FrozenTy | undefined): Expression {
  if (ty?.type === "frozenOption") return expression({ type: "none" });
  const kind = ty && primitiveKind(ty);
  if (kind === "boolean") return expression({ type: "bool", value: false });
  if (kind === "string") return expression({ type: "string", value: "" });
  if (kind?.startsWith("array")) return expression({ type: "array", element: null, elements: [] });
  return number("0");
}

export interface ArgumentEditorProps {
  /** The parameter's name: the argument's label. */
  name: string;
  ty: FrozenTy | undefined;
  mutable: boolean;
  value: Expression | undefined;
  /** Set the argument, or clear it with `null`. */
  onChange(value: Expression | null): void;
  producers: readonly Producer[];
  keys: readonly string[];
  index: FunctionIndex;
  /** The modes offered; a return binding takes no literal or call. */
  modes?: readonly Mode[];
}

const ALL_MODES: readonly Mode[] = ["unset", "literal", "key", "local", "node", "call"];

/** One argument: what feeds it, and an editor for that. */
export function ArgumentEditor({
  name: parameter,
  ty,
  mutable,
  value,
  onChange,
  producers,
  keys,
  index,
  modes = ALL_MODES,
}: ArgumentEditorProps) {
  const mode = modeOf(value);
  const offered = mode === "other" ? [...modes, "other" as const] : modes;
  const setMode = (next: Mode) => {
    switch (next) {
      case "unset":
        return onChange(null);
      case "literal":
        return onChange(defaultLiteral(ty));
      case "key":
        return onChange(expression({ type: "variable", name: keys[0] ?? "key" }));
      case "local":
        return onChange(expression({ type: "variable", name: ".local" }));
      case "node":
        return onChange(
          expression({ type: "port", node: name(producers[0]?.name ?? ""), parameter: null }),
        );
      case "call": {
        const first = index.entries.find((e) => !e.native);
        return first ? onChange(expression({ type: "call", call: call(first.name) })) : undefined;
      }
      default:
        return undefined;
    }
  };
  const kind = value?.kind;
  return (
    <fieldset className="be-argument">
      <legend>
        <span className="be-param">{parameter}</span>
        {ty && <span className="be-type">{`${mutable ? "mut " : ""}${formatType(ty)}`}</span>}
      </legend>
      <div className="be-argument-row">
        <select
          aria-label={`${parameter}: source`}
          value={mode}
          onChange={(event) => setMode(event.target.value as Mode)}
        >
          {offered.map((m) => (
            <option key={m} value={m}>
              {MODE_LABELS[m]}
            </option>
          ))}
        </select>
        {value && mode === "literal" && (
          <LiteralEditor name={parameter} ty={ty} value={value} onChange={onChange} />
        )}
        {kind?.type === "variable" && (
          <VariableEditor
            name={parameter}
            value={kind.name}
            local={mode === "local"}
            keys={keys}
            onChange={onChange}
          />
        )}
        {kind?.type === "port" && (
          <NodeRefEditor name={parameter} value={kind} producers={producers} onChange={onChange} />
        )}
        {mode === "other" && value && (
          <code className="be-as-written">{expressionText(value)}</code>
        )}
      </div>
      {kind?.type === "call" && (
        <CallEditor
          value={kind}
          onChange={onChange}
          producers={producers}
          keys={keys}
          index={index}
        />
      )}
    </fieldset>
  );
}

/** A text field that commits on Enter or when it loses focus, keeping what was typed until then. */
function CommitField({
  label,
  value,
  onCommit,
  list,
  invalid,
  className,
}: {
  label: string;
  value: string;
  onCommit(text: string): void;
  list?: string;
  invalid?: (text: string) => boolean;
  className?: string;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const bad = invalid?.(text) ?? false;
  const commit = () => {
    if (!bad && text !== value) onCommit(text);
  };
  return (
    <input
      type="text"
      className={className}
      aria-label={label}
      aria-invalid={bad}
      value={text}
      list={list}
      spellCheck={false}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") commit();
        if (event.key === "Escape") setText(value);
      }}
    />
  );
}

function LiteralEditor({
  name: label,
  ty,
  value,
  onChange,
}: {
  name: string;
  ty: FrozenTy | undefined;
  value: Expression;
  onChange(value: Expression): void;
}) {
  const { kind } = value;
  if (ty?.type === "frozenOption") {
    const present = kind.type !== "none";
    const inner = kind.type === "some" ? kind.value : value;
    return (
      <span className="be-literal">
        <label className="be-check">
          <input
            type="checkbox"
            checked={present}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? defaultLiteral(ty.value.element)
                  : expression({ type: "none" }),
              )
            }
          />
          {`${label} present`}
        </label>
        {present && (
          <LiteralEditor name={label} ty={ty.value.element} value={inner} onChange={onChange} />
        )}
      </span>
    );
  }
  const primitive = ty ? primitiveKind(ty) : undefined;
  if (kind.type === "bool" || primitive === "boolean") {
    return (
      <label className="be-check">
        <input
          type="checkbox"
          checked={kind.type === "bool" && kind.value}
          onChange={(event) => onChange(expression({ type: "bool", value: event.target.checked }))}
        />
        {label}
      </label>
    );
  }
  if (kind.type === "string" || primitive === "string") {
    return (
      <CommitField
        label={label}
        value={kind.type === "string" ? kind.value : ""}
        onCommit={(text) => onChange(expression({ type: "string", value: text }))}
      />
    );
  }
  if (kind.type === "array" || primitive?.startsWith("array")) {
    const numeric = primitive !== "arrayString" && primitive !== "arrayBoolean";
    const elements = kind.type === "array" ? kind.elements : [];
    return (
      <CommitField
        label={`${label}, comma separated`}
        value={elements.map(expressionText).join(", ")}
        invalid={(text) => numeric && splitList(text).some((t) => !NUMBER.test(t))}
        onCommit={(text) =>
          onChange(
            expression({
              type: "array",
              element: kind.type === "array" ? kind.element : null,
              elements: splitList(text).map((t) => listItem(t, primitive)),
            }),
          )
        }
      />
    );
  }
  if (kind.type === "uuid") {
    return (
      <CommitField
        label={label}
        value={kind.value}
        onCommit={(text) => onChange(expression({ type: "uuid", value: text }))}
      />
    );
  }
  if (kind.type === "number" || (primitive !== undefined && NUMERIC_KINDS.has(primitive))) {
    return (
      <CommitField
        label={label}
        className="be-number"
        value={kind.type === "number" ? kind.text : ""}
        invalid={(text) => !NUMBER.test(text.trim())}
        onCommit={(text) =>
          onChange(number(text.trim(), kind.type === "number" ? kind.suffix : null))
        }
      />
    );
  }
  return <code className="be-as-written">{expressionText(value)}</code>;
}

function splitList(text: string): string[] {
  return text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

function listItem(text: string, primitive: string | undefined): Expression {
  if (primitive === "arrayBoolean") return expression({ type: "bool", value: text === "true" });
  if (primitive === "arrayString") {
    return expression({ type: "string", value: text.replace(/^"|"$/g, "") });
  }
  return number(text);
}

function VariableEditor({
  name: label,
  value,
  local,
  keys,
  onChange,
}: {
  name: string;
  value: string;
  local: boolean;
  keys: readonly string[];
  onChange(value: Expression): void;
}) {
  const listId = useId();
  return (
    <span className="be-variable">
      <span aria-hidden="true">{local ? "{." : "{"}</span>
      <CommitField
        label={local ? `${label}: local variable` : `${label}: store key`}
        value={local ? value.slice(1) : value}
        list={local ? undefined : listId}
        // Any key is written: the language quotes one `{key}` cannot hold.
        invalid={(text) => text === ""}
        onCommit={(text) =>
          onChange(expression({ type: "variable", name: local ? `.${text}` : text }))
        }
      />
      <span aria-hidden="true">{"}"}</span>
      {!local && (
        <datalist id={listId}>
          {keys.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
      )}
    </span>
  );
}

function NodeRefEditor({
  name: label,
  value,
  producers,
  onChange,
}: {
  name: string;
  value: Extract<ExpressionKind, { type: "port" }>;
  producers: readonly Producer[];
  onChange(value: Expression): void;
}) {
  const node = value.node.text;
  const parameter = value.parameter?.text ?? "";
  const producer = producers.find((p) => p.name === node);
  const names = producers.map((p) => p.name);
  if (node && !names.includes(node)) names.unshift(node);
  const ports = producer?.ports ?? (parameter ? [parameter] : []);
  return (
    <span className="be-node-ref">
      <span aria-hidden="true">@</span>
      <select
        aria-label={`${label}: node`}
        value={node}
        onChange={(event) =>
          onChange(expression({ type: "port", node: name(event.target.value), parameter: null }))
        }
      >
        {names.length === 0 && <option value="">no named node</option>}
        {names.map((n) => (
          <option key={n} value={n}>
            {n}
          </option>
        ))}
      </select>
      <select
        aria-label={`${label}: port`}
        value={parameter}
        onChange={(event) =>
          onChange(
            expression({
              type: "port",
              node: value.node,
              parameter: event.target.value ? name(event.target.value) : null,
            }),
          )
        }
      >
        <option value="">its return value</option>
        {ports.map((p) => (
          <option key={p} value={p}>
            {`.${p}`}
          </option>
        ))}
      </select>
    </span>
  );
}

function CallEditor({
  value,
  onChange,
  producers,
  keys,
  index,
}: {
  value: Extract<ExpressionKind, { type: "call" }>;
  onChange(value: Expression): void;
  producers: readonly Producer[];
  keys: readonly string[];
  index: FunctionIndex;
}) {
  const nested = value.call;
  const entry = index.lookup(nested.function);
  const modules = index.entries.filter((e) => !e.native);
  const params = entry ? orderedParameters(entry.signature.function) : [];
  const setArgument = (parameter: string, argument: Expression | null) =>
    onChange(
      expression({
        type: "call",
        call: argument
          ? withArgument(nested, parameter, argument)
          : withoutArgument(nested, parameter),
      }),
    );
  return (
    <div className="be-call">
      <select
        aria-label="Called function"
        value={entry ? modules.indexOf(entry) : -1}
        onChange={(event) => {
          const picked = modules[Number(event.target.value)];
          if (!picked) return;
          const names = orderedParameters(picked.signature.function).map((p) => p.parameter.name);
          onChange(
            expression({
              type: "call",
              call: {
                ...nested,
                function: picked.name,
                arguments: nested.arguments.filter((a) => names.includes(a.name.text)),
              },
            }),
          );
        }}
      >
        {!entry && <option value={-1}>{expressionText(expression(value))}</option>}
        {modules.map((e, i) => (
          <option key={`${e.signature.module_id}/${e.signature.id}`} value={i}>
            {`${e.group} · ${e.signature.name}`}
          </option>
        ))}
      </select>
      {params.map(({ id, parameter }) => (
        <ArgumentEditor
          key={id}
          name={parameter.name}
          ty={parameter.type}
          mutable={parameter.mutable}
          value={nested.arguments.find((a) => a.name.text === parameter.name)?.value}
          onChange={(argument) => setArgument(parameter.name, argument)}
          producers={producers}
          keys={keys}
          index={index}
        />
      ))}
    </div>
  );
}
