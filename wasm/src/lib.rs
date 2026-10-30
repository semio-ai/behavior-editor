//! The behavior text language for the browser: `arora-behavior-tree`'s
//! `text` module behind wasm-bindgen, every value crossing as JSON.
//!
//! Spans cross as UTF-16 code-unit offsets, which index a JavaScript string,
//! with the 1-based `line` and `column` of their start: `parse` converts the
//! byte offsets Rust keeps, and a document coming back from JavaScript keeps
//! the offsets it was given, so what `resolve` reports about it is in the same
//! units. `format` and `resolve` take the device's functions as
//! `describeMethods` lists them, `MethodSignature[]`.

use std::collections::HashMap;

use arora_behavior::graph::{Graph, GraphDiff};
use arora_behavior::interpreter_module::{
    decode_read_result, decode_spawn_result, encode_edit, encode_load, encode_read, encode_trace,
};
use arora_behavior::trace::{decode_report, TraceOptions};
use arora_behavior::{FunctionIndex, ModuleFunction};
use arora_behavior_tree::text;
use arora_types::record::module::frozen::Function;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;
use wasm_bindgen::prelude::*;

mod files;

/// A function as a device's `describeMethods` lists it.
#[derive(Serialize, Deserialize)]
struct MethodSignature {
    module_id: Uuid,
    id: Uuid,
    name: String,
    function: Function,
}

fn error(message: impl std::fmt::Display) -> JsError {
    JsError::new(&message.to_string())
}

/// Parse a file: `{ document, diagnostics }`, spans in UTF-16 offsets.
#[wasm_bindgen]
pub fn parse(text: &str) -> Result<String, JsError> {
    let parsed = text::parse(text);
    let mut value = json!({ "document": parsed.document, "diagnostics": parsed.diagnostics });
    let lines = Utf16Lines::new(text);
    for_each_span(&mut value, &mut |span| lines.convert(span));
    Ok(value.to_string())
}

/// A parse result's text in the canonical layout, its arguments in the order
/// of `functions_json`'s parameters. A parse with errors, or a document
/// nested deeper than the language allows, is refused: the error's message
/// is the JSON of its diagnostics.
#[wasm_bindgen]
pub fn format(parsed_json: &str, functions_json: &str) -> Result<String, JsError> {
    let parsed: text::Parsed = from_json(parsed_json).map_err(error)?;
    text::format(&parsed, &index(functions_json)?)
        .map_err(|diagnostics| error(serde_json::to_string(&diagnostics).unwrap_or_default()))
}

/// Resolve a document against `functions_json`: `{ graph, nodes, diagnostics }`.
#[wasm_bindgen]
pub fn resolve(document_json: &str, functions_json: &str) -> Result<String, JsError> {
    let mut document: Value = from_json(document_json).map_err(error)?;
    // Every span of a resolved node or diagnostic starts where one of the
    // document's does: its line and column are that one's.
    let mut places = HashMap::new();
    for_each_span(&mut document, &mut |span| {
        if let (Some(start), Some(line), Some(column)) = (
            span.get("start").cloned(),
            span.get("line").cloned(),
            span.get("column").cloned(),
        ) {
            places.insert(start.to_string(), (line, column));
        }
    });
    let document: text::Document = serde_json::from_value(document).map_err(error)?;
    let loaded = text::resolve(&document, &index(functions_json)?);
    let mut nodes = serde_json::to_value(&loaded.nodes).map_err(error)?;
    let mut diagnostics = serde_json::to_value(&loaded.diagnostics).map_err(error)?;
    let mut place = |span: &mut serde_json::Map<String, Value>| {
        let (line, column) = span
            .get("start")
            .and_then(|start| places.get(&start.to_string()).cloned())
            .unwrap_or((json!(0), json!(0)));
        span.insert("line".into(), line);
        span.insert("column".into(), column);
    };
    for_each_span(&mut nodes, &mut place);
    for_each_span(&mut diagnostics, &mut place);
    Ok(json!({ "graph": loaded.graph, "nodes": nodes, "diagnostics": diagnostics }).to_string())
}

