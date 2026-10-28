/**
 * The jest-dom matchers, on this package's `vitest`: `@testing-library/jest-dom/vitest`
 * extends the `vitest` its own location resolves, the workspace root's, and this
 * package's `vitest` is its own. `jest-dom.d.ts` types them.
 */
import * as matchers from "@testing-library/jest-dom/matchers";
import { expect } from "vitest";

expect.extend(matchers);
