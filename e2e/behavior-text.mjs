// The language's wasm build as Node loads it: an ES module, which the suite's
// TypeScript, transpiled to CommonJS, requires through this file.
export * from "../wasm/pkg/behavior_text.js";
export { default } from "../wasm/pkg/behavior_text.js";