/// The native nodes, as `MethodSignature[]`.
#[wasm_bindgen]
pub fn natives() -> Result<String, JsError> {
    let natives: Vec<MethodSignature> = text::natives().map(signature).collect();
    serde_json::to_string(&natives).map_err(error)
}

/// The `Call` JSON that loads `graph_json` as a device's behavior:
/// `arora_behavior::interpreter_module`'s `load`. The loaded behavior is the
/// interpreter's main one, ticked at every tick and re-evaluated once it
/// completes, and it replaces the previous one, restarting every node of the
/// behavior. The empty graph loads no behavior.
#[wasm_bindgen(js_name = loadCall)]
pub fn load_call(graph_json: &str) -> Result<String, JsError> {
    let graph: Graph = from_json(graph_json).map_err(error)?;
    serde_json::to_string(&encode_load(&graph)).map_err(error)
}

/// The diff that takes `previous_json`, a graph, to `next_json`: the nodes
/// only `next` has, or whose function or children change, set whole; one
/// binding per port whose binding changes; the root when it changes
/// (`Graph::diff`). An interpreter applying it restarts the nodes it sets or
/// binds, and keeps the state of every other.
#[wasm_bindgen]
pub fn diff(previous_json: &str, next_json: &str) -> Result<String, JsError> {
    let previous: Graph = from_json(previous_json).map_err(error)?;
    let next: Graph = from_json(next_json).map_err(error)?;
    serde_json::to_string(&previous.diff(&next)).map_err(error)
}

/// The `Call` JSON that applies `diff_json`, a graph diff, to a device's
/// behavior: `arora_behavior::interpreter_module`'s `edit`, which keeps the
/// state of the nodes the diff leaves in place.
#[wasm_bindgen(js_name = editCall)]
pub fn edit_call(diff_json: &str) -> Result<String, JsError> {
    let diff: GraphDiff = from_json(diff_json).map_err(error)?;
    serde_json::to_string(&encode_edit(&diff)).map_err(error)
}

/// The `Call` JSON that starts a trace of a device's behavior, under
/// `options_json`, a `TraceOptions` (`values`: the nodes whose outputs the
/// reports carry; `min_interval_ns`: the least time between two reports):
/// `arora_behavior::interpreter_module`'s `TRACE`.
#[wasm_bindgen(js_name = traceCall)]
pub fn trace_call(options_json: &str) -> Result<String, JsError> {
    let options: TraceOptions = from_json(options_json).map_err(error)?;
    serde_json::to_string(&encode_trace(&options)).map_err(error)
}

/// The `Call` JSON that reads a device's behavior:
/// `arora_behavior::interpreter_module`'s `READ`, which answers the graph the
/// interpreter runs, in the form `load` takes, and its revision.
#[wasm_bindgen(js_name = readCall)]
pub fn read_call() -> Result<String, JsError> {
    serde_json::to_string(&encode_read()).map_err(error)
}

/// The behavior a `READ` answered, out of its `CallResult` JSON:
/// `{ graph, revision }`, the graph's JSON as `load_call` takes it.
#[wasm_bindgen(js_name = readResult)]
pub fn read_result(result_json: &str) -> Result<String, JsError> {
    let result: arora_types::call::CallResult = from_json(result_json).map_err(error)?;
    let behavior = decode_read_result(&result.ret).map_err(error)?;
    serde_json::to_string(&json!({ "graph": behavior.graph, "revision": behavior.revision }))
        .map_err(error)
}

/// The trace's `TaskHandle` JSON (`id`, the `stop` call, the `status` key,
/// the `feedback` keys) out of the `CallResult` JSON a `TRACE` call answered.
#[wasm_bindgen(js_name = traceHandle)]
pub fn trace_handle(result_json: &str) -> Result<String, JsError> {
    let result: arora_types::call::CallResult = from_json(result_json).map_err(error)?;
    let handle = decode_spawn_result(&result.ret).map_err(error)?;
    serde_json::to_string(&handle).map_err(error)
}

