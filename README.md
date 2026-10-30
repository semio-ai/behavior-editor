# @semio/behavior-editor

An editor for Arora behaviors: a behavior tree and the detached nodes beside
it, as a diagram and as text, each editing the other, run live on an Arora: a
local one in the page, or a device connected to. Without an Arora it edits,
opens and saves, and runs nothing. Stand-alone: React is its only peer
dependency.

The text is the language of `arora-behavior-tree`'s `text` module, compiled to
wasm and shipped with the package, so the editor reads a file exactly as the
device does:

```text
fallback                                       # the first node is the root
  sequence
    equal(a: {person/visible}, b: true)        # {key}: a store key
    equal(a: @fresh._ret, b: true)             # @node._ret: a node's return value
  succeed

fresh: not(in: {social/greeted})               # no node holds it: a detached node
level: {face/level} = add(operand_0: @cm._ret, operand_1: 1f32)  # its return value written to a key
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

So given, the editor runs nothing: a behavior runs on an Arora. A host offers
the local Arora, an Arora device in the page, through its own entry point,
and a device connected to through a `DeviceSession` (below):

```tsx
import { createLocalArora } from "@semio/behavior-editor/local-arora";
import initDevice, * as device from "@semio/behavior-editor/device";

await initDevice();
const localArora = () => createLocalArora(device, language, { inputs, values });

