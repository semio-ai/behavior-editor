//! Behavior files in the forms other than the text: a readable graph in JSON
//! or YAML (`arora_behavior_tree::readable`), and Groot XML
//! (`schema_groot`). The editor edits a behavior as text, so a file opens as
//! the text of the graph it describes, and a behavior is written from the
//! graph its text resolves to.
//!
//! Each function answers JSON: `{ "text": … }`, or `{ "problems": […] }` when
//! the file does not load or the behavior has no form in the format, each
//! problem with its place: a line and column, or a path in the file
//! (`nodes[2].bind.lo`), or the nodes it is about.

use std::collections::{HashMap, HashSet};

use arora_behavior::graph::{Graph, Source};
use arora_behavior::FunctionIndex;
use arora_behavior_tree::display::Names;
use arora_behavior_tree::graph::build_behavior_tree;
use arora_behavior_tree::schema::{Expression, NodeParameterId, _RET_PARAM_ID};
use arora_behavior_tree::schema_groot;
use arora_behavior_tree::text::{self, Severity};
use arora_behavior_tree::tree_node::TreeNode;
use arora_behavior_tree::{readable, ModuleFunction};
use serde::Deserialize;
use serde::Serialize;
use uuid::Uuid;

/// A reason a file does not load, or a behavior has no form in a format.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Problem {
    pub message: String,
    /// The path in the file a readable graph's reference is written at.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    /// The 1-based line and column the problem is at.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column: Option<usize>,
}

impl Problem {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            at: None,
            line: None,
            column: None,
        }
    }

    fn at_line(message: impl Into<String>, line: usize, column: usize) -> Self {
        Self {
            line: Some(line),
            column: Some(column),
            ..Self::new(message)
        }
    }
}

pub type Outcome = Result<String, Vec<Problem>>;

/// A readable graph's serialization.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GraphFormat {
    Json,
    Yaml,
}

impl GraphFormat {
    pub fn named(name: &str) -> Option<Self> {
        match name {
            "json" => Some(Self::Json),
            "yaml" => Some(Self::Yaml),
            _ => None,
        }
    }
}

/// The text of the readable graph `file` holds, in `format`, its names
/// resolved against `functions` and the natives.
pub fn open_graph(file: &str, format: GraphFormat, functions: &FunctionIndex) -> Outcome {
    let readable = read_graph(file, format).map_err(|problem| vec![problem])?;
    let graph = readable.resolve(functions).map_err(|errors| {
        errors
            .into_iter()
            .map(|error| Problem {
                at: Some(error.at),
                ..Problem::new(error.message)
            })
            .collect::<Vec<_>>()
    })?;
    // A node the file names keeps its name; a node by id is named by its id
    // where the text must name it to give it that id.
    let labels: HashMap<Uuid, String> = readable
        .nodes
        .iter()
        .zip(&graph.nodes)
        // The root by its path, `root`, is unnamed in a text.
        .filter(|(node, resolved)| {
            is_label(&node.id) && !(node.id == "root" && graph.root == Some(resolved.id))
        })
        .map(|(node, resolved)| (resolved.id, node.id.clone()))
        .collect();
    graph_text(&graph, functions, labels, true).map_err(|problem| vec![problem])
}

/// The text of the Groot tree `file` holds, its tags resolved against
/// `functions` and the natives.
pub fn open_groot(file: &str, functions: &FunctionIndex) -> Outcome {
    let groot = schema_groot::BehaviorTree::try_from_groot_xml(file)
        .map_err(|e| vec![groot_problem(file, &e.to_string())])?;
    let graph = groot
        .into_graph(functions)
        .map_err(|e| vec![groot_problem(file, &e.to_string())])?;
    // Groot gives its nodes no ids: the text gives them those of their paths.
    graph_text(&graph, functions, HashMap::new(), false).map_err(|problem| vec![problem])
}