/// A trace report, out of the `Value` JSON its feedback key holds: the
/// `TraceReport` JSON (`tick`, `since`, `status` and `activity` as
/// `[node, name]` pairs, `values` as `{ node, port, value }`, `restarted`).
#[wasm_bindgen(js_name = traceReport)]
pub fn trace_report(value_json: &str) -> Result<String, JsError> {
    let value: arora_types::value::Value = from_json(value_json).map_err(error)?;
    serde_json::to_string(&decode_report(&value).map_err(error)?).map_err(error)
}

/// A behavior file as the text the editor edits: `file` a readable graph in
/// `format` (`json` or `yaml`), its names resolved against `functions_json`
/// and the natives, or a Groot tree (`groot`). Answers `{ text }`, or
/// `{ problems }` when the file does not load, each problem with its place:
/// `line` and `column`, or `at`, the path of a reference in the file.
#[wasm_bindgen(js_name = openFile)]
pub fn open_file(file: &str, format: &str, functions_json: &str) -> Result<String, JsError> {
    let functions = index(functions_json)?;
    let outcome = match format {
        "groot" => files::open_groot(file, &functions),
        other => files::open_graph(file, graph_format(other)?, &functions),
    };
    outcome_json(outcome)
}

/// A resolved behavior as a file in `format`: a readable graph in JSON or
/// YAML, each node by `names_json` (`{ "<node id>": "<name or path>" }`),
/// each function and port by its name; or a Groot tree (`groot`). Answers
/// `{ text }`, or `{ problems }` naming what the format cannot hold, a file
/// that would not open again among them.
#[wasm_bindgen(js_name = writeFile)]
pub fn write_file(
    graph_json: &str,
    names_json: &str,
    format: &str,
    functions_json: &str,
) -> Result<String, JsError> {
    let graph: Graph = from_json(graph_json).map_err(error)?;
    let names: HashMap<Uuid, String> = from_json(names_json).map_err(error)?;
    let functions = index(functions_json)?;
    let outcome = match format {
        "groot" => files::write_groot(&graph, &names, &functions),
        other => files::write_graph(&graph, &names, graph_format(other)?, &functions),
    };
    outcome_json(outcome)
}

fn graph_format(name: &str) -> Result<files::GraphFormat, JsError> {
    files::GraphFormat::named(name)
        .ok_or_else(|| error(format!("no file format `{name}`: json, yaml or groot")))
}

fn outcome_json(outcome: files::Outcome) -> Result<String, JsError> {
    let value = match outcome {
        Ok(text) => json!({ "text": text }),
        Err(problems) => json!({ "problems": problems }),
    };
    Ok(value.to_string())
}

/// `json` read as a `T`, however deep the language lets it nest. serde_json
/// stops at 128 levels by default, and a document's JSON nests several levels
/// for each of the language's (`text::MAX_DEPTH`), which bounds the recursion.
fn from_json<T: DeserializeOwned>(json: &str) -> Result<T, serde_json::Error> {
    let mut reader = serde_json::Deserializer::from_str(json);
    reader.disable_recursion_limit();
    let value = T::deserialize(&mut reader)?;
    reader.end()?;
    Ok(value)
}

fn signature(function: &ModuleFunction) -> MethodSignature {
    MethodSignature {
        module_id: function.module_id,
        id: function.function_id,
        name: function.function_name.clone(),
        function: function.function.clone(),
    }
}

/// The function index `functions_json`, a `MethodSignature[]`, describes.
fn index(functions_json: &str) -> Result<FunctionIndex, JsError> {
    let signatures: Vec<MethodSignature> = from_json(functions_json).map_err(error)?;
    Ok(signatures
        .into_iter()
        .map(|s| {
            (
                s.id,
                ModuleFunction {
                    module_id: s.module_id,
                    function_id: s.id,
                    function_name: s.name,
                    function: s.function,
                },
            )
        })
        .collect())
}

