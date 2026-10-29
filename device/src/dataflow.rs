//! `@arora/dataflow` as a host module: the node vocabulary of
//! `arora-dataflow-nodes` as functions a behavior's nodes call (`add`,
//! `multiply`, `clamp`, `damp`, `oscillator`, …), each described with the
//! signature the crate gives it, so the device lists them among its methods.
//!
//! One `DataflowNodes` answers every call. What it keeps between calls is per
//! call site, named by a call's `node` argument.
//!
//! A host module's function is called with its arguments alone, with no way
//! to call the device's other modules, so the functions that exist to call
//! another module (`external`, `externalfunction`, `taskrun` and `spawn`) are
//! left out.

use std::cell::RefCell;
use std::rc::Rc;

use arora::{HostModule, ModuleBuilder};
use arora_dataflow_nodes::functions::{
    external_function, function_index, kind_of, DataflowNodes, DATAFLOW,
};
use arora_dataflow_nodes::Kind;
use arora_types::call::{Call, CallBridge, CallError, CallResult, Callable, CallableId};
use arora_types::value::Value;
use uuid::Uuid;

/// Whether `function`, of `@arora/dataflow`, calls another module.
fn calls_another_module(function: Uuid) -> bool {
    function == external_function()
        || matches!(
            kind_of(function),
            Some(Kind::ExternalFunction | Kind::TaskRun | Kind::Spawn)
        )
}

/// The host module `@arora/dataflow`, answering its calls in-process.
pub(crate) fn module() -> HostModule {
    let nodes = Rc::new(RefCell::new(DataflowNodes::new()));
    let mut functions: Vec<_> = function_index()
        .values()
        .filter(|f| f.module_id == DATAFLOW.id && !calls_another_module(f.function_id))
        .collect();
    functions.sort_by(|a, b| a.function_name.cmp(&b.function_name));
    functions
        .into_iter()
        .fold(ModuleBuilder::new(DATAFLOW.id), |module, described| {
            let nodes = nodes.clone();
            module.described_function(
                described.function_id,
                described.function_name.clone(),
                described.function.clone(),
                move |call| nodes.borrow_mut().call(call, &mut NoOtherModule),
            )
        })
        .build()
}

/// The bridge the module's functions are evaluated over: none of them calls
/// another module, so it answers no call, and none registers a callable.
struct NoOtherModule;

impl NoOtherModule {
    fn refusal() -> CallError {
        CallError::Generic {
            message: "@arora/dataflow as a host module calls no other module".to_string(),
        }
    }
}

impl CallBridge for NoOtherModule {
    fn arora_call(&mut self, _call: Call) -> Result<CallResult, CallError> {
        Err(Self::refusal())
    }

    fn arora_register_callable(&mut self, _callable: Rc<dyn Callable>) -> CallableId {
        unreachable!("a dataflow function registers no callable")
    }

    fn arora_unregister_callable(&mut self, _callable_id: &CallableId) {}

    fn arora_call_indirect(&mut self, _callable_id: &CallableId) -> Result<Value, CallError> {
        Err(Self::refusal())
    }
}