/// `graph` as a readable graph in `format`: each node by `names` (a text's
/// node names, and the paths of the nodes it does not name), each function
/// and port by its name. A graph whose file would not open again is refused.
pub fn write_graph(
    graph: &Graph,
    names: &HashMap<Uuid, String>,
    format: GraphFormat,
    functions: &FunctionIndex,
) -> Outcome {
    let readable = readable::Graph::from_graph(
        graph,
        &Names {
            functions: Some(functions),
            nodes: Some(names),
            ..Names::default()
        },
    );
    let file = match format {
        GraphFormat::Json => serde_json::to_string_pretty(&readable)
            .map(|json| json + "\n")
            .map_err(|e| e.to_string()),
        GraphFormat::Yaml => serde_yaml::to_string(&readable).map_err(|e| e.to_string()),
    }
    .map_err(|e| vec![Problem::new(e)])?;
    // A file is written only when it opens again: one nested deeper than its
    // format reads is refused.
    read_graph(&file, format).map_err(|problem| vec![problem])?;
    Ok(file)
}

/// The deepest a JSON graph file may nest: deeper than serde_json's default
/// of 128, which a value the language nests to its own limit passes once
/// wrapped in the graph, and bounded, so a file cannot exhaust the stack.
const MAX_JSON_DEPTH: usize = 4 * text::MAX_DEPTH;

/// The readable graph `file` holds in `format`. YAML nests at most 128 deep,
/// serde_yaml's fixed limit; JSON at most `MAX_JSON_DEPTH`.
fn read_graph(file: &str, format: GraphFormat) -> Result<readable::Graph, Problem> {
    match format {
        GraphFormat::Json => {
            if json_depth(file) > MAX_JSON_DEPTH {
                return Err(Problem::new(format!(
                    "not a graph in JSON: it nests deeper than {MAX_JSON_DEPTH} levels"
                )));
            }
            let mut reader = serde_json::Deserializer::from_str(file);
            reader.disable_recursion_limit();
            readable::Graph::deserialize(&mut reader)
                .and_then(|graph| reader.end().map(|()| graph))
                .map_err(|e| {
                    Problem::at_line(format!("not a graph in JSON: {e}"), e.line(), e.column())
                })
        }
        GraphFormat::Yaml => serde_yaml::from_str(file).map_err(|e| {
            let (line, column) = e.location().map_or((0, 0), |at| (at.line(), at.column()));
            Problem {
                line: (line > 0).then_some(line),
                column: (line > 0).then_some(column),
                ..Problem::new(format!("not a graph in YAML: {e}"))
            }
        }),
    }
}

/// How deep `json`'s arrays and objects nest, read off its brackets outside
/// its strings.
fn json_depth(json: &str) -> usize {
    let (mut depth, mut deepest) = (0usize, 0usize);
    let (mut in_string, mut escaped) = (false, false);
    for byte in json.bytes() {
        if in_string {
            match byte {
                _ if escaped => escaped = false,
                b'\\' => escaped = true,
                b'"' => in_string = false,
                _ => {}
            }
            continue;
        }
        match byte {
            b'"' => in_string = true,
            b'[' | b'{' => {
                depth += 1;
                deepest = deepest.max(depth);
            }
            b']' | b'}' => depth = depth.saturating_sub(1),
            _ => {}
        }
    }
    deepest
}

