//! The device's JavaScript surface, `DataflowDevice`: the device wrapped in
//! arora-web's browser device (`AroraWeb`), with the operations
//! `@semio/behavior-editor`'s `DeviceRuntime` takes, values crossing as the
//! JSON of Arora's `Value`.
//!
//! Every operation answers when it returns. A call is applied as arora-web
//! applies an operation on a device nobody is stepping: by a step at a zero
//! dt, which ticks the behavior once with no time elapsed. A write is a
//! remote's, checked against the device's meta and applied by the device's
//! next step, that of a call or of `step`; `step` reports a refusal.

use std::cell::RefCell;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;

use arora::{Caller, MethodSignature};
use arora_behavior::graph::GraphDiff;
use arora_behavior::interpreter_module::encode_edit;
use arora_simple_data_store::SimpleDataStore;
use arora_types::call::{Call, CallError};
use arora_types::data::{DataStore, Key, KeyMeta, StateChange};
use arora_types::value::Value;
use arora_web::AroraWeb;
use futures::FutureExt;
use serde::Serialize;
use wasm_bindgen::prelude::*;

/// The device's answer to a write, which its next step gives.
type WriteReply = Pin<Box<dyn Future<Output = Result<(), CallError>>>>;

/// An Arora device carrying `@arora/dataflow`, its keys under its namespace
/// in a host store (see the crate's documentation).
#[wasm_bindgen]
pub struct DataflowDevice {
    device: AroraWeb,
    /// The host store, which `read` reads by full path.
    host: SimpleDataStore,
    /// The device's view of the host store, its keys device-relative.
    store: Box<dyn DataStore>,
    /// The device's methods, read when it was built: its modules are fixed.
    methods: Vec<MethodSignature>,
    /// The writes made since the last step, each awaiting the device's answer.
    writes: RefCell<Vec<WriteReply>>,
}

#[wasm_bindgen]
impl DataflowDevice {
    /// A device whose keys sit under `namespace`, its inputs described by
    /// `inputs_json`: a JSON object of device-relative keys to their
    /// `KeyMeta` (`{ "sensor/distance": { "ty": "f32", "editable": true } }`).
    #[wasm_bindgen(constructor)]
    pub fn new(namespace: &str, inputs_json: &str) -> Result<DataflowDevice, JsError> {
        let inputs: HashMap<String, KeyMeta> = serde_json::from_str(inputs_json)
            .map_err(|e| JsError::new(&format!("invalid inputs json: {e}")))?;
        let inputs = inputs.into_iter().map(|(k, m)| (Key::new(k), m)).collect();
        let (device, host) = crate::assemble(namespace, inputs).map_err(|e| JsError::new(&e))?;
        let store = device.store().clone_box();
        let methods = device.describe_methods(None);
        Ok(DataflowDevice {
            device: AroraWeb::from(device),
            host,
            store,
            methods,
            writes: RefCell::new(Vec::new()),
        })
    }

    /// The device's methods whose name starts with `prefix` (all of them when
    /// absent), sorted by name: a JSON array of method signatures, each with
    /// the module and function ids a call targets and its parameters' ids.
    #[wasm_bindgen(js_name = describeMethods)]
    pub fn describe_methods(&self, prefix: Option<String>) -> Result<String, JsError> {
        let methods: Vec<&MethodSignature> = self
            .methods
            .iter()
            .filter(|m| prefix.as_deref().is_none_or(|p| m.name.starts_with(p)))
            .collect();
        to_json(&methods)
    }

    /// Call a module function: `call_json` is an `arora_types::call::Call`'s
    /// JSON, and the answer its `CallResult`'s. The call is applied by a step
    /// at a zero dt, taken now.
    pub fn call(&self, call_json: &str) -> Result<String, JsError> {
        let call: Call = serde_json::from_str(call_json)
            .map_err(|e| JsError::new(&format!("invalid call json: {e}")))?;
        let caller = self.device.caller();
        let reply = caller.call(call);
        self.device.step(0.0).map_err(js_error)?;
        let result = reply
            .now_or_never()
            .ok_or_else(|| JsError::new("the step that applied the call did not answer it"))?
            .map_err(|e| JsError::new(&format!("call failed: {e}")))?;
        to_json(&result)
    }

