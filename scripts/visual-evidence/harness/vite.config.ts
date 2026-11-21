import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const harnessDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(harnessDir, "../../..");

export default defineConfig({
  root: harnessDir,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(repoRoot, "packages/ui/src"),
      "node:crypto": resolve(harnessDir, "node-crypto-shim.ts"),
    },
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: "127.0.0.1",
    port: 4319,
    strictPort: true,
  },
});