/// `graph` as a Groot tree, or what in it Groot cannot hold: a node the tree
/// does not hold, a binding reading another node, a node's name, an id other
/// than its path's. `names` names each node, as the text does or by its path.
/// A tree is written only when it opens again as `graph`.
pub fn write_groot(
    graph: &Graph,
    names: &HashMap<Uuid, String>,
    functions: &FunctionIndex,
) -> Outcome {
    let label = |id: &Uuid| {
        names
            .get(id)
            .map_or_else(|| id.to_string(), |name| format!("`{name}`"))
    };
    let Some(root) = graph.root else {
        return Err(vec![Problem::new(
            "Groot holds a tree, and this behavior has no root",
        )]);
    };
    let nodes: HashMap<Uuid, &arora_behavior::graph::Node> =
        graph.nodes.iter().map(|node| (node.id, node)).collect();
    let mut attached = Vec::new();
    let mut stack = vec![root];
    let mut seen = HashSet::new();
    while let Some(id) = stack.pop() {
        if !seen.insert(id) {
            continue;
        }
        attached.push(id);
        if let Some(node) = nodes.get(&id) {
            stack.extend(node.children.iter().flatten().rev());
        }
    }
    let mut problems = Vec::new();
    let detached: Vec<String> = graph
        .nodes
        .iter()
        .filter(|node| !seen.contains(&node.id))
        .map(|node| label(&node.id))
        .collect();
    if !detached.is_empty() {
        problems.push(Problem::new(format!(
            "Groot holds no node outside the tree: {}",
            detached.join(", ")
        )));
    }
    let named: Vec<String> = attached
        .iter()
        .filter_map(|id| {
            names
                .get(id)
                .filter(|name| is_label(name) && !(*id == root && name.as_str() == "root"))
        })
        .map(|name| format!("`{name}`"))
        .collect();
    if !named.is_empty() {
        problems.push(Problem::new(format!(
            "Groot keeps no node name: {}",
            named.join(", ")
        )));
    }
    for id in &attached {
        let Some(node) = nodes.get(id) else { continue };
        for (port, source) in &node.bind {
            if matches!(source, Source::Port(_) | Source::Select { .. }) {
                problems.push(Problem::new(format!(
                    "Groot has no form for {} reading another node, as {}'s `{}` does",
                    if matches!(source, Source::Port(_)) {
                        "a port"
                    } else {
                        "a selection"
                    },
                    label(id),
                    port_name(functions, node.function, *port),
                )));
            }
        }
    }
    if !problems.is_empty() {
        return Err(problems);
    }
    let mut variables = HashMap::new();
    let tree = tree_node(root, &nodes, &mut variables);
    let groot = schema_groot::Node::try_from_tree_node(&tree, functions, &mut variables)
        .map_err(|e| vec![Problem::new(format!("Groot cannot hold it: {e}"))])?;
    let xml = String::from_utf8(schema_groot::BehaviorTree { root: groot }.to_groot_xml())
        .map(|xml| xml + "\n")
        .map_err(|e| vec![Problem::new(e.to_string())])?;
    // Groot gives each node the id of its path: a node with another id, one
    // a text gives by naming it with an id, would come back as another node.
    let text = open_groot(&xml, functions)?;
    let graph = unseeded(graph);
    if resolves_to(&text, &graph, functions) {
        return Ok(xml);
    }
    let ids: HashSet<Uuid> = graph_of(&text, functions)
        .nodes
        .iter()
        .map(|node| node.id)
        .collect();
    let moved: Vec<String> = attached
        .iter()
        .filter(|id| !ids.contains(id))
        .map(&label)
        .collect();
    Err(vec![Problem::new(if moved.is_empty() {
        "Groot does not read this behavior back as it is".to_string()
    } else {
        format!(
            "Groot gives each node the id of its path, which {} has not",
            moved.join(", ")
        )
    })])
}

/// The node `id` and the tree under it, each binding an argument: a value
/// as it is, a key as a variable, which `variables` names by the key.
fn tree_node(
    id: Uuid,
    nodes: &HashMap<Uuid, &arora_behavior::graph::Node>,
    variables: &mut HashMap<Uuid, String>,
) -> TreeNode {
    let node = nodes[&id];
    TreeNode {
        function: node.function,
        children: node.children.as_ref().map(|children| {
            children
                .iter()
                .map(|child| tree_node(*child, nodes, variables))
                .collect()
        }),
        parameters: node
            .bind
            .iter()
            .map(|(port, source)| (*port, expression(source, variables)))
            .collect(),
    }
}

/// A binding as the argument a Groot export writes, a key the variable
/// `variables` names by it. The caller has refused every source but a value
/// and a key.
fn expression(source: &Source, variables: &mut HashMap<Uuid, String>) -> Expression {
    match source {
        Source::Value(value) => Expression::Value(value.clone()),
        Source::Key(key) => {
            let id = Uuid::new_v5(&Uuid::NAMESPACE_URL, key.as_bytes());
            variables.insert(id, key.clone());
            Expression::VariableId(id)
        }
        Source::Port(port) => Expression::NodeArgument(NodeParameterId {
            node: port.node,
            parameter: port.port,
        }),
        Source::Select { source, path } => Expression::Select {
            source: Box::new(expression(source, variables)),
            path: path.clone(),
        },
    }
}