<BehaviorEditor language={language} localArora={localArora} startLocalArora />;
```

The local Arora is opt-in: hosts that do not run behaviors in the page do not
load its device. `@semio/behavior-editor/device` is the device's wasm build,
arora-web's browser device over arora's runtime, with the dataflow vocabulary
of `arora-dataflow-nodes` registered as the host module `@arora/dataflow`:
about 5.6 MB, 1.6 MB gzipped, 1.1 MB with Brotli, against the language's
2.2 MB. `initDevice()` fetches it as `initBehaviorText()` fetches the
language's.

| Prop | |
|---|---|
| `language` | The language service: `createBehaviorText(wasm)`, or any `BehaviorText`. |
| `session` | A `DeviceSession` with an Arora the host connected to: while it is connected, or lost and connecting again, the editor is on it (below), whatever file is open, an example as any other. |
| `localArora` | Start a local Arora: a function making its session, as `createLocalArora` does. The header offers it while no Arora is attached, and the editor keeps it, its behavior and store, until it unmounts. |
| `startLocalArora` | Whether to start the local Arora as the editor mounts (default `false`). |
| `text`, `onTextChange` | The file's text, for a controlled editor. |
| `defaultText` | The text an uncontrolled editor starts from. With neither it nor `text`, the editor opens on its start screen. |
| `fileName` | The name a new file is saved under; its extension says its format. |
| `examples` | The behaviors the start screen offers, each a `BehaviorExample`: its `title`, `fileName` and `text`, and the `plotKeys` it plots. Each opens as any file does, on whichever Arora is attached. None by default. |
| `moduleNames` | Names the palette shows for module ids. |
| `plotKeys` | The store keys plotted from the start. |

The editor:

- opens, with no behavior, on a start screen: a new behavior, a file to open,
  the files opened lately, and the examples the host gives. With an Arora
  attached, every file works on it, and the start screen marks the examples
  that cannot run there, which still open to be read. Once a file is open, the
  File menu holds New, Open, the recent files, Save, Save As and Close, which
  goes back to the start screen; each asks before discarding unsaved changes.
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
  does not hold exactly, is an error. With no Arora attached, no function
  index says what a module call calls: what the resolver says of those calls
  is left out, and the header says so; the natives and the rest of the text
  are checked as ever.
- plots the keys chosen. It lists the store's keys and the keys the behavior
  reads, set or not, and edits with fields, sliders and switches the ones the
  Arora's key meta opens to a person, save a key the behavior publishes after
  every tick. A number's slider spans the bounds the Arora declares, within
  its type's limits. A key a tree node writes stays editable, marked as such,
  and a write the Arora applies at its next step shows as pending until then.
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
it holds: a readable graph is resolved against the attached Arora's functions
(by names, by ids, or both, as `arora-behavior-tree`'s `readable` reads it),
so it opens only with an Arora attached; a
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

## Running a behavior

What runs is the graph resolving the text gives,
`arora_behavior::graph::Graph` in graph format behavior-tree 2.0
(`arora-behavior-tree` 10). Its nodes are a list, each with its function,
its children, and its bindings: for each port, the value, store key or other
node's port feeding it, or the key its output is written to.

A behavior runs on an Arora's interpreter, through the Arora's own call
path, as any client's call reaches it: `LOAD` (`language.loadCall`) makes a
graph the Arora's behavior, ticked at every step and re-evaluated once it
completes, every node starting afresh; `EDIT` (`language.editCall`) applies a
`GraphDiff` from the graph running to the next (`language.diff`, arora's
`Graph::diff`): the nodes the diff sets whole or binds a port of restart, and
every other node keeps its state, so a `sequence_star` stays at the child it
had reached and a `damp` goes on easing from its value. Loading the empty
graph stops it. There is one set of semantics, the interpreter's: a file runs
the same on the local Arora and on any device carrying the functions it
calls.

- `DeviceRuntime` runs a behavior on an Arora device so: `start` loads it,
  `edit` edits it, `stop` loads the empty graph. It takes the device as an
  `AroraDevice`: describe its methods, call one, write its inputs, list its
  keys, read its store and step it, each answering when it returns or with a
  promise, values as the JSON of Arora's `Value`. A device on its own clock
  (`ownClock`) is not stepped: a step waits for the device's next one, and
  reports what changed since the last step it saw, which may span several of
  the device's.

  Given the language as `trace`, it follows the behavior's nodes through a
  trace (arora-behavior's `docs/trace.md`): `start` calls the interpreter's
  `TRACE` (`language.traceCall`), watching the outputs of the nodes the text
  names and of the detached nodes, and every step folds the reports the trace
  wrote since (`language.traceReport`) into each node's status, each detached
  node's activity (called, answered from its cache, or not reached) and each
  watched node's return value. A report that follows one not read, or an edit
  that changes the nodes watched, starts the trace over, its first report
  stating every node anew; `stop` halts it. A device whose interpreter does
  not trace shows its store alone. A device on its own clock may write
  several reports between two steps followed, so it gives every value the
  feedback key took (`takeValues`), and the runtime reads them all.
- `BridgeDevice` is an `AroraDevice` over any `BridgeClient` (below): it reads
  the device's keys and values as it is taken up (`BridgeDevice.over(client)`),
  keeps the store current from what the device pushes, and reads it whole
  again at each step, as a device pushes what it sets and not what it unsets.
  On its own clock, a step waits for the next push carrying `arora/time`, or
  answers after its `dtMs` when the device does not step; over a client that
  steps its device (`BridgeClient.step`), a step steps it. `takeValues` gives
  every value a key was pushed since it last asked, the last 256 of them. A
  bridge unsets no key, so writing `null` is refused.

## On an Arora

The editor works on an Arora through a `DeviceSession`, the local Arora's and
a connected device's alike. The library does not own the transport: a
session runs over a `BridgeClient`, the operations any remote client of an
Arora device has, named after `arora_bridge`'s `BridgeOp`s, and the values
the device pushes as it steps. A host implements it over whatever reaches its
devices, Semio Studio's bridge, a ROS 2 bridge, or takes the one for a
device's open local bridge from `@semio/behavior-editor/websocket`. The local
Arora's is `PageBridge`, of `@semio/behavior-editor/local-arora`, over a
device in the page.

```ts
interface BridgeClient {
  describeMethods(prefix?: string): Promise<MethodSignature[]>; // BridgeOp::DescribeMethods
  call(call: Call): Promise<CallResult>;                        // BridgeOp::Call
  readValues(keys: readonly string[]): Promise<Record<string, Value>>; // BridgeOp::Get
  writeValues(values: Record<string, Value>): Promise<void>;    // BridgeOp::Update
  listKeys(prefix?: string): Promise<BridgeKey[]>;              // BridgeOp::ListKeys
  onValues(listener: (values: Record<string, Value>) => void, prefixes?: readonly string[]): () => void;
  step?(dtMs: number): Promise<void>;   // a device the page steps: the local Arora's
  close(): void;                        // the device goes on running its behavior
  readonly closed: Promise<BridgeClosure>; // why it ended: closed, refused or lost
}
```

A device steps itself and pushes what each step set; a client steps it only
where it offers `step`, as the local Arora's does, whose device the page
steps. An answer and the pushes keep the order the device sent them in. A
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
| `on("state" \| "behaviorChanged" \| "tick" \| "error" \| "clock", listener)` | each change of state; each change of the device's behavior, and whether another client made it; each step followed, with the report, the device's status and its keys; a step that failed; each change of a driven clock |
| `clock` | `self`, a device stepping on its own clock, as every remote one does; or `driven`, a device the session steps, as the local Arora is |
| `play()`, `pause()`, `step()`, `setRate(hz)`, `clockState` | on a driven clock: step the device at the rate, hold it, step it once, set the rate (each step lasting one period of it) |
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

A session following a device on its own clock samples it `rate` times a
second (30 by default). A session driving its device's clock steps it that
often while it plays, each step lasting one period of the rate, and holds it
while paused, stepping it once at each `step()`. The local Arora answers a
call, a load, an edit or a read of its behavior, by a step of no time, which
ticks its behavior once without moving its clock, as arora-web applies an
operation on a device nobody steps.

### The editor on an Arora

- **The Arora attached is where everything opened works.** A new file, a
  file opened, a recent file or an example: each works on the Arora attached,
  the connected one while it is connected or connecting again, otherwise the
  local one while it runs. With neither, the editor edits, opens and saves,
  and runs nothing.
- **The header names the Arora attached:** **Local Arora**, which the page
  steps, with Play, Pause, Step and the rate (10, 30 or 60 Hz); **Device**
  and what the session is connected to, which steps itself, its tick, step
  rate and clock showing where Play would; or **No Arora**, with **Start a
  local Arora** when the host offers one.
- **A file opened on the local Arora runs there at once**, as soon as it runs
  at all: the local Arora is the page's own, and nothing else runs on it. A
  device, and an Arora attached while a file is open, run the file only when
  the person asks: what they run is not the editor's to replace unasked.
- **Letting go of a device leaves the local Arora**, when it runs, as it was
  left: its behavior and store kept while the device was attached; otherwise
  no Arora.
- **The Arora's behavior opens from the header and the start screen.**
  While an Arora is attached, **Device's behavior** beside where the
  behavior runs, and **Open the device's behavior** beside Open… on the start
  screen, read what the device runs now and open it: as the file the editor
  ran there, with its names, when one has its graph; otherwise as a file
  whose nodes are named by their ids. The header's button asks before
  discarding unsaved changes, and is disabled, saying why, on a device that
  does not report its behavior.
- **Attaching is read-only.** The editor reads what the Arora runs, and
  follows its tick, step rate, clock and revision.
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
npm run build:device   # device/pkg: the local Arora's device, which ships with the package
npm test
npm run demo           # the editor on port 5188
```

