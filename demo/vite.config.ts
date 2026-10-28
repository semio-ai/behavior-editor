import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** The editor over the mock device and the spectrum's examples: `npm run demo`. */
export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  server: { port: 5188, strictPort: false },
});
