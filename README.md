# @semio/behavior-editor

An editor for Arora behaviors: a behavior tree and the detached nodes beside
it, as a diagram and as text, each editing the other, run live on a device or
on an in-process mock. Stand-alone: React is its only peer dependency.

The text is the language of `arora-behavior-tree`'s `text` module, compiled to
wasm and shipped with the package, so the editor reads a file exactly as the
device does:

```text
fallback                                   # the first node is the root
  sequence
    equal(a: {person/visible}, b: true)    # {key}: a store key
    equal(a: @fresh, b: true)              # @node: a node's return value
  succeed

fresh: not(x: {social/greeted})            # no node holds it: a detached node
level: {face/level} = add(a: @cm, b: 1)    # its return value written to a key
```

## Use

```bash
npm install @semio/behavior-editor
```

```tsx
import { BehaviorEditor, createBehaviorText } from "@semio/behavior-editor";
import initBehaviorText, * as behaviorText from "@semio/behavior-editor/wasm";
import "@semio/behavior-editor/styles.css";

await initBehaviorText();
const language = createBehaviorText(behaviorText);

<BehaviorEditor language={language} defaultText={text} />;
```

`initBehaviorText()` fetches `behavior_text_bg.wasm` beside the module, which a
bundler that understands `new URL(…, import.meta.url)` (Vite, webpack 5)
serves as is. Elsewhere, pass the module's bytes:
`initBehaviorText({ module_or_path: bytes })`.

| Prop | |
|---|---|
| `language` | The language service: `createBehaviorText(wasm)`, or any `BehaviorText`. |
| `runtime` | Where the behavior runs. A `MockArora` with the math module by default. |
| `text`, `onTextChange` | The file's text, for a controlled editor. |
| `defaultText` | The text an uncontrolled editor starts from. |
| `fileName` | The name a new file is saved under. |
| `moduleNames` | Names the palette shows for module ids. |
| `plotKeys` | The store keys plotted from the start. |
| `autoPlay` | Whether the behavior ticks as soon as it resolves (default `true`). |

The editor:

- draws the tree top-down, with each node's status this tick (S, R, F), and
  the detached nodes on its left, each level with the ports it feeds; a wire
  runs from each named node to every argument that reads it. A detached node
  shows whether it was called, served from its cache, or not reached.
- edits the selected node: its name (its readers follow), its function from a
  searchable palette, each argument by parameter (a literal by type, a store
  key, a tree-local variable, another node's port, a nested call), where its
  return value goes, and its place in the tree. Nodes move by dragging or
  Alt+arrow keys, are selected with the arrow keys, and deleted with Delete.
- reparses the text once typing pauses, and lists and underlines what the
  parser and the resolver report. While the text has errors, the diagram
  edits nothing: the text is the only whole account of the behavior.
- ticks the behavior at 10, 30 or 60 Hz, edits the store's keys with sliders,
  switches and fields, and plots the ones chosen.
- opens and saves `.bt` files through the File System Access API, or a file
  input and a download where the browser lacks it.

Styles are plain CSS on `--be-` custom properties on `:root`, with a dark set
that follows the system unless the page sets `data-theme` on its root element.

## Runtimes

`BehaviorRuntime` is what the editor runs a behavior on:

- `MockArora` runs a resolved graph in process with `arora-behavior-tree`'s
  semantics: native control and data nodes, module leaves, detached nodes
  brought up to date on demand once per tick and called only when their
  arguments changed, sinks published after the tree in node-id order, state
  in mutable parameters, kept across a restart for the nodes an edit left in
  place. Its math module carries the operations of the NGBT spectrum's
  examples (`add`, `mul`, `clamp`, `remap`, `lt`, `not`, `osc`, `damp`,
  `number`, `boolean`, `wait`); it publishes its clock to `arora/time`.
- `DeviceRuntime` runs it on a device as Studio's World offers it, through the
  device's own call path: the interpreter's `spawn_graph`, built by
  `language.spawnGraphCall`, and stopped with the call the run's handle names
  (`language.taskHandle`).

## Develop

The wasm build needs Rust and `wasm-pack`:

```bash
npm run build:wasm   # wasm/pkg, which the build, lint, typecheck and tests read
npm run test:unit
npm run demo         # the editor over the mock and the spectrum's examples, on port 5188
```

`wasm/` depends on `arora-behavior-tree` 9.6, which is not yet on crates.io:
until it is, a local, gitignored `.cargo/config.toml` in this package patches
it to a `cargo package` of the arora-sdk branch that carries it, and
`wasm/Cargo.lock` is not committed.
