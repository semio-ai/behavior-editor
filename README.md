# @semio/behavior-editor

An editor for Arora behaviors: a behavior tree and the detached nodes beside
it, as a diagram and as text, each editing the other, run live on a device or
on an in-process mock. Stand-alone: React is its only peer dependency.

The text is the language of `arora-behavior-tree`'s `text` module, compiled to
wasm and shipped with the package, so the editor reads a file exactly as the
device does:

```text
fallback                                       # the first node is the root
  sequence
    equal(a: {person/visible}, b: true)        # {key}: a store key
    equal(a: @fresh._ret, b: true)             # @node._ret: a node's return value
  succeed

fresh: not(x: {social/greeted})                # no node holds it: a detached node
level: {face/level} = add(a: @cm._ret, b: 1)   # its return value written to a key
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

<BehaviorEditor language={language} examples={examples} />;
```

`initBehaviorText()` fetches `behavior_text_bg.wasm` beside the module, which a
bundler that understands `new URL(…, import.meta.url)` (Vite, webpack 5)
serves as is. Elsewhere, pass the module's bytes:
`initBehaviorText({ module_or_path: bytes })`.

| Prop | |
|---|---|
| `language` | The language service: `createBehaviorText(wasm)`, or any `BehaviorText`. |
| `runtime` | Where the behavior runs with no device attached. A `MockArora` with the math module by default. |
| `session` | A `DeviceSession`: while it is connected, or lost and connecting again, the editor is on that device (below), whatever file is open, an example as any other. |
| `text`, `onTextChange` | The file's text, for a controlled editor. |
| `defaultText` | The text an uncontrolled editor starts from. With neither it nor `text`, the editor opens on its start screen. |
| `fileName` | The name a new file is saved under; its extension says its format. |
| `examples` | The behaviors the start screen offers, each a `BehaviorExample`: its `title`, `fileName` and `text`, the `plotKeys` it plots, and the `runtime` it runs on with no device attached, if any. None by default. |
| `moduleNames` | Names the palette shows for module ids. |
| `plotKeys` | The store keys plotted from the start. |
| `autoPlay` | Whether the behavior ticks as soon as it resolves (default `true`). |

The editor:

- opens, with no behavior, on a start screen: a new behavior, a file to open,
  the files opened lately, and the examples the host gives. With no device
  attached, an example that declares a runtime, such as a device seeded for
  it, runs on one made when it opens and disposed when another file opens; any
  other file runs on the editor's runtime. With a device attached, every file
  works on the device, and the start screen marks the examples that cannot run
  there, which still open to be read. Once a file is open, the File menu holds New, Open, the
  recent files, Save, Save As and Close, which goes back to the start screen;
  each asks before discarding unsaved changes.
- remembers the last ten files opened or saved, per browser, in IndexedDB: a
  file by its File System Access handle where the browser keeps one, so it
  opens again without a picker once the person lets the page read it; otherwise
  by its name and its contents as last opened or saved. Each can be removed
  from the list. Where storage is unavailable, as in some private windows, the
  list lasts as long as the page.
- draws the tree top-down, with each node's status this tick (S, R, F), and
  the detached nodes on its left, each level with the ports it feeds; a wire
  runs from each named node to every argument that reads it. A detached node
  shows whether it ran to a changed value or the same one, was served from its
  cache, or was not reached; a node's return value sits in its top border.