/// A port's name on a node calling `function`: its parameter's name, `_ret`,
/// or its id.
fn port_name(functions: &FunctionIndex, function: Uuid, port: Uuid) -> String {
    if port == _RET_PARAM_ID {
        return "_ret".to_string();
    }
    signature(functions, function)
        .and_then(|f| f.function.parameters.get(&port).map(|p| p.name.clone()))
        .unwrap_or_else(|| port.to_string())
}

fn signature(functions: &FunctionIndex, id: Uuid) -> Option<ModuleFunction> {
    text::natives()
        .find(|native| native.function_id == id)
        .cloned()
        .or_else(|| functions.get(&id).cloned())
}

/// `graph` as a text: a node `labels` names by that name.
///
/// The display names every node another reads, or the tree does not hold,
/// by its id when it has no label; a node the tree holds and none reads goes
/// unnamed, so the text gives it the id of its path. With `keep_ids`, the
/// text resolves to `graph` itself: a node whose id that is not is named by
/// its id, and every unnamed node is when path ids would still land on other
/// nodes. A graph no text reads back as is refused.
fn graph_text(
    graph: &Graph,
    functions: &FunctionIndex,
    mut labels: HashMap<Uuid, String>,
    keep_ids: bool,
) -> Result<String, Problem> {
    // A tree needs a node: the empty graph is the empty text.
    if graph.root.is_none() && graph.nodes.is_empty() {
        return Ok(String::new());
    }
    let graph = &unseeded(graph);
    let tree = build_behavior_tree(graph, &|_| None)
        .map_err(|e| Problem::new(format!("the graph is not a behavior: {e}")))?;
    let display = |labels: &HashMap<Uuid, String>| {
        tree.display(Names {
            functions: Some(functions),
            nodes: Some(labels),
            ..Names::default()
        })
        .to_string()
    };
    let written = display(&labels);
    if !keep_ids {
        return reads_back_alike(written, functions);
    }
    if resolves_to(&written, graph, functions) {
        return Ok(written);
    }
    // A node the text gives another id is named by its id.
    let ids: HashSet<Uuid> = graph_of(&written, functions)
        .nodes
        .iter()
        .map(|node| node.id)
        .collect();
    let lost = graph.nodes.iter().map(|node| node.id);
    labels.extend(
        lost.filter(|id| !ids.contains(id))
            .map(|id| (id, id.to_string())),
    );
    let written = display(&labels);
    if resolves_to(&written, graph, functions) {
        return Ok(written);
    }
    // Ids the text derives from paths can land on other nodes, as when two
    // nodes hold each other's: every node unnamed is then named by its id.
    for node in &graph.nodes {
        labels.entry(node.id).or_insert_with(|| node.id.to_string());
    }
    let written = display(&labels);
    if resolves_to(&written, graph, functions) {
        Ok(written)
    } else {
        Err(Problem::new(
            "the graph has no text that reads back as the same graph",
        ))
    }
}

/// `text`, the display of a graph whose nodes take the ids of their paths,
/// when it reads back as the same behavior: it resolves without errors, and
/// what it resolves to displays as `text` again. A text past the language's
/// limits, such as its nesting depth, leaves part of the graph out.
fn reads_back_alike(text: String, functions: &FunctionIndex) -> Result<String, Problem> {
    let parsed = text::parse(&text);
    let loaded = text::resolve(&parsed.document, functions);
    let errors: Vec<&str> = parsed
        .diagnostics
        .iter()
        .chain(&loaded.diagnostics)
        .filter(|d| d.severity == Severity::Error)
        .map(|d| d.message.as_str())
        .collect();
    if !errors.is_empty() {
        return Err(Problem::new(format!(
            "its text does not read back: {}",
            errors.join("; ")
        )));
    }
    let again = build_behavior_tree(&unseeded(&loaded.graph), &|_| None)
        .map(|tree| {
            tree.display(Names {
                functions: Some(functions),
                ..Names::default()
            })
            .to_string()
        })
        .map_err(|e| Problem::new(format!("its text does not read back: {e}")))?;
    if again == text {
        Ok(text)
    } else {
        Err(Problem::new("its text reads back as another behavior"))
    }
}

