// Copyright (c) 2026 Lllama - All Rights Reserved
// You may use, distribute and modify this code under the
// terms of the AGPL 3 license.

import fs from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

/**
 * The dev server this client belongs to. The client must talk to the server
 * that shares this checkout's data dir — never a hardcoded port, or two
 * imgproxy checkouts running side by side would edit each other's config
 * through their UIs. The port is read from the data dir's config.json (the
 * same resolution src/index.ts uses); it only ever changes via the UI plus a
 * server restart, so reading it once at startup is fine. IMGPROXY_DEV_SERVER
 * overrides everything for unusual setups.
 */
function resolveBackend(): string {
  if (process.env.IMGPROXY_DEV_SERVER) return process.env.IMGPROXY_DEV_SERVER;
  try {
    const dataDir = process.env.IMGPROXY_DATA
      ? path.resolve(process.env.IMGPROXY_DATA)
      : path.resolve(root, "..", "data");
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8")) as {
      server?: { host?: unknown; port?: unknown };
    };
    if (typeof cfg.server?.port === "number") {
      const rawHost = typeof cfg.server.host === "string" ? cfg.server.host : "";
      // Bind-any addresses aren't connectable targets; use loopback instead.
      const host = rawHost === "" || rawHost === "0.0.0.0" || rawHost === "::" ? "127.0.0.1" : rawHost;
      const hostLiteral = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
      return `http://${hostLiteral}:${cfg.server.port}`;
    }
  } catch {
    /* no/invalid config yet — fall back to the default port */
  }
  return "http://127.0.0.1:7800";
}

const backend = resolveBackend();

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
      "/sdcpp": backend,
      "/favicon": backend,
      "/apple": backend,
      "/android": backend,
      "/site": backend,
    },
  },
});
