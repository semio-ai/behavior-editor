import { reactConfig } from "@semio/eslint-config/react";

export default [
  // The wasm build's generated glue, and the Rust crate's own outputs.
  { ignores: ["wasm/pkg/", "wasm/target/", ".cargo/"] },
  ...reactConfig({ tsconfigRootDir: import.meta.dirname }),
];
