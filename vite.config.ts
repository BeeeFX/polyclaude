import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Renderer-only Vite build. The Electron main/preload are compiled separately by
// tsc (they're Node/NodeNext, like the rest of src/). base: "./" keeps asset
// paths relative so the built index.html loads over file:// in a packaged app.
export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../dist/renderer",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
