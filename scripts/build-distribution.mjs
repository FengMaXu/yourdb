#!/usr/bin/env node
/**
 * Builds the complete TypeScript distribution:
 * contracts -> charts -> runtime -> electron-host/web host packages -> Renderer (vite).
 * Verifies no legacy Python backend artifacts are referenced.
 */
import { execSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: root });
}
function normalizeGeneratedBundle(file) {
  const content = readFileSync(path.join(root, file), "utf8");
  writeFileSync(path.join(root, file), content.replace(/[ \t]+$/gm, ""));
}

run("npm run build:contracts");
// Runtime and the renderer depend on charts, including its browser bundle for dashboards.
run("npm run build:charts");
run("npm run build:runtime");
// mcp-sqlite before server: the server's evaluation launcher imports it.
for (const pkg of ["@data-agent/database", "@data-agent/mcp-plugins", "@data-agent/transport", "@data-agent/channel-feishu", "@data-agent/electron-host", "@data-agent/mcp-sqlite", "@data-agent/server", "@data-agent/mcp-mysql", "@data-agent/mcp-pg"]) {
  run(`npm run build --workspace=${pkg}`);
}
run("npm run build --workspace=frontend");

// The bundles under frontend/electron-host/ are generated and gitignored. They
// ship with external source maps (chained through the tsc .js.map files) so
// stack traces point at the original .ts sources; sourcesContent is omitted to
// keep app.asar small. esbuild places the banner above its own "use strict",
// so the banner repeats the directive to keep the bundle in strict mode.
const bundleArgs = [
  "--bundle", "--platform=node", "--format=cjs",
  "--sourcemap", "--sources-content=false",
  "--banner:js=\"use strict\";process.setSourceMapsEnabled(true);",
];

// Bundle the TS Electron host into a single CJS entry so no workspace
// node_modules are needed at runtime. SQLite is Node's built-in node:sqlite,
// so the bundle carries no native module.
{
  const args = [
    "node_modules/esbuild/bin/esbuild",
    "packages/electron-host/dist/main.js",
    ...bundleArgs,
    "--external:electron", "--external:mysql2", "--external:@modelcontextprotocol/sdk",
    "--define:import.meta.url=undefined",
    "--outfile=frontend/electron-host/main.cjs",
  ];
  const result = spawnSync(process.execPath, args, { stdio: "inherit", cwd: root });
  if (result.status !== 0) { console.error("esbuild failed"); process.exit(1); }
  normalizeGeneratedBundle("frontend/electron-host/main.cjs");
}
{
  const args = [
    "node_modules/esbuild/bin/esbuild",
    "packages/runtime/dist/metadata-worker.js",
    ...bundleArgs,
    "--outfile=frontend/electron-host/metadata-worker.cjs",
  ];
  const result = spawnSync(process.execPath, args, { stdio: "inherit", cwd: root });
  if (result.status !== 0) { console.error("metadata worker esbuild failed"); process.exit(1); }
  normalizeGeneratedBundle("frontend/electron-host/metadata-worker.cjs");
}
{
  const args = [
    "node_modules/esbuild/bin/esbuild",
    "packages/mcp-mysql/dist/cli.js",
    ...bundleArgs,
    "--external:mysql2",
    "--outfile=frontend/electron-host/mcp-mysql.cjs",
  ];
  const result = spawnSync(process.execPath, args, { stdio: "inherit", cwd: root });
  if (result.status !== 0) { console.error("mcp-mysql bundle failed"); process.exit(1); }
  normalizeGeneratedBundle("frontend/electron-host/mcp-mysql.cjs");
}
{
  // pg is pure JavaScript and bundles whole; pg-native is its optional native binding.
  const args = [
    "node_modules/esbuild/bin/esbuild",
    "packages/mcp-pg/dist/cli.js",
    ...bundleArgs,
    "--external:pg-native",
    "--outfile=frontend/electron-host/mcp-pg.cjs",
  ];
  const result = spawnSync(process.execPath, args, { stdio: "inherit", cwd: root });
  if (result.status !== 0) { console.error("mcp-pg bundle failed"); process.exit(1); }
  normalizeGeneratedBundle("frontend/electron-host/mcp-pg.cjs");
}
{
  // SQLite is Node's built-in node:sqlite, so this bundle has no externals.
  const args = [
    "node_modules/esbuild/bin/esbuild",
    "packages/mcp-sqlite/dist/cli.js",
    ...bundleArgs,
    "--outfile=frontend/electron-host/mcp-sqlite.cjs",
  ];
  const result = spawnSync(process.execPath, args, { stdio: "inherit", cwd: root });
  if (result.status !== 0) { console.error("mcp-sqlite bundle failed"); process.exit(1); }
  normalizeGeneratedBundle("frontend/electron-host/mcp-sqlite.cjs");
}

// The generated Electron entry is the shipped production path. Run the same
// architecture gate against source and bundle so stale legacy output cannot be
// packaged after a successful TypeScript build.
run("node scripts/verify-backend-architecture.mjs");
// frontend/electron/ holds only this generated, gitignored file, so a fresh checkout has no such directory.
mkdirSync(path.join(root, "frontend/electron"), { recursive: true });
copyFileSync(path.join(root, "packages/electron-host/preload.cjs"), path.join(root, "frontend/electron/preload.cjs"));

// Sanity checks: renderer + host outputs exist; python web backend not required.
for (const p of [
  "packages/contracts/dist/index.js",
  "packages/charts/dist/browser-source.js",
  "packages/runtime/dist/index.js",
  "packages/electron-host/dist/main.js",
  "packages/runtime/dist/metadata-worker.js",
  "frontend/electron-host/main.cjs",
  "frontend/electron-host/metadata-worker.cjs",
  "frontend/electron-host/mcp-mysql.cjs",
  "frontend/electron-host/mcp-pg.cjs",
  "frontend/electron-host/mcp-sqlite.cjs",
  "frontend/dist/index.html",
]) {
  if (!existsSync(path.join(root, p))) {
    console.error(`MISSING build artifact: ${p}`);
    process.exit(1);
  }
}
console.log("distribution build OK");
