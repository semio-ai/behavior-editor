import { useEffect, useId, useState } from "react";
import {
  NO_SPAN,
  type NodePath,
  addChild,
  addDetached,
  clearArgument,
  deleteNode,
  moveNode,
  newNode,
  renameNode,
  reparent,
  setArgument,
  setFunction,
  setTarget,
  siblingPath,
  walk,
} from "../model/edit";
import { orderedParameters } from "../model/signature";
import type { BehaviorDocument } from "../text/ast";
import { ArgumentEditor, type Producer } from "./ArgumentEditor";
import { type DiagramRow, rowKey } from "./diagram-rows";
import { functionText } from "./expression-text";
import { FunctionPicker, signatureText } from "./FunctionPicker";
import { type FunctionEntry, type FunctionIndex, holdsChildren } from "./functions";

/** An edit of the document, and the node to select once it applies. */
export type Edit = (document: BehaviorDocument) => BehaviorDocument;

export interface InspectorProps {
  document: BehaviorDocument;
  row: DiagramRow;
  rows: readonly DiagramRow[];
  index: FunctionIndex;
  keys: readonly string[];
  onEdit(edit: Edit, select?: NodePath | null): void;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A name no node has, from `base`: `base`, then `base_2`, `base_3`… */
export function freshName(document: BehaviorDocument, base: string): string {
  const taken = new Set(walk(document).flatMap(({ node }) => (node.name ? [node.name.text] : [])));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

/** The node the diagram selected: its name, function, arguments, binding, and place. */
export function Inspector({ document, row, rows, index, keys, onEdit }: InspectorProps) {
  const [picking, setPicking] = useState<"function" | "child" | "detached" | null>(null);
  const nameId = useId();
  const moveId = useId();
  const { node, path, entry } = row;
  useEffect(() => setPicking(null), [row.key]);

  const producers: Producer[] = rows.flatMap((r) => {
    if (!r.node.name || r.key === row.key) return [];
    const signature = r.entry?.signature.function;
    const ports = signature
      ? orderedParameters(signature)
          .filter((p) => p.parameter.mutable)
          .map((p) => p.parameter.name)
      : [];
    return [{ name: r.node.name.text, ports }];
  });
  const isRoot = row.key === "0";
  const holder = row.shape === "control" || holdsChildren(entry);
  const parents = rows.filter(
    (r) =>
      (r.shape === "control" || holdsChildren(r.entry)) &&
      !r.detached &&
      r.key !== row.parentKey &&
      r.key !== row.key &&
      !row.descendantKeys.includes(r.key),
  );

  const pick = (picked: FunctionEntry) => {
    const kind = picking;
    setPicking(null);
    if (kind === "function") {
      const names = orderedParameters(picked.signature.function).map((p) => p.parameter.name);
      onEdit((d) => setFunction(d, path, picked.name, names));
    } else if (kind === "child") {
      onEdit((d) => addChild(d, path, newNode(picked.name)), [...path, node.children.length]);
    } else if (kind === "detached") {
      const created = {
        ...newNode(picked.name),
        name: { text: freshName(document, picked.signature.name), span: NO_SPAN },
      };
      onEdit((d) => addDetached(d, created), [document.nodes.length]);
    }
  };

  const params = entry ? orderedParameters(entry.signature.function) : [];
  const unknown = node.arguments.filter((a) => !params.some((p) => p.parameter.name === a.name));

  return (
    <section className="be-inspector" aria-label="Selected node">
      <header className="be-inspector-head">
        <h3>{row.detached ? "Detached node" : isRoot ? "Root" : "Tree node"}</h3>
        <code>{row.title}</code>
      </header>

      <div className="be-field">
        <label htmlFor={nameId}>Name</label>
        <NameField
          id={nameId}
          value={node.name?.text ?? ""}
          onCommit={(name) => onEdit((d) => renameNode(d, path, name || null))}
          taken={(name) =>
            walk(document).some(({ node: n }) => n !== node && n.name?.text === name)
          }
        />
      </div>

      <div className="be-field">
        <span className="be-label" id={`${nameId}-fn`}>
          Function
        </span>
        <button
          type="button"
          className="be-function"
          aria-describedby={`${nameId}-fn`}
          title={entry ? signatureText(entry) : "No module has this function"}
          onClick={() => setPicking("function")}
        >
          {functionText(node.function)}
          {!entry && <span className="be-warn"> · unknown</span>}
        </button>
      </div>
      {picking && (
        <FunctionPicker
          index={index}
          label={
            picking === "function"
              ? "Set function"
              : picking === "child"
                ? "Add child"
                : "Add detached node"
          }
          onPick={pick}
          onCancel={() => setPicking(null)}
        />
      )}

      {!holder && (
        <ArgumentEditor
          name="returns to"
          ty={entry?.signature.function.returnType}
          mutable={false}
          value={node.target ?? undefined}
          onChange={(target) => onEdit((d) => setTarget(d, path, target))}
          producers={producers}
          keys={keys}
          index={index}
          modes={["unset", "key", "local", "node"]}
        />
      )}

      {params.length > 0 && <h4 className="be-subhead">Arguments</h4>}
      {params.map(({ id, parameter }) => (
        <ArgumentEditor
          key={id}
          name={parameter.name}
          ty={parameter.type}
          mutable={parameter.mutable}
          value={node.arguments.find((a) => a.name === parameter.name)?.value}
          onChange={(value) =>
            onEdit((d) =>
              value === null
                ? clearArgument(d, path, parameter.name)
                : setArgument(d, path, parameter.name, value),
            )
          }
          producers={producers}
          keys={keys}
          index={index}
        />
      ))}
      {unknown.length > 0 && (
        <div className="be-unknown">
          <h4 className="be-subhead">Arguments the function does not take</h4>
          <ul>
            {unknown.map((a) => (
              <li key={a.name}>
                <code>{a.name}</code>
                <button
                  type="button"
                  aria-label={`Remove argument ${a.name}`}
                  onClick={() => onEdit((d) => clearArgument(d, path, a.name))}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <h4 className="be-subhead">Structure</h4>
      <div className="be-actions">
        {holder && (
          <button type="button" onClick={() => setPicking("child")}>
            Add child
          </button>
        )}
        <button type="button" onClick={() => setPicking("detached")}>
          Add detached node
        </button>
        <button
          type="button"
          disabled={isRoot}
          onClick={() => onEdit((d) => moveNode(d, path, -1), siblingPath(path, -1))}
        >
          Move up
        </button>
        <button
          type="button"
          disabled={isRoot}
          onClick={() => onEdit((d) => moveNode(d, path, 1), siblingPath(path, 1))}
        >
          Move down
        </button>
        <button
          type="button"
          className="be-danger"
          disabled={isRoot}
          onClick={() =>
            onEdit((d) => deleteNode(d, path), path.length > 1 ? path.slice(0, -1) : [0])
          }
        >
          Delete
        </button>
      </div>
      {!isRoot && (
        <div className="be-field">
          <label htmlFor={moveId}>Move to</label>
          <select
            id={moveId}
            value=""
            onChange={(event) => {
              const to = event.target.value;
              if (to === "detached") {
                onEdit((d) => reparent(d, path, null, d.nodes.length), null);
              } else if (to) {
                const target = rows.find((r) => r.key === to)!;
                onEdit((d) => reparent(d, path, target.path, target.node.children.length), null);
              }
            }}
          >
            <option value="">choose a new parent…</option>
            {!row.detached && <option value="detached">no parent: detached</option>}
            {parents.map((p) => (
              <option key={p.key} value={p.key}>
                {`under ${p.title} (${rowKey(p.path)})`}
              </option>
            ))}
          </select>
        </div>
      )}
    </section>
  );
}

function NameField({
  id,
  value,
  onCommit,
  taken,
}: {
  id: string;
  value: string;
  onCommit(name: string): void;
  taken(name: string): boolean;
}) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const problem =
    text && !IDENTIFIER.test(text)
      ? "A name is letters, digits and underscores, not starting with a digit."
      : text && taken(text)
        ? "Another node has this name."
        : null;
  const commit = () => {
    if (!problem && text !== value) onCommit(text);
  };
  return (
    <>
      <input
        id={id}
        type="text"
        value={text}
        placeholder="unnamed"
        spellCheck={false}
        aria-invalid={problem !== null}
        aria-describedby={problem ? `${id}-problem` : undefined}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit();
          if (event.key === "Escape") setText(value);
        }}
      />
      {problem && (
        <p className="be-problem" id={`${id}-problem`}>
          {problem}
        </p>
      )}
    </>
  );
}