Both wasm builds are release builds, the device's through `wasm-opt`, as the
package ships them. Lint, typecheck and the tests read both, and a missing
build fails them rather than being skipped.

The examples (`fixtures/examples`, listed in `fixtures/examples.ts` with the
inputs each reads and the values they start from) call `@arora/dataflow`'s
functions and the natives, and nothing else: the NGBT spectrum's (a pure
mapping, breathing on the clock, a greeting around dataflow, three readers
under a parallel and under a fallback, the order of writes and reads within a
tick, return values) and a dataflow example on a distance. Truthiness is the
native `equal(a: …, b: true)`, a wait is a fallback of a condition and
`running`, a timer a `slew` climbing at one a second, and the value a leaf
writes is an `add` of one operand. `src/integration/spectrum.test.ts` runs
each on the local Arora through its session and pins what it shows of the
interpreter: a detached node called when its arguments changed and answered
from its cache otherwise, readers under a parallel all asked and under a
fallback the rest never asked, a node brought up to date at its first read in
a tick and reused after, a damp whose state is the key it eases, return
values read and written. `src/text/examples.test.ts` checks each parses,
resolves against `@arora/dataflow` and formats as written, and
`src/text/files.test.ts` reads each back through each graph format, and a
tree back through Groot, as the same graph; `fixtures/files` holds one file
per format, and a Groot tree with an unconnected port (`res=""`).

`src/integration/local-arora.test.ts` drives the local Arora's clock: held
while paused, a step a period of the rate, steps at the rate while it plays,
and a page device stepping itself as a device on its own clock.
`src/integration/dataflow-device.test.ts` runs the dataflow example through
`DeviceRuntime` on the device directly: a fallback that flips on a distance, a
clamped and offset output, an oscillator on the device's clock, a `damp`
converging, a stop, and edits that keep or restart the `damp`'s state, then
the same through a trace.

`src/session/device-session.test.ts` and `src/editor/device-mode.test.tsx`
drive a session and the editor on `fixtures/fake-device.ts`, a device reached
through bridge clients held in memory, whose interpreter loads, edits, reads
and traces its behavior and keeps its revision, beside the local Arora the
editor goes back to. The editor's other tests run on the local Arora
(`fixtures/local-arora.ts`), paused, a test stepping it.

The demo starts on a local Arora seeded with every example's inputs, so each
example runs as it opens. Its bar connects to a running Arora device's open
local bridge (`ws://127.0.0.1:9000` by default); every file, examples
included, then works on that device, and disconnecting goes back to the
local Arora as it was left.

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

`e2e/device` is a native Arora device carrying `@arora/dataflow` (the local
Arora's host module), its inputs seeded as the demo's dataflow example
expects. The suite starts it on two free loopback ports, each serving the open
local bridge: the editor connects to the first, and the test's own client
(`e2e/test-client.ts`) to the second, since a bridge serves one client at a
time. Through that client a test sets the device up, changes its behavior as
another client would, and reads what it runs and holds.

The suite covers:

- every example marked as running on the device, and a file calling a
  function the device lacks: the banner names it, Run is disabled, and
  nothing ticks in the page;
- an example run on the local Arora, then the same file run on the device,
  which runs it as the local Arora did;
- the dataflow example run on the device, its node states and the device's
  tick; a live edit that keeps a `damp`'s state; Apply counting the changes
  held with live edits off;
- another client's change, told, and the device's behavior reloaded;
- the device's behavior opened from the start screen, and from the header as
  the file the editor ran there, with its names;
- disconnecting, which leaves the device running its behavior at the same
  revision, and the editor back on the local Arora;
- on the local Arora: the start screen, an example with its outputs and
  values, paused and stepped, the Text tab, and saving as JSON, YAML and
  Groot, then opening the download again.

Each step waits on what the page or the device states, never on a fixed delay.
A failing run keeps its trace (`npx playwright show-trace`); CI uploads the
report and the traces.

## License

Apache-2.0