/// Whether `text` resolves to `graph`, a graph without the bindings a
/// resolution seeds: the same nodes, with the same ids, bindings and children.
fn resolves_to(text: &str, graph: &Graph, functions: &FunctionIndex) -> bool {
    let by_id = |graph: Graph| {
        let mut graph = graph;
        graph.nodes.sort_by_key(|node| node.id);
        graph
    };
    by_id(unseeded(&graph_of(text, functions))) == by_id(graph.clone())
}

/// `graph` without the bindings a text's resolution gives a native node by
/// itself, such as a `sequence_star`'s first index: a text does not write
/// them, and its resolution gives them back.
fn unseeded(graph: &Graph) -> Graph {
    let mut seeds: HashMap<Uuid, Vec<(Uuid, Source)>> = HashMap::new();
    let mut graph = graph.clone();
    for node in &mut graph.nodes {
        let Some(native) = text::natives().find(|n| n.function_id == node.function) else {
            continue;
        };
        let seeded = seeds.entry(node.function).or_insert_with(|| {
            let parsed = text::parse(&format!("{}\n", native.function_name));
            let loaded = text::resolve(&parsed.document, &FunctionIndex::new());
            loaded
                .graph
                .nodes
                .first()
                .map(|seeded| seeded.bind.clone().into_iter().collect())
                .unwrap_or_default()
        });
        for (port, source) in seeded.iter() {
            if node.bind.get(port) == Some(source) {
                node.bind.remove(port);
            }
        }
    }
    graph
}

/// The graph `text` resolves to.
fn graph_of(text: &str, functions: &FunctionIndex) -> Graph {
    text::resolve(&text::parse(text).document, functions).graph
}

/// Whether `name` is written as a node's name as it is: what a text names a
/// node by, as opposed to an id or a path.
pub fn is_label(name: &str) -> bool {
    if Uuid::parse_str(name).is_ok() {
        return false;
    }
    let parsed = text::parse(&format!("{name}: succeed\n"));
    !parsed
        .diagnostics
        .iter()
        .any(|d| d.severity == Severity::Error)
        && parsed
            .document
            .nodes
            .first()
            .and_then(|node| node.name.as_ref())
            .is_some_and(|written| written.text == name)
}

