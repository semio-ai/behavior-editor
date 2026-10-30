import { useEffect, useId, useRef, useState } from "react";
import { formatType, orderedParameters } from "../model/signature";
import type { FunctionEntry, FunctionIndex } from "./functions";

export interface FunctionPickerProps {
  index: FunctionIndex;
  /** What picking does, for the search field's label: "Add child", "Set function". */
  label: string;
  onPick(entry: FunctionEntry): void;
  onCancel(): void;
}

/** A function's call shape, for the palette: `clamp(x: f64, min: option<f64>) → f64`. */
export function signatureText(entry: FunctionEntry): string {
  const fn = entry.signature.function;
  const params = orderedParameters(fn)
    .map(
      ({ parameter }) =>
        `${parameter.mutable ? "mut " : ""}${parameter.name}: ${formatType(parameter.type)}`,
    )
    .join(", ");
  return `${entry.signature.name}(${params}) → ${formatType(fn.returnType)}`;
}

/** The functions a node may call, searchable by name, grouped by module. */
export function FunctionPicker({ index, label, onPick, onCancel }: FunctionPickerProps) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const search = useRef<HTMLInputElement>(null);
  // The picker opens on a deliberate action, and searching is what that action asks for.
  useEffect(() => search.current?.focus(), []);
  const needle = query.trim().toLowerCase();
  const matches = index.entries.filter((e) => e.signature.name.toLowerCase().includes(needle));
  const groups = [...new Set(matches.map((e) => e.group))];
  return (
    <div className="be-picker">
      <div className="be-picker-head">
        <label htmlFor={searchId}>{label}</label>
        <input
          id={searchId}
          type="search"
          value={query}
          placeholder="Search functions"
          ref={search}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && matches.length === 1) onPick(matches[0]!);
            if (event.key === "Escape") onCancel();
          }}
        />
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      {groups.length === 0 && <p className="be-fine">No function matches “{query}”.</p>}
      {groups.map((group) => (
        <section key={group} className="be-picker-group" aria-label={group}>
          <h4>{group}</h4>
          <ul>
            {matches
              .filter((e) => e.group === group)
              .map((e) => (
                <li key={`${e.signature.module_id}/${e.signature.id}`}>
                  <button type="button" onClick={() => onPick(e)} title={signatureText(e)}>
                    <span className="be-fn-name">{e.signature.name}</span>
                    <span className="be-fn-sig">
                      {signatureText(e).slice(e.signature.name.length)}
                    </span>
                  </button>
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
