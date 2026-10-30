//! A device carrying `@arora/dataflow`, for the behavior editor's end-to-end
//! tests: the dataflow example's inputs seeded, stepping at 50 Hz, serving
//! the open local bridge on two loopback ports. A bridge serves one client at
//! a time, so the editor takes the first and the test's own client the
//! second: a change the test makes is another client's to the editor.
//!
//! `e2e-device <editor port> <test port>`

use std::collections::HashMap;
use std::time::Duration;

use anyhow::{anyhow, Context};
use arora::bridge_ws::ServerConfig;
use arora::Arora;
use arora_simple_data_store::SimpleDataStore;
use arora_types::data::{DataStore, Key, KeyMeta, StateChange};
use arora_types::value::Value;

/// The port named by argument `at`.
fn port(at: usize) -> anyhow::Result<u16> {
    std::env::args()
        .nth(at)
        .context("usage: e2e-device <editor port> <test port>")?
        .parse()
        .context("a port is a number")
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let (editor, test) = (port(1)?, port(2)?);
    let store = SimpleDataStore::new();
    let input: KeyMeta =
        serde_json::from_value(serde_json::json!({"ty": "f32", "editable": true}))?;
    store
        .set_meta(HashMap::from([
            (Key::new("sensor/distance"), input.clone()),
            (Key::new("face/smile_target"), input),
        ]))
        .map_err(|e| anyhow!("{e:?}"))?;
    for (key, value) in [("sensor/distance", 0.3), ("face/smile_target", 1.0)] {
        store
            .write(StateChange::set(key, Value::F32(value)))
            .map_err(|e| anyhow!("{e:?}"))?;
    }
    let mut device = Arora::builder()
        .with_data_store(Box::new(store))
        .with_host_module(dataflow_device::dataflow::module())
        .with_bridge(arora::local_ws_bridge_with(ServerConfig::with_port(editor)).await?)
        .with_bridge(arora::local_ws_bridge_with(ServerConfig::with_port(test)).await?)
        .build()?;
    println!("serving on ports {editor} and {test}");
    device.run(Duration::from_millis(20)).await?;
    Ok(())
}