/// A Groot loader's message as a problem, its `at position <byte>` as a line
/// and column of `file`.
fn groot_problem(file: &str, message: &str) -> Problem {
    let position = message
        .split("at position ")
        .nth(1)
        .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|digits| digits.parse::<usize>().ok());
    match position {
        Some(at) => {
            let mut at = at.min(file.len());
            while !file.is_char_boundary(at) {
                at -= 1;
            }
            let before = &file[..at];
            let line = before.matches('\n').count() + 1;
            let column = before.rsplit('\n').next().map_or(0, |l| l.chars().count()) + 1;
            Problem::at_line(message, line, column)
        }
        None => Problem::new(message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolved(text: &str) -> text::Loaded {
        let parsed = text::parse(text);
        assert!(parsed.diagnostics.is_empty(), "{:?}", parsed.diagnostics);
        let loaded = text::resolve(&parsed.document, &FunctionIndex::new());
        let errors = loaded
            .diagnostics
            .iter()
            .filter(|d| d.severity == Severity::Error);
        assert_eq!(errors.count(), 0, "{:?}", loaded.diagnostics);
        loaded
    }

    /// Each node by its name, or by its path when the text names it not.
    fn names(loaded: &text::Loaded) -> HashMap<Uuid, String> {
        loaded
            .nodes
            .iter()
            .map(|node| {
                (
                    node.id,
                    node.name.clone().unwrap_or_else(|| node.path.clone()),
                )
            })
            .collect()
    }

    fn sorted(mut graph: Graph) -> Graph {
        graph.nodes.sort_by_key(|node| node.id);
        graph
    }

    const TREE: &str = "fallback\n  sequence_star\n    equal(a: {person/visible}, b: true)\n    set_string(variable: {face/mood}, value: \"near\")\n  set_string(variable: {.mood}, value: \"far\")\n";

    #[test]
    fn a_text_reads_back_through_every_format() {
        let loaded = resolved(TREE);
        let index = FunctionIndex::new();
        for format in [GraphFormat::Json, GraphFormat::Yaml] {
            let file = write_graph(&loaded.graph, &names(&loaded), format, &index).unwrap();
            assert!(!file.contains("5f726574"), "names, not ids: {file}");
            let text = open_graph(&file, format, &index).unwrap();
            assert_eq!(text, TREE, "{format:?}: {file}");
        }
        let xml = write_groot(&loaded.graph, &names(&loaded), &index).unwrap();
        let text = open_groot(&xml, &index).unwrap();
        assert_eq!(sorted(resolved(&text).graph), sorted(loaded.graph), "{xml}");
    }

    #[test]
    fn groot_refuses_what_it_cannot_hold_naming_it() {
        let text = "watch: sequence\n  equal(a: @level._ret, b: 1u8)\n\nlevel: {face/level} = equal(a: {x}, b: 2u8)\n";
        let loaded = resolved(text);
        let problems = write_groot(&loaded.graph, &names(&loaded), &FunctionIndex::new())
            .unwrap_err()
            .into_iter()
            .map(|p| p.message)
            .collect::<Vec<_>>();
        assert_eq!(
            problems,
            [
                "Groot holds no node outside the tree: `level`",
                "Groot keeps no node name: `watch`",
                "Groot has no form for a port reading another node, as `root.0`'s `a` does",
            ]
        );
    }

    #[test]
    fn groot_refuses_a_node_whose_id_is_not_its_path_s() {
        let index = FunctionIndex::new();
        let id = "8f3a1c52-0d4e-4b7a-9c61-2b5e7d9a0f13";
        let loaded = resolved(&format!("sequence\n  {id}: succeed\n"));
        let problems = write_groot(&loaded.graph, &names(&loaded), &index).unwrap_err();
        assert_eq!(
            problems[0].message,
            format!("Groot gives each node the id of its path, which `{id}` has not")
        );
        // The root named `root` has its path's id: it reads back as it is.
        let loaded = resolved("root: succeed\n");
        let xml = write_groot(&loaded.graph, &names(&loaded), &index).unwrap();
        let text = open_groot(&xml, &index).unwrap();
        assert_eq!(sorted(resolved(&text).graph), sorted(loaded.graph));
    }

    #[test]
    fn a_file_that_does_not_load_says_where() {
        let index = FunctionIndex::new();
        let json = open_graph(
            "{\"nodes\": [\n  {\"id\": 1}\n]}",
            GraphFormat::Json,
            &index,
        )
        .unwrap_err();
        assert_eq!(
            (json[0].line, json[0].column),
            (Some(2), Some(10)),
            "{json:?}"
        );
        let yaml = "root: a\nnodes:\n- id: a\n  function: sequence\n  children: [b]\n";
        let unresolved = open_graph(yaml, GraphFormat::Yaml, &index).unwrap_err();
        assert_eq!(unresolved[0].at.as_deref(), Some("nodes[0].children[0]"));
        let groot = open_groot("<root>\n  <BehaviorTree>\n    <Sequence>\n", &index).unwrap_err();
        assert_eq!(groot[0].line, Some(4), "{groot:?}");
        let unknown = open_groot(
            "<root><BehaviorTree><Fly speed=\"1\"/></BehaviorTree></root>",
            &index,
        )
        .unwrap_err();
        assert!(unknown[0].message.contains("Fly"), "{unknown:?}");
    }

    #[test]
    fn a_node_by_id_keeps_its_id_in_the_text() {
        let id = "8f3a1c52-0d4e-4b7a-9c61-2b5e7d9a0f13";
        let yaml = format!("root: {id}\nnodes:\n- id: {id}\n  function: succeed\n");
        let text = open_graph(&yaml, GraphFormat::Yaml, &FunctionIndex::new()).unwrap();
        assert_eq!(text, format!("{id}: succeed\n"));
        let named = "root: done\nnodes:\n- id: done\n  function: succeed\n";
        let text = open_graph(named, GraphFormat::Yaml, &FunctionIndex::new()).unwrap();
        assert_eq!(text, "done: succeed\n");
    }

    #[test]
    fn nodes_holding_each_other_s_path_ids_keep_them_in_the_text() {
        for leaves in ["  succeed\n  running\n", "  succeed\n  succeed\n"] {
            let loaded = resolved(&format!("sequence\n{leaves}"));
            let mut graph = loaded.graph.clone();
            let root = graph.root.unwrap();
            let (a, b) = {
                let children = graph.nodes.iter().find(|n| n.id == root).unwrap();
                let children = children.children.as_ref().unwrap();
                (children[0], children[1])
            };
            // Each leaf takes the other's id, in the same tree order.
            let swap = |id: &mut Uuid| {
                if *id == a {
                    *id = b;
                } else if *id == b {
                    *id = a;
                }
            };
            for node in &mut graph.nodes {
                swap(&mut node.id);
                node.children.iter_mut().flatten().for_each(swap);
            }
            let index = FunctionIndex::new();
            let file = write_graph(&graph, &HashMap::new(), GraphFormat::Json, &index).unwrap();
            let text = open_graph(&file, GraphFormat::Json, &index).unwrap();
            assert_eq!(
                sorted(resolved(&text).graph),
                sorted(graph.clone()),
                "{text}"
            );
        }
    }

    #[test]
    fn a_value_nested_to_the_language_s_limit_reads_back_as_json() {
        let depth = text::MAX_DEPTH - 2;
        let text = format!(
            "running\n\nx: equal(a: {}1f64{}, b: 1f64)\n",
            "some(".repeat(depth),
            ")".repeat(depth)
        );
        let loaded = text::resolve(&text::parse(&text).document, &FunctionIndex::new());
        let index = FunctionIndex::new();
        let json = write_graph(&loaded.graph, &names(&loaded), GraphFormat::Json, &index).unwrap();
        assert!(json_depth(&json) > 128, "deeper than serde_json's default");
        assert!(open_graph(&json, GraphFormat::Json, &index).is_ok());
        // serde_yaml reads 128 levels at most: the YAML is refused, not written.
        let yaml = write_graph(&loaded.graph, &names(&loaded), GraphFormat::Yaml, &index);
        assert!(yaml.unwrap_err()[0].message.contains("recursion limit"));
        // Past the bound, a file is refused before it is decoded.
        let deep = format!(
            "{}{}",
            "[".repeat(MAX_JSON_DEPTH + 1),
            "]".repeat(MAX_JSON_DEPTH + 1)
        );
        let refused = open_graph(&deep, GraphFormat::Json, &index).unwrap_err();
        assert!(refused[0].message.contains("nests deeper"), "{refused:?}");
        assert_eq!(json_depth(r#"{"a": "[[{", "b": ["\"]"]}"#), 2);
    }

    #[test]
    fn a_groot_tree_past_the_language_s_depth_is_refused_not_cut() {
        let index = FunctionIndex::new();
        let tree = |depth: usize| {
            format!(
                "<root main_tree_to_execute=\"MainTree\"><BehaviorTree ID=\"MainTree\">{}<Succeed/>{}</BehaviorTree></root>",
                "<Sequence>".repeat(depth),
                "</Sequence>".repeat(depth)
            )
        };
        assert!(open_groot(&tree(3), &index).is_ok());
        let problems = open_groot(&tree(text::MAX_DEPTH + 2), &index).unwrap_err();
        assert!(
            problems[0]
                .message
                .starts_with("its text does not read back"),
            "{problems:?}"
        );
    }

    #[test]
    fn an_empty_behavior_saves_and_opens_again() {
        let loaded = text::resolve(&text::parse("").document, &FunctionIndex::new());
        let index = FunctionIndex::new();
        for format in [GraphFormat::Json, GraphFormat::Yaml] {
            let file = write_graph(&loaded.graph, &HashMap::new(), format, &index).unwrap();
            assert_eq!(
                open_graph(&file, format, &index).unwrap(),
                "",
                "{format:?}: {file}"
            );
        }
    }

    #[test]
    fn a_label_is_a_name_not_an_id_nor_a_path() {
        assert!(is_label("near"));
        assert!(!is_label("root.0"));
        assert!(!is_label("8f3a1c52-0d4e-4b7a-9c61-2b5e7d9a0f13"));
    }
}
