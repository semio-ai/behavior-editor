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
    let readable: readable::Graph = match format {
        GraphFormat::Json => serde_json::from_str(file).map_err(|e| {
            vec![Problem::at_line(
                format!("not a graph in JSON: {e}"),
                e.line(),
                e.column(),
            )]
        })?,
        GraphFormat::Yaml => serde_yaml::from_str(file).map_err(|e| {
            let (line, column) = e.location().map_or((0, 0), |at| (at.line(), at.column()));
            vec![Problem {
                line: (line > 0).then_some(line),
                column: (line > 0).then_some(column),
                ..Problem::new(format!("not a graph in YAML: {e}"))
            }]
        })?,
    };
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
/// and port by its name.
pub fn write_graph(
    graph: &Graph,
    names: &HashMap<Uuid, String>,
    format: GraphFormat,
    functions: &FunctionIndex,
) -> Result<String, String> {
    let readable = readable::Graph::from_graph(
        graph,
        &Names {
            functions: Some(functions),
            nodes: Some(names),
            ..Names::default()
        },
    );
    match format {
        GraphFormat::Json => serde_json::to_string_pretty(&readable)
            .map(|json| json + "\n")
            .map_err(|e| e.to_string()),
        GraphFormat::Yaml => serde_yaml::to_string(&readable).map_err(|e| e.to_string()),
    }
}

/// `graph` as a Groot tree, or what in it Groot cannot hold: a node the tree
/// does not hold, a binding reading another node, a node's name. `names`
/// names each node, as the text does or by its path.
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
    String::from_utf8(schema_groot::BehaviorTree { root: groot }.to_groot_xml())
        .map(|xml| xml + "\n")
        .map_err(|e| vec![Problem::new(e.to_string())])
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
/// unnamed, so the text gives it the id of its path. With `keep_ids`, a node
/// whose id that is not is named by its id, so that the text resolves to
/// every node the id it has.
fn graph_text(
    graph: &Graph,
    functions: &FunctionIndex,
    mut labels: HashMap<Uuid, String>,
    keep_ids: bool,
) -> Result<String, Problem> {
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
        return Ok(written);
    }
    let lost: Vec<Uuid> = {
        let ids: HashSet<Uuid> = resolved_ids(&written, functions);
        graph
            .nodes
            .iter()
            .map(|node| node.id)
            .filter(|id| !ids.contains(id))
            .collect()
    };
    if lost.is_empty() {
        return Ok(written);
    }
    labels.extend(lost.into_iter().map(|id| (id, id.to_string())));
    Ok(display(&labels))
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

/// The ids of the nodes `text` resolves to.
fn resolved_ids(text: &str, functions: &FunctionIndex) -> HashSet<Uuid> {
    let parsed = text::parse(text);
    text::resolve(&parsed.document, functions)
        .graph
        .nodes
        .iter()
        .map(|node| node.id)
        .collect()
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
    fn a_label_is_a_name_not_an_id_nor_a_path() {
        assert!(is_label("near"));
        assert!(!is_label("root.0"));
        assert!(!is_label("8f3a1c52-0d4e-4b7a-9c61-2b5e7d9a0f13"));
    }
}