    /// Write device-relative keys, `{ "<key>": <Value JSON> | null }` (`null`
    /// unsets), as a remote writes them: applied by the device's next step,
    /// which refuses the whole change if a key is not an input open to it or a
    /// value not of its key's type. The next `step` reports a refusal.
    pub fn update(&self, changes_json: &str) -> Result<(), JsError> {
        let changes: HashMap<String, Option<Value>> = serde_json::from_str(changes_json)
            .map_err(|e| JsError::new(&format!("invalid changes json: {e}")))?;
        let mut change = StateChange::new();
        for (key, value) in changes {
            match value {
                Some(value) => {
                    change.set.insert(Key::new(key), Some(value));
                }
                None => {
                    change.unset.insert(Key::new(key));
                }
            }
        }
        let reply = self.device.caller().update(change);
        self.writes.borrow_mut().push(Box::pin(reply));
        Ok(())
    }

    /// One key of the host store, by its full path (`<namespace>/<key>`): its
    /// Value's JSON, or `null`.
    pub fn read(&self, path: &str) -> Result<String, JsError> {
        let value = self.host.read(&[Key::new(path)]).pop().flatten();
        to_json(&value)
    }

    /// The device's keys whose path starts with `prefix` (all of them when
    /// absent), sorted: a JSON array of `[key, KeyMeta]`, keys device-relative.
    #[wasm_bindgen(js_name = listKeys)]
    pub fn list_keys(&self, prefix: Option<String>) -> Result<String, JsError> {
        to_json(&arora::list_keys(&*self.store, prefix.as_deref()))
    }

    /// Advance the device by `dt_ms` milliseconds: its clock, the writes made
    /// since the last step, its behavior. Throws when the step fails, when it
    /// refused a write, or when the behavior's tick failed.
    pub fn step(&self, dt_ms: f64) -> Result<(), JsError> {
        if !dt_ms.is_finite() || dt_ms < 0.0 {
            return Err(JsError::new(&format!("invalid dt: {dt_ms} ms")));
        }
        self.device.step(dt_ms).map_err(js_error)?;
        let mut refused = None;
        self.writes
            .borrow_mut()
            .retain_mut(|reply| match reply.as_mut().now_or_never() {
                None => true,
                Some(Ok(())) => false,
                Some(Err(e)) => {
                    refused.get_or_insert(e.to_string());
                    false
                }
            });
        if let Some(message) = refused {
            return Err(JsError::new(&format!("a write was refused: {message}")));
        }
        match self.device.behavior_error() {
            Some(message) => Err(JsError::new(&format!("the behavior failed: {message}"))),
            None => Ok(()),
        }
    }
}

/// The `Call` JSON that applies `diff_json`, a `GraphDiff`'s JSON, to a
/// device's behavior: the interpreter module's EDIT, which keeps the state of
/// the nodes the diff leaves in place.
#[wasm_bindgen(js_name = editCall)]
pub fn edit_call(diff_json: &str) -> Result<String, JsError> {
    let diff: GraphDiff = serde_json::from_str(diff_json)
        .map_err(|e| JsError::new(&format!("invalid diff json: {e}")))?;
    to_json(&encode_edit(&diff))
}

fn to_json(value: &impl Serialize) -> Result<String, JsError> {
    serde_json::to_string(value).map_err(|e| JsError::new(&format!("serialize failed: {e}")))
}

/// arora-web's error, a JavaScript string, as an `Error`.
fn js_error(error: JsValue) -> JsError {
    JsError::new(&error.as_string().unwrap_or_else(|| format!("{error:?}")))
}
