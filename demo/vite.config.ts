import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The editor on a local Arora, its examples ready to run: `npm run demo`. */
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: { port: 5188, strictPort: false },
});