- edits the selected node: its name (its readers follow), its function from a
  searchable palette, each argument by parameter (a literal by type, a store
  key, a tree-local variable, another node's port, a nested call), where its
  return value goes, and its place in the tree. Nodes move by dragging or
  Alt+arrow keys, are selected with the arrow keys, and deleted with Delete.
- reparses the text once typing pauses, and lists and underlines what the
  parser and the resolver report. While the text has errors, the diagram
  edits nothing: the text is the only whole account of the behavior. A
  literal holding a 64-bit integer past ±(2^53 − 1), which a JavaScript number
  does not hold exactly, is an error.
- ticks the behavior at 10, 30 or 60 Hz, and nothing while the text does not
  run, and plots the keys chosen. It lists the store's keys and the keys the
  behavior reads, set or not, and edits with fields, sliders and switches the
  ones its runtime lets a person write (a device's key meta, the mock's
  inputs), save a key the behavior publishes after every tick. A number's
  slider spans the bounds its runtime declares, within its type's limits. A key a tree node writes stays editable, marked as such,
  and a write a device applies at its next step shows as pending until then.
- opens and saves behavior files in four formats (below) through the File
  System Access API, or a file input and a download where the browser lacks
  it.

Styles are plain CSS on `--be-` custom properties on `:root`, with a dark set
that follows the system unless the page sets `data-theme` on its root element.

## Files

| Format | Extension | Holds |
|---|---|---|
| Behavior text | `.bt` | everything: the tree, the detached nodes, every binding, the comments and the layout |
| Readable graph, JSON | `.json` | the graph: nodes, bindings, children and root, every reference by name where one resolves back to the same id, by id otherwise |
| Readable graph, YAML | `.yaml`, `.yml` | the same graph, in YAML |
| Groot XML | `.xml` | a tree alone: no node outside it, no binding to another node's port or a selection, no node name |

Which form to use where is arora-behavior-tree's rule,
[Which form to use](https://github.com/semio-ai/arora-sdk/blob/main/crates/arora-behavior-tree/docs/text.md#which-form-to-use).

The editor edits a behavior as text, so a file opens as the text of the graph
it holds: a readable graph is resolved against the runtime's functions (by
names, by ids, or both, as `arora-behavior-tree`'s `readable` reads it), a
Groot tree through its Groot loader, and the graph is written as text by its
`display`, and that text is kept only when it resolves back to the same
graph. A node the file names keeps its name, and a readable graph's nodes keep
their ids: one the text would give another id is named by its id. A call
in an argument is a node of the graph, which the text shows as a node of its
own, named by its id. A file that does not load says why, with its place: a
line and column, or the path of a reference (`nodes[2].bind.lo`).

Save writes the file's own format, Save As the one picked, to a name with that
format's extension. A graph file is written from the graph the text resolves
to, so the text must resolve without errors; each node is written by its name,
or by its path (`root.0.2`) when the text names it not. A graph file keeps no
comments, which saving says. A file is written only when it opens again: JSON
reads as deep as four times the language's nesting limit, YAML 128 levels.
Saving a behavior Groot cannot hold is refused, naming what it cannot hold.

## Runtimes

`BehaviorRuntime` is what the editor runs a behavior on: the graph resolving
the text gives, `arora_behavior::graph::Graph` in graph format behavior-tree
2.0 (`arora-behavior-tree` 10). Its nodes are a list, each with its function,
its children, and its bindings: for each port, the value, store key or other
node's port feeding it, or the key its output is written to.

The editor starts a behavior when none runs: every node starts afresh. While
one runs, each change of the text that resolves is sent as an edit, the
`GraphDiff` from the graph running to the next (`language.diff`, arora's
`Graph::diff`): the nodes the diff sets whole or binds a port of restart, and
every other node keeps its state, so a `sequence_star` stays at the child it
had reached and a `damp` goes on easing from its value. Stop and Reset start
the next behavior afresh.

- `MockArora` runs a resolved graph in process with `arora-behavior-tree`'s
  semantics: native control and data nodes, module leaves, detached nodes
  brought up to date on demand once per tick and called only when their
  arguments changed, sinks published after the tree in node-id order, state
  in mutable parameters. It applies an edit as a device does: the nodes the
  diff sets or binds restart, and every other keeps its state. It reports each node's return value after the tick. Its math module
  carries the operations of the NGBT spectrum's examples, named as
  `arora-behavior-tree`'s `docs/text.md` names them (`add`, `mul`, `clamp`,
  `remap`, `lt`, `not`, `truthy`, `oscillator`, `damp`, `identity`, `wait`);
  it publishes its clock to `arora/time`.
- `DeviceRuntime` runs it on an Arora device, through the device's own call
  path, as any client's call reaches the interpreter: `start` sends `LOAD`
  (`language.loadCall`), which makes the graph the device's behavior, ticked
  at every step and re-evaluated once it completes, every node starting
  afresh; `edit` sends `EDIT` (`language.editCall`) with a graph diff; `stop`
  loads the empty graph. The host hands it the device as an
  `AroraDevice`: describe its methods, call one, write its inputs, list its
  keys, read its store and step it, each answering when it returns or with a
  promise, values as the JSON of Arora's `Value`. A device on its own clock
  (`ownClock`) is not stepped: a step waits for the device's next one, and
  reports what changed since the last step the editor saw, which may span
  several of the device's. Such a device runs its behavior whether the editor
  follows it or not: pausing stops following, not the device.

  Given the language as `trace`, it shows the behavior's nodes as the mock
  does, through a trace (arora-behavior's `docs/trace.md`): `start` calls the
  interpreter's `TRACE` (`language.traceCall`), watching the outputs of the
  nodes the text names and of the detached nodes, and every step folds the
  reports the trace wrote since (`language.traceReport`) into each node's
  status, each detached node's activity and each watched node's return
  value. A report that follows one not read, or an edit that changes the
  nodes watched, starts the trace over, its first report stating every node
  anew; `stop` halts it. A device whose interpreter does not trace shows its
  store alone. A device on its own clock may write several reports between
  two of the editor's steps, so it gives every value the feedback key took
  (`takeValues`), and the runtime reads them all.
- The editor stops the behavior on a runtime it lets go of, as it closes a
  file or as the host switches its `runtime`, through the calls it queues on
  that runtime: a host disposing of the runtime or closing its device waits
  for `whenIdle(runtime)`, which settles once every call queued so far ran.
- `BridgeDevice` is an `AroraDevice` on its own clock over any `BridgeClient`
  (below): it reads the device's keys and values as it is taken up
  (`BridgeDevice.over(client)`), keeps the store current from what the device
  pushes, and reads it whole again at each step, as a device pushes what it
  sets and not what it unsets. A step waits for the next push carrying
  `arora/time`, or answers after its `dtMs` when the device does not step.
  `takeValues` gives every value a key was pushed since it last asked, the
  last 256 of them. A bridge unsets no key, so writing `null` is refused.

## On a device

The editor works on a device through a `DeviceSession`. The library does not
own the transport: a session runs over a `BridgeClient`, the operations any
remote client of an Arora device has, named after `arora_bridge`'s
`BridgeOp`s, and the values the device pushes as it steps. A host implements
it over whatever reaches its devices, Semio Studio's bridge, a ROS 2 bridge,
a device in the page, or takes the one for a device's open local bridge from
`@semio/behavior-editor/websocket`.

```ts
interface BridgeClient {
  describeMethods(prefix?: string): Promise<MethodSignature[]>; // BridgeOp::DescribeMethods
  call(call: Call): Promise<CallResult>;                        // BridgeOp::Call
  readValues(keys: readonly string[]): Promise<Record<string, Value>>; // BridgeOp::Get
  writeValues(values: Record<string, Value>): Promise<void>;    // BridgeOp::Update
  listKeys(prefix?: string): Promise<BridgeKey[]>;              // BridgeOp::ListKeys
  onValues(listener: (values: Record<string, Value>) => void, prefixes?: readonly string[]): () => void;
  close(): void;                        // the device goes on running its behavior
  readonly closed: Promise<BridgeClosure>; // why it ended: closed, refused or lost
}
```

A client never steps the device: the device steps itself and pushes what each
step set. An answer and the pushes keep the order the device sent them in. A
closure says whether this side closed the connection, the device refused it
on purpose (a bridge serving one client does when another takes it), or it
was lost.

A host hands its own client to the editor in a few lines:

```tsx
import { BehaviorEditor, useDeviceSession, ConnectionStatus } from "@semio/behavior-editor";

function Editor({ openBridge }: { openBridge: () => Promise<BridgeClient> }) {
  const connection = useDeviceSession({ language });
  return (
    <>
      <button onClick={() => connection.connect(openBridge, "my robot")}>Connect</button>
      <ConnectionStatus connection={connection} />
      <BehaviorEditor language={language} session={connection.session} />
    </>
  );
}
```

Over a device's open local bridge, the WebSocket entry point gives the
client, and a bar that asks for the bridge's URL:

```tsx
import { WebSocketConnectionBar } from "@semio/behavior-editor/websocket";

const connection = useDeviceSession({ language });
<WebSocketConnectionBar connection={connection} />      // ws://127.0.0.1:9000 by default
<BehaviorEditor language={language} session={connection.session} />
```

Without React, `connectWebSocket(url, { language })` gives a session, and
`new DeviceSession(bridge, { language })` makes one over any client.

### The session

`new DeviceSession(bridge, options)` takes a connection, or a function that
opens one. Given a function, the session connects again after a loss, waiting
0.5 s, then twice as long each attempt up to 10 s (`reconnect`); a device that
refuses the connection is not connected to again. Reconnecting is the
session's: a transport opens one connection at a time and says how it ended,
and the session re-attaches the same way whether it connects for the first
time or the tenth.

| | |
|---|---|
| `state` | `connecting`, `connected`, `lost` (with why, and when it tries again), or `closed` (with why, and whether the device refused it) |
| `on("state" \| "behaviorChanged" \| "tick" \| "error", listener)` | each change of state; each change of the device's behavior, and whether another client made it; each step followed, with the report, the device's status and its keys |
| `status` | the device's tick, clock, step rate and behavior revision |
| `deviceBehavior()` | the graph the device runs and its revision; `null` when the device does not say |
| `follow(behavior)` | the nodes the trace follows: a resolved file, or `null` for whatever the device runs |
| `run(loaded)`, `edit(diff, next)`, `stop()` | load a behavior, apply a diff to it, load the empty one |
| `functions()`, `read(key)`, `write(key, value)` | the device's functions and store |
| `close()` | halt the trace and close the connection; the behavior goes on running |

Connecting attaches without changing what the device runs. The session reads
the behavior with the interpreter's `READ` and follows it with a trace: each
step reports the nodes' states, the interpreter's tick (the trace's last
report, counted on with each of the device's steps since), the clock
`arora/time`, the step rate from `arora/dt`, and the revision
`arora/behavior/revision`, which the interpreter increases at each load and
each accepted edit. A revision this session did not cause is another
client's change; one that moved while the connection was lost is too.

`READ` and the revision come with arora-behavior 10.1, which the package's
wasm is built on (`readCall`, `readResult`). A device whose interpreter
predates them refuses `READ`: it is one that does not say what it runs,
followed by its trace, clock and store.

### The editor on a device

- **The device is where everything opened works.** A new file, a file opened,
  a recent file or an example: while a device is attached, each works on it,
  and nothing ticks in the page. Letting go of the device hands the file back
  to its runtime with no device: the example's own, or the editor's.
- **The header says where the behavior runs:** **Simulated**, on the editor's
  or the example's runtime in the page, or **Device** and what the session is
  connected to.
- **The device's behavior opens from the header and the start screen.**
  While a device is attached, **Device's behavior** beside where the
  behavior runs, and **Open the device's behavior** beside Open… on the start
  screen, read what the device runs now and open it: as the file the editor
  ran there, with its names, when one has its graph; otherwise as a file
  whose nodes are named by their ids. The header's button asks before
  discarding unsaved changes, and is disabled, saying why, on a device that
  does not report its behavior.
- **Attaching is read-only.** The editor reads what the device runs. The
  device steps itself, so its tick, step rate, clock and revision show where
  Play, Step and the rate would.
- **A file calling functions the device lacks** says so in the banner, by
  name, and its Run is disabled with that reason; the text's diagnostics point
  at the calls. The start screen marks each example the device cannot run:
  the functions it calls that the device lacks, or that it does not resolve
  against the device's functions.
- **The file the device runs** — one whose graph is the device's — shows the
  device's node states, and each change of it goes to the device as an edit
  (**Live edits**, on by default). Turned off, the changes wait for **Apply**,
  which counts them. **Stop on device** loads the empty behavior.
- **A device running another behavior** offers to **view** it, opened as
  the header's button opens it; to **run this file** on it; or
  to **compare**: the nodes only in the file, only on the device, changed, or
  rebound, each selecting its node.
- **Another client's change** of the behavior the file ran as stops the
  editor sending changes, and offers to **reload** the device's behavior or
  **overwrite** it with the file.
- **A device that does not report its behavior** offers to run the file or to
  stop the device.
- **Closing the session, or losing it, leaves the device running.** Stopping
  is only ever explicit.

## Develop

The wasm builds need Rust stable with the `wasm32-unknown-unknown` target
(each crate's `rust-toolchain.toml`) and `wasm-pack` 0.15:

```bash
npm ci
npm run build:wasm     # wasm/pkg: the language, which ships with the package
npm run build:device   # device/pkg: the Arora device the integration test and the demo run
npm test
npm run demo           # the editor on port 5188
```

Lint, typecheck and the tests read both wasm builds, and a missing build fails
them rather than being skipped; the published package carries `wasm/pkg`. The
unit tests run the language from
`wasm/pkg`, and `src/integration/dataflow-device.test.ts` runs
`fixtures/devices/dataflow.bt` on a real Arora device: `device/` builds
arora-web's browser device over arora's runtime, with the dataflow vocabulary of
`arora-dataflow-nodes` registered as the host module `@arora/dataflow`. The test
drives it through `DeviceRuntime`: a fallback that flips on a distance, a clamped
and offset output, an oscillator on the device's clock, a `damp` converging, a
stop, and edits: the `damp` easing on across an edit of another node, and
restarting when an edit binds it. Traced, the same device shows each node's
status, the detached nodes' activity and the named nodes' values through an
edit, and the trace ends with the behavior.

`src/session/device-session.test.ts` and `src/editor/device-mode.test.tsx`
drive a session and the editor on `fixtures/fake-device.ts`, a device reached
through bridge clients held in memory, whose interpreter loads, edits, reads
and traces its behavior and keeps its revision. `src/integration/device-session.test.ts`
runs a session on the Arora device above, in the page, through
`fixtures/page-bridge.ts`: it reads the device's behavior and its revision,
runs and edits it, and tells another client's change.

`src/text/files.test.ts` reads every example back through each graph format,
and a tree back through Groot, as the same graph; `fixtures/files` holds one
file per format, and a Groot tree with an unconnected port (`res=""`).

The demo offers the NGBT spectrum's examples on its start screen, each on a
mock device seeded for it, and `dataflow.bt` on that Arora device. Its bar
connects to a running Arora device's open local bridge (`ws://127.0.0.1:9000`
by default), or to that Arora device in the page through a bridge client of
its own (`fixtures/page-bridge.ts`); every file, examples included, then works
on that device. A device carrying `@arora/dataflow` runs `dataflow.bt`; the
spectrum's examples call the mock's math module, and are marked as not
running there.

`npm run lint:rust` and `npm run test:rust` check the crates. The language's
tests run in release, as its wasm is built: its nesting limit is set for a
release build's stack use. The device's run natively, where the runtime runs
without a guest module, which the device has none of.

The crates take their dependencies from crates.io and run every cargo command
with `--locked`, so a change to a `Cargo.toml` without its `Cargo.lock` fails
rather than resolving anew.

### End to end

`npm run test:e2e` runs the demo in Chromium with Playwright (`e2e/`,
`playwright.config.ts`). It needs both wasm builds and Chromium
(`npx playwright install chromium`); it builds `e2e/device` and serves the demo
itself, on port 5287.

`e2e/device` is a native Arora device carrying `@arora/dataflow` (the in-page
device's host module), its inputs seeded as the demo's dataflow example
expects. The suite starts it on two free loopback ports, each serving the open
local bridge: the editor connects to the first, and the test's own client
(`e2e/test-client.ts`) to the second, since a bridge serves one client at a
time. Through that client a test sets the device up, changes its behavior as
another client would, and reads what it runs and holds.

The suite covers:

- an example calling functions the device lacks: the banner names them, Run is
  disabled, and nothing ticks in the page;
- the dataflow example run on the device, its node states and the device's
  tick; a live edit that keeps a `damp`'s state; Apply counting the changes
  held with live edits off;
- another client's change, told, and the device's behavior reloaded;
- the device's behavior opened from the start screen, and from the header as
  the file the editor ran there, with its names;
- disconnecting, which leaves the device running its behavior at the same
  revision, and the editor back on its simulated runtime;
- with no device: the start screen, an example simulated with its outputs and
  values, the Text tab, and saving as JSON, YAML and Groot, then opening the
  download again.

Each step waits on what the page or the device states, never on a fixed delay.
A failing run keeps its trace (`npx playwright show-trace`); CI uploads the
report and the traces.

## License

Apache-2.0
