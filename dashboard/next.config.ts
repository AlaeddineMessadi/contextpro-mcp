import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // contextpro-mcp uses better-sqlite3 (a native module) — keep it external to the
  // server bundle so Next doesn't try to bundle the .node binary.
  serverExternalPackages: ["better-sqlite3", "sqlite-vec", "contextpro-mcp"],
  // The dashboard reads .contextpro/index.db on the machine it runs on; it's a
  // local operator tool, not a deployed site.
  outputFileTracingRoot: __dirname,
};

export default nextConfig;
