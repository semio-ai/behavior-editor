//! An Arora device that carries `@arora/dataflow`, for running behaviors on a
//! real Arora runtime from JavaScript: arora's runtime with the dataflow
//! vocabulary as a host module ([`dataflow`]), wrapped in arora-web's browser
//! device, which steps it.
//!
//! The device's keys sit in a host store under its namespace, as a host that
//! keeps several devices over one store holds them: the device reads and
//! writes `<key>`, and the host holds `<namespace>/<key>`. A writer outside
//! the device may set only the inputs it declares, the keys whose meta it is
//! built with says `editable`.
//!
//! `DataflowDevice` (wasm32 only) is its JavaScript surface: the operations
//! `@semio/behavior-editor`'s `DeviceRuntime` takes of a device, each one
//! answering when it returns.

use std::collections::HashMap;
use std::sync::Arc;

use arora::Arora;
use arora_simple_data_store::{NamespacedStore, SimpleDataStore};
use arora_types::data::{DataStore, Key, KeyMeta};

pub mod dataflow;
#[cfg(target_arch = "wasm32")]
mod web;

/// A device carrying `@arora/dataflow`, its keys under `namespace` in the
/// host store returned beside it, its `inputs` (device-relative keys) described
/// by the meta given. An input open to writers outside the device says so
/// (`KeyMeta::editable`).
pub fn assemble(
    namespace: &str,
    inputs: HashMap<Key, KeyMeta>,
) -> Result<(Arora, SimpleDataStore), String> {
    let host = SimpleDataStore::new();
    let store = NamespacedStore::new(Arc::new(host.clone()), namespace);
    store
        .set_meta(inputs)
        .map_err(|e| format!("the device's inputs were not described: {e:?}"))?;
    let device = Arora::builder()
        .with_data_store(Box::new(store))
        .with_host_module(dataflow::module())
        .build()
        .map_err(|e| format!("the device was not built: {e:#}"))?;
    Ok((device, host))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use arora_dataflow_nodes::functions::DATAFLOW;
    use arora_types::value::Value;

    use super::*;

    #[test]
    fn the_device_lists_the_dataflow_functions_a_behavior_calls() {
        let (device, _) = assemble("D", HashMap::new()).unwrap();
        let methods = device.describe_methods(None);
        let dataflow: Vec<&str> = methods
            .iter()
            .filter(|m| m.module_id == DATAFLOW.id)
            .map(|m| m.name.as_str())
            .collect();
        for name in ["lessthan", "multiply", "clamp", "add", "oscillator", "damp"] {
            assert!(dataflow.contains(&name), "{name} in {dataflow:?}");
        }
        assert!(!dataflow.contains(&"external"), "{dataflow:?}");
    }

    #[test]
    fn the_device_s_keys_sit_under_its_namespace_in_the_host_store() {
        let inputs = HashMap::from([(Key::new("sensor/distance"), KeyMeta::new().editable())]);
        let (mut device, host) = assemble("D", inputs).unwrap();
        device.step(Duration::from_millis(20)).unwrap();
        let listed = arora::list_keys(device.store(), None);
        assert!(
            listed
                .iter()
                .any(|(key, meta)| key == "sensor/distance" && meta.editable),
            "{listed:?}"
        );
        assert!(
            matches!(
                host.read(&[Key::new("D/arora/time")])[0],
                Some(Value::U64(_))
            ),
            "{:?}",
            host.snapshot()
        );
    }
}
