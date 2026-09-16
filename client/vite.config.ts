import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const backend = process.env.IMGPROXY_DEV_SERVER ?? "http://127.0.0.1:7800";

export default defineConfig({
  root,
  plugins: [react()],
  build: {
    outDir: path.resolve(root, "dist"),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": backend,
      "/v1": backend,
      "/sdapi": backend,
      "/favicon": backend,
      "/apple": backend,
      "/android": backend,
      "/site": backend,
    },
  },
});
