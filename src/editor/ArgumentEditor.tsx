import { useEffect, useId, useState } from "react";
import { NO_SPAN } from "../model/edit";
import { type FrozenTy, formatType, orderedParameters, primitiveKind } from "../model/signature";
import type { Argument, Expression } from "../text/ast";
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

export function modeOf(expression: Expression | undefined): Mode {
  if (!expression) return "unset";
  switch (expression.kind) {
    case "variable":
      return expression.name.startsWith(".") ? "local" : "key";
    case "node":
      return "node";
    case "call":
      return "call";
    case "select":
      return "other";
    default:
      return "literal";
  }
}

const NUMBER = /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;
const NUMERIC_KINDS = new Set(["u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64", "f32", "f64"]);

/** The literal a parameter of type `ty` starts from. */
function defaultLiteral(ty: FrozenTy | undefined): Expression {
  if (ty?.type === "frozenOption") return { kind: "none", span: NO_SPAN };
  const kind = ty && primitiveKind(ty);
  if (kind === "boolean") return { kind: "bool", value: false, span: NO_SPAN };
  if (kind === "string") return { kind: "string", value: "", span: NO_SPAN };
  if (kind?.startsWith("array"))
    return { kind: "array", element_type: null, items: [], span: NO_SPAN };
  return { kind: "number", text: "0", suffix: null, span: NO_SPAN };
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
  name,
  ty,
  mutable,
  value,
  onChange,
  producers,
  keys,
  index,
  modes = ALL_MODES,
}: ArgumentEditorProps) {
  const id = useId();
  const mode = modeOf(value);
  const offered = mode === "other" ? [...modes, "other" as const] : modes;
  const setMode = (next: Mode) => {
    switch (next) {
      case "unset":
        return onChange(null);
      case "literal":
        return onChange(defaultLiteral(ty));
      case "key":
        return onChange({ kind: "variable", name: keys[0] ?? "", span: NO_SPAN });
      case "local":
        return onChange({ kind: "variable", name: ".", span: NO_SPAN });
      case "node":
        return onChange({
          kind: "node",
          node: producers[0]?.name ?? "",
          parameter: null,
          span: NO_SPAN,
        });
      case "call": {
        const first = index.entries.find((e) => !e.native);
        if (!first) return undefined;
        return onChange({ kind: "call", function: first.name, arguments: [], span: NO_SPAN });
      }
      default:
        return undefined;
    }
  };
  return (
    <fieldset className="be-argument">
      <legend>
        <span className="be-param">{name}</span>
        {ty && <span className="be-type">{`${mutable ? "mut " : ""}${formatType(ty)}`}</span>}
      </legend>
      <div className="be-argument-row">
        <select
          id={`${id}-mode`}
          aria-label={`${name}: source`}
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
          <LiteralEditor name={name} ty={ty} value={value} onChange={onChange} />
        )}
        {value?.kind === "variable" && (
          <VariableEditor
            name={name}
            value={value.name}
            local={mode === "local"}
            keys={keys}
            onChange={onChange}
          />
        )}
        {value?.kind === "node" && (
          <NodeRefEditor name={name} value={value} producers={producers} onChange={onChange} />
        )}
        {mode === "other" && value && (
          <code className="be-as-written">{expressionText(value)}</code>
        )}
      </div>
      {value?.kind === "call" && (
        <CallEditor
          value={value}
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
  name,
  ty,
  value,
  onChange,
}: {
  name: string;
  ty: FrozenTy | undefined;
  value: Expression;
  onChange(value: Expression): void;
}) {
  if (ty?.type === "frozenOption") {
    const present = value.kind !== "none";
    const inner = value.kind === "some" ? value.value : value;
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
                  : { kind: "none", span: NO_SPAN },
              )
            }
          />
          {`${name} present`}
        </label>
        {present && (
          <LiteralEditor name={name} ty={ty.value.element} value={inner} onChange={onChange} />
        )}
      </span>
    );
  }
  const kind = ty ? primitiveKind(ty) : undefined;
  if (value.kind === "bool" || kind === "boolean") {
    return (
      <label className="be-check">
        <input
          type="checkbox"
          checked={value.kind === "bool" && value.value}
          onChange={(event) =>
            onChange({ kind: "bool", value: event.target.checked, span: NO_SPAN })
          }
        />
        {name}
      </label>
    );
  }
  if (value.kind === "string" || kind === "string") {
    return (
      <CommitField
        label={name}
        value={value.kind === "string" ? value.value : ""}
        onCommit={(text) => onChange({ kind: "string", value: text, span: NO_SPAN })}
      />
    );
  }
  if (value.kind === "array" || kind?.startsWith("array")) {
    const numeric = kind !== "arrayString" && kind !== "arrayBoolean";
    const items = value.kind === "array" ? value.items : [];
    return (
      <CommitField
        label={`${name}, comma separated`}
        value={items.map(expressionText).join(", ")}
        invalid={(text) => numeric && splitList(text).some((t) => !NUMBER.test(t))}
        onCommit={(text) =>
          onChange({
            kind: "array",
            element_type: value.kind === "array" ? value.element_type : null,
            items: splitList(text).map((t) => listItem(t, kind)),
            span: NO_SPAN,
          })
        }
      />
    );
  }
  if (value.kind === "uuid") {
    return (
      <CommitField
        label={name}
        value={value.value}
        onCommit={(text) => onChange({ kind: "uuid", value: text, span: NO_SPAN })}
      />
    );
  }
  const numeric = value.kind === "number" || (kind !== undefined && NUMERIC_KINDS.has(kind));
  if (numeric) {
    return (
      <CommitField
        label={name}
        className="be-number"
        value={value.kind === "number" ? value.text : ""}
        invalid={(text) => !NUMBER.test(text.trim())}
        onCommit={(text) =>
          onChange({
            kind: "number",
            text: text.trim(),
            suffix: value.kind === "number" ? value.suffix : null,
            span: NO_SPAN,
          })
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

function listItem(text: string, kind: string | undefined): Expression {
  if (kind === "arrayBoolean") return { kind: "bool", value: text === "true", span: NO_SPAN };
  if (kind === "arrayString")
    return { kind: "string", value: text.replace(/^"|"$/g, ""), span: NO_SPAN };
  return { kind: "number", text, suffix: null, span: NO_SPAN };
}

const KEY = /^[^{}\s]+$/;

function VariableEditor({
  name,
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
        label={local ? `${name}: local variable` : `${name}: store key`}
        value={local ? value.slice(1) : value}
        list={local ? undefined : listId}
        invalid={(text) => !KEY.test(text)}
        onCommit={(text) =>
          onChange({ kind: "variable", name: local ? `.${text}` : text, span: NO_SPAN })
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
  name,
  value,
  producers,
  onChange,
}: {
  name: string;
  value: Extract<Expression, { kind: "node" }>;
  producers: readonly Producer[];
  onChange(value: Expression): void;
}) {
  const producer = producers.find((p) => p.name === value.node);
  const names = producers.map((p) => p.name);
  if (value.node && !names.includes(value.node)) names.unshift(value.node);
  return (
    <span className="be-node-ref">
      <span aria-hidden="true">@</span>
      <select
        aria-label={`${name}: node`}
        value={value.node}
        onChange={(event) =>
          onChange({ kind: "node", node: event.target.value, parameter: null, span: NO_SPAN })
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
        aria-label={`${name}: port`}
        value={value.parameter ?? ""}
        onChange={(event) =>
          onChange({ ...value, parameter: event.target.value || null, span: NO_SPAN })
        }
      >
        <option value="">its return value</option>
        {(producer?.ports ?? (value.parameter ? [value.parameter] : [])).map((p) => (
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
  value: Extract<Expression, { kind: "call" }>;
  onChange(value: Expression): void;
  producers: readonly Producer[];
  keys: readonly string[];
  index: FunctionIndex;
}) {
  const entry = index.lookup(value.function);
  const modules = index.entries.filter((e) => !e.native);
  const params = entry ? orderedParameters(entry.signature.function) : [];
  const setArgument = (param: string, expression: Expression | null) => {
    const rest = value.arguments.filter((a) => a.name !== param);
    const next: Argument[] = expression
      ? params.some((p) => p.parameter.name === param)
        ? params.flatMap((p) => {
            if (p.parameter.name === param)
              return [{ name: param, value: expression, span: NO_SPAN }];
            const kept = rest.find((a) => a.name === p.parameter.name);
            return kept ? [kept] : [];
          })
        : [...rest, { name: param, value: expression, span: NO_SPAN }]
      : rest;
    onChange({ ...value, arguments: next, span: NO_SPAN });
  };
  return (
    <div className="be-call">
      <select
        aria-label="Called function"
        value={entry ? modules.indexOf(entry) : -1}
        onChange={(event) => {
          const picked = modules[Number(event.target.value)];
          if (!picked) return;
          const names = orderedParameters(picked.signature.function).map((p) => p.parameter.name);
          onChange({
            ...value,
            function: picked.name,
            arguments: value.arguments.filter((a) => names.includes(a.name)),
            span: NO_SPAN,
          });
        }}
      >
        {!entry && <option value={-1}>{expressionText({ ...value, arguments: [] })}</option>}
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
          value={value.arguments.find((a) => a.name === parameter.name)?.value}
          onChange={(expression) => setArgument(parameter.name, expression)}
          producers={producers}
          keys={keys}
          index={index}
        />
      ))}
    </div>
  );
}
