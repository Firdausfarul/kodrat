import { defineConfig } from "vite";
import { nodePolyfills } from "vite-plugin-node-polyfills";

export default defineConfig({
  server: { port: 3000 },
  build: { outDir: "dist" },
  plugins: [nodePolyfills()],
});
