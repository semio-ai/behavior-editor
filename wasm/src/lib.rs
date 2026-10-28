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

use arora_behavior::graph::Graph;
use arora_behavior::interpreter_module::encode_load;
use arora_behavior::{FunctionIndex, ModuleFunction};
use arora_behavior_tree::text;
use arora_types::record::module::frozen::Function;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;
use wasm_bindgen::prelude::*;

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
/// completes, and it replaces the previous one, keeping the state of the nodes
/// the new graph left in place. The empty graph loads no behavior.
#[wasm_bindgen(js_name = loadCall)]
pub fn load_call(graph_json: &str) -> Result<String, JsError> {
    let graph: Graph = from_json(graph_json).map_err(error)?;
    serde_json::to_string(&encode_load(&graph)).map_err(error)
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

/// A text's byte offsets as UTF-16 offsets and 1-based lines and columns.
struct Utf16Lines<'a> {
    text: &'a str,
    /// The byte offset each line starts at.
    starts: Vec<usize>,
}

impl<'a> Utf16Lines<'a> {
    fn new(text: &'a str) -> Self {
        let starts = std::iter::once(0)
            .chain(text.match_indices('\n').map(|(at, _)| at + 1))
            .collect();
        Self { text, starts }
    }

    /// The UTF-16 offset of the byte offset `at`, clamped to the text and
    /// moved back to a character boundary.
    fn utf16(&self, at: usize) -> usize {
        let mut at = at.min(self.text.len());
        while !self.text.is_char_boundary(at) {
            at -= 1;
        }
        self.text[..at].encode_utf16().count()
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
    fn a_load_call_targets_the_interpreter() {
        let graph = r#"{"nodes":{},"links":[],"variables":{}}"#;
        let call: Value = serde_json::from_str(&load_call(graph).unwrap()).unwrap();
        assert_eq!(call["module_id"], "61726f72-6100-0000-0000-000000000001");
        assert_eq!(call["id"], "61726f72-6100-0000-0000-000000000004");
        assert_eq!(
            call["args"][0]["id"],
            "61726f72-6100-0000-0000-000000000005"
        );
    }
}