/// Call `visit` on every span in `value`: an object with a numeric `start` and
/// `end`, and nothing but its line and column besides.
fn for_each_span(value: &mut Value, visit: &mut dyn FnMut(&mut serde_json::Map<String, Value>)) {
    match value {
        Value::Object(map) => {
            let is_span = map.get("start").is_some_and(Value::is_u64)
                && map.get("end").is_some_and(Value::is_u64)
                && map
                    .keys()
                    .all(|k| matches!(k.as_str(), "start" | "end" | "line" | "column"));
            if is_span {
                visit(map);
            } else {
                for child in map.values_mut() {
                    for_each_span(child, visit);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                for_each_span(item, visit);
            }
        }
        _ => {}
    }
}

/// A text's byte offsets as UTF-16 offsets and 1-based lines and columns,
/// each conversion a lookup in tables built once per text.
struct Utf16Lines {
    /// The byte offset each line starts at.
    starts: Vec<usize>,
    /// The UTF-16 offset of each byte offset, up to and including the text's
    /// length; a byte inside a character maps to that character's start.
    units: Vec<usize>,
}

impl Utf16Lines {
    fn new(text: &str) -> Self {
        let starts = std::iter::once(0)
            .chain(text.match_indices('\n').map(|(at, _)| at + 1))
            .collect();
        let mut units = Vec::with_capacity(text.len() + 1);
        let mut count = 0;
        for c in text.chars() {
            units.extend(std::iter::repeat_n(count, c.len_utf8()));
            count += c.len_utf16();
        }
        units.push(count);
        Self { starts, units }
    }

    /// The UTF-16 offset of the byte offset `at`, clamped to the text and
    /// moved back to a character boundary.
    fn utf16(&self, at: usize) -> usize {
        self.units[at.min(self.units.len() - 1)]
    }

    fn convert(&self, span: &mut serde_json::Map<String, Value>) {
        let byte = |key: &str| span.get(key).and_then(Value::as_u64).unwrap_or(0) as usize;
        let (start, end) = (byte("start"), byte("end"));
        let line = self.starts.partition_point(|&s| s <= start).max(1);
        let line_start = self.starts[line - 1];
        let column = self.utf16(start) - self.utf16(line_start) + 1;
        span.insert("start".into(), json!(self.utf16(start)));
        span.insert("end".into(), json!(self.utf16(end)));
        span.insert("line".into(), json!(line));
        span.insert("column".into(), json!(column));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use arora_behavior::interpreter_module::{
        decode_trace, encode_read_result, encode_spawn_result, READ, TRACE,
    };
    use arora_behavior::trace::{encode_report, Activity, NodeStatus, PortValue, TraceReport};
    use arora_behavior::TaskHandle;

    /// The return value's port, `_ret`.
    const RET: Uuid = Uuid::from_u128(0x5f726574_0000_4000_8000_000000000000);

    #[test]
    fn a_trace_call_carries_its_options() {
        let node = Uuid::from_u128(7);
        let call = trace_call(&json!({ "values": [node], "min_interval_ns": 5 }).to_string())
            .map_err(|_| "refused")
            .unwrap();
        let call: arora_types::call::Call = serde_json::from_str(&call).unwrap();
        assert_eq!(call.id, TRACE);
        assert_eq!(
            decode_trace(&call).unwrap(),
            TraceOptions {
                values: vec![node],
                min_interval_ns: Some(5),
            }
        );
    }

    #[test]
    fn a_trace_handle_is_read_from_the_call_s_result() {
        let handle = TaskHandle {
            id: arora_behavior::TaskId(Uuid::from_u128(9)),
            stop: arora_behavior::interpreter_module::encode_halt(arora_behavior::TaskId(
                Uuid::from_u128(9),
            )),
            status: "arora/tasks/t/status".into(),
            feedback: vec!["arora/tasks/t/feedback".into()],
            result: vec![],
            update: vec![],
        };
        let result = arora_types::call::CallResult {
            ret: encode_spawn_result(&handle),
            mutated: vec![],
        };
        let read = trace_handle(&serde_json::to_string(&result).unwrap())
            .map_err(|_| "refused")
            .unwrap();
        let read: TaskHandle = serde_json::from_str(&read).unwrap();
        assert_eq!(read, handle);
    }

    #[test]
    fn a_read_call_reads_the_behavior_and_its_answer_gives_graph_and_revision() {
        let call: arora_types::call::Call =
            serde_json::from_str(&read_call().map_err(|_| "refused").unwrap()).unwrap();
        assert_eq!(call.id, READ);
        assert!(call.args.is_empty());

        let graph: Graph = serde_json::from_value(json!({
            "root": Uuid::from_u128(3),
            "nodes": [{ "id": Uuid::from_u128(3), "function": Uuid::from_u128(4) }],
        }))
        .unwrap();
        let result = arora_types::call::CallResult {
            ret: encode_read_result(&arora_behavior::LoadedBehavior {
                revision: 2,
                graph: graph.clone(),
            }),
            mutated: vec![],
        };
        let read: Value = serde_json::from_str(
            &read_result(&serde_json::to_string(&result).unwrap())
                .map_err(|_| "refused")
                .unwrap(),
        )
        .unwrap();
        assert_eq!(read["revision"], json!(2));
        assert_eq!(read["graph"], serde_json::to_value(&graph).unwrap());
    }

    #[test]
    fn a_trace_report_is_read_from_its_feedback_value() {
        let (a, b) = (Uuid::from_u128(1), Uuid::from_u128(2));
        let report = TraceReport {
            tick: 4,
            since: Some(3),
            status: vec![(a, NodeStatus::Running), (b, NodeStatus::NotReached)],
            activity: vec![(b, Activity::Cached)],
            values: vec![PortValue {
                node: b,
                port: RET,
                value: arora_types::value::Value::F64(0.25),
            }],
            restarted: vec![a],
            revision: Some(7),
        };
        let value = serde_json::to_string(&encode_report(&report)).unwrap();
        let read: Value =
            serde_json::from_str(&trace_report(&value).map_err(|_| "refused").unwrap()).unwrap();
        assert_eq!(
            read,
            json!({
                "tick": 4,
                "since": 3,
                "status": [[a, "running"], [b, "not_reached"]],
                "activity": [[b, "cached"]],
                "values": [{ "node": b, "port": RET, "value": { "f64": 0.25 } }],
                "restarted": [a],
                "revision": 7,
            })
        );
    }

    fn span(start: usize, end: usize) -> Value {
        json!({ "start": start, "end": end })
    }

    #[test]
    fn byte_offsets_become_utf16_offsets_lines_and_columns() {
        // "é" is two bytes and one UTF-16 unit; "😀" four bytes and two units.
        let text = "é😀a\nbc";
        let lines = Utf16Lines::new(text);
        let mut value = json!([span(0, 2), span(2, 6), span(6, 7), span(8, 10)]);
        for_each_span(&mut value, &mut |s| lines.convert(s));
        assert_eq!(
            value,
            json!([
                { "start": 0, "end": 1, "line": 1, "column": 1 },
                { "start": 1, "end": 3, "line": 1, "column": 2 },
                { "start": 3, "end": 4, "line": 1, "column": 4 },
                { "start": 5, "end": 7, "line": 2, "column": 1 },
            ])
        );
    }

    #[test]
    fn an_offset_inside_a_character_or_past_the_text_is_moved_back() {
        let lines = Utf16Lines::new("é😀a\nbc");
        // Byte 1 is inside "é", byte 4 inside "😀"; the text is 7 units long.
        assert_eq!([1, 4, 6, 99].map(|at| lines.utf16(at)), [0, 1, 3, 7]);
    }

    #[test]
    fn a_parsed_document_resolves_with_its_places() {
        let text = "sequence\n  succeed\n\nx: mystery(a: 1)\n";
        let parsed: Value = serde_json::from_str(&parse(text).unwrap()).unwrap();
        let document = parsed["document"].to_string();
        let loaded: Value = serde_json::from_str(&resolve(&document, "[]").unwrap()).unwrap();
        let child = &loaded["nodes"][1];
        assert_eq!(child["path"], "root.0");
        assert_eq!(
            child["span"],
            json!({ "start": 11, "end": 18, "line": 2, "column": 3 })
        );
        let warning = &loaded["diagnostics"][0];
        assert_eq!(warning["span"]["line"], 4, "{loaded}");
    }

    #[test]
    fn a_formatted_document_reads_back() {
        let text = "fallback\n  succeed\n";
        assert_eq!(format(&parse(text).unwrap(), "[]").unwrap(), text);
    }

    #[test]
    fn a_text_nested_past_the_limit_is_reported_not_overflowed() {
        let depth = 10 * text::MAX_DEPTH;
        let text = format!(
            "running\n\nx: {}1{}\n",
            "f(a: ".repeat(depth),
            ")".repeat(depth)
        );
        let parsed: Value = from_json(&parse(&text).unwrap()).unwrap();
        let messages = parsed["diagnostics"].to_string();
        assert!(messages.contains("128"), "{messages}");
        // The refusal itself is a JsError, which only a wasm target can make.
        let document: text::Parsed = serde_json::from_value(parsed).unwrap();
        assert!(text::format(&document, &FunctionIndex::new()).is_err());
    }

    #[test]
    fn natives_list_the_tree_s_own_nodes() {
        let natives: Vec<MethodSignature> = serde_json::from_str(&natives().unwrap()).unwrap();
        let names: Vec<&str> = natives.iter().map(|n| n.name.as_str()).collect();
        assert!(
            names.contains(&"sequence") && names.contains(&"equal"),
            "{names:?}"
        );
        assert!(natives.iter().all(|n| n.module_id.is_nil()));
    }

    #[test]
    fn a_diff_binds_what_changed_and_an_edit_call_carries_it() {
        let text = |limit: u32| format!("sequence\n  equal(a: {{x}}, b: {limit}u32)\n  succeed\n");
        let graph = |limit| {
            let parsed: Value = serde_json::from_str(&parse(&text(limit)).unwrap()).unwrap();
            let loaded: Value =
                serde_json::from_str(&resolve(&parsed["document"].to_string(), "[]").unwrap())
                    .unwrap();
            loaded["graph"].to_string()
        };
        let diff: Value = serde_json::from_str(&diff(&graph(1), &graph(2)).unwrap()).unwrap();
        assert_eq!(
            diff.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["bind"],
            "{diff}"
        );
        assert_eq!(diff["bind"][0]["source"], json!({ "value": { "u32": 2 } }));
        assert_eq!(super::diff(&graph(1), &graph(1)).unwrap(), "{}");
        let call: Value = serde_json::from_str(&edit_call(&diff.to_string()).unwrap()).unwrap();
        assert_eq!(call["id"], "61726f72-6100-0000-0000-000000000002");
        assert_eq!(
            call["args"][0]["id"],
            "61726f72-6100-0000-0000-000000000003"
        );
    }

    #[test]
    fn a_load_call_targets_the_interpreter() {
        let graph = "{}";
        let call: Value = serde_json::from_str(&load_call(graph).unwrap()).unwrap();
        assert_eq!(call["module_id"], "61726f72-6100-0000-0000-000000000001");
        assert_eq!(call["id"], "61726f72-6100-0000-0000-000000000004");
        assert_eq!(
            call["args"][0]["id"],
            "61726f72-6100-0000-0000-000000000005"
        );
    }
}
