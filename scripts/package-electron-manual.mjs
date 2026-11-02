#!/usr/bin/env node
/**
 * Manual Windows --dir packaging for the TypeScript Electron app.
 *
 * electron-builder's directory packaging intermittently fails on this machine
 * with EPERM when renaming the freshly extracted Electron distribution (real-time
 * antivirus holds a handle on the new directory). This script performs the same
 * steps deterministically:
 *
 *   1. copy the local Electron runtime into <out>/win-unpacked
 *   2. rename electron.exe -> <productName>.exe
 *   3. pack the application (package.json + dist + electron + electron-host)
 *      into resources/app.asar
 *   4. stage extraResources (python-runtime)
 *   5. keep only the Chinese and English Electron locales
 */
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const frontend = path.join(root, "frontend");
const out = process.argv[2] ? path.resolve(process.cwd(), process.argv[2]) : path.join(frontend, "release-manual", "win-unpacked");
const pkg = JSON.parse(await import("node:fs").then(m => m.readFileSync(path.join(frontend, "package.json"), "utf8")));
const productName = pkg.build.productName;
const exeName = `${productName}.exe`;
// No spaces, so the installer's download URL needs no escaping.
const installerName = `${productName}-setup.exe`;

if (!existsSync(path.join(frontend, "dist", "index.html"))) {
  console.error("Renderer build missing; run scripts/build-distribution.mjs first");
  process.exit(1);
}
if (!existsSync(path.join(frontend, "electron-host", "main.cjs"))
  || !existsSync(path.join(frontend, "electron-host", "metadata-worker.cjs"))
  || !existsSync(path.join(frontend, "electron-host", "mcp-mysql.cjs"))
  || !existsSync(path.join(frontend, "electron-host", "mcp-pg.cjs"))
  || !existsSync(path.join(frontend, "electron-host", "mcp-sqlite.cjs"))) {
  console.error("Electron host bundle missing; run scripts/build-distribution.mjs first");
  process.exit(1);
}

// Windows AV/indexer can briefly hold handles on a freshly written tree, and a
// previous smoke run's processes may linger; clear both before restaging.
if (process.platform === "win32") {
  spawnSync("taskkill", ["/F", "/IM", exeName], { stdio: "ignore", shell: true });
}
for (let attempt = 1; ; attempt++) {
  try { rmSync(out, { recursive: true, force: true }); break; }
  catch (error) {
    if (attempt >= 12) throw error;
    // Real-time protection can hold the previous build's asar for ~1 minute
    // after the owning process exits; re-kill stragglers and back off.
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/IM", exeName], { stdio: "ignore", shell: true });
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000 * attempt);
  }
}
mkdirSync(out, { recursive: true });

// 1. Electron runtime
cpSync(path.join(frontend, "node_modules", "electron", "dist"), out, { recursive: true });

// The stock default_app.asar is replaced by our application archive.
rmSync(path.join(out, "resources", "default_app.asar"), { force: true });

// The UI ships in Chinese and English; the other Chromium locales are ~44 MB.
const keptLocales = new Set((pkg.build?.electronLanguages ?? ["zh-CN", "en-US"]).map((locale) => `${locale}.pak`));
for (const file of readdirSync(path.join(out, "locales"))) {
  if (!keptLocales.has(file)) rmSync(path.join(out, "locales", file), { force: true });
}

// 2. Product executable name
renameSync(path.join(out, "electron.exe"), path.join(out, exeName));

// 3. Application archive
const staging = path.join(root, ".tmp", "electron-app-stage");
rmSync(staging, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
const appPkg = {
  name: "data-agent",
  productName,
  version: pkg.version,
  description: pkg.description,
  main: "electron-host/main.cjs",
  type: "commonjs",
};
writeFileSync(path.join(staging, "package.json"), JSON.stringify(appPkg, null, 2));
cpSync(path.join(frontend, "dist"), path.join(staging, "dist"), { recursive: true });
cpSync(path.join(frontend, "electron"), path.join(staging, "electron"), { recursive: true });
mkdirSync(path.join(staging, "electron-host"), { recursive: true });
for (const name of ["main.cjs", "metadata-worker.cjs", "mcp-mysql.cjs", "mcp-pg.cjs", "mcp-sqlite.cjs"]) {
  for (const file of [name, `${name}.map`]) {
    if (existsSync(path.join(frontend, "electron-host", file))) {
      cpSync(path.join(frontend, "electron-host", file), path.join(staging, "electron-host", file));
    }
  }
}

// Runtime deps the bundles keep external ship inside the archive. npm may hoist
// them to the workspace root, so probe both locations.
const moduleRoots = [path.join(frontend, "node_modules"), path.join(root, "node_modules")];
function resolveModule(name) {
  for (const dir of moduleRoots) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  console.error(`${name} not found in ${moduleRoots.join(", ")}`);
  process.exit(1);
}
mkdirSync(path.join(staging, "node_modules"), { recursive: true });
for (const name of [
  "mysql2", "aws-ssl-profiles", "denque", "generate-function", "is-property",
  "iconv-lite", "safer-buffer", "long", "lru.min", "named-placeholders", "sql-escaper",
  "@modelcontextprotocol/sdk", "ajv", "ajv-formats", "cross-spawn", "fast-deep-equal",
  "fast-uri", "json-schema-traverse", "json-schema-typed", "path-key", "require-from-string",
  "shebang-command", "shebang-regex", "which", "isexe", "zod", "zod-to-json-schema",
  // The MCP plugin supervisor reaches remote plugins over Streamable HTTP and SSE.
  "eventsource", "eventsource-parser", "pkce-challenge",
]) {
  cpSync(resolveModule(name), path.join(staging, "node_modules", name), { recursive: true });
}

const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";
exec(npxCmd, ["@electron/asar", "pack", staging, path.join(out, "resources", "app.asar")]);

// 4. extraResources. These capabilities are mandatory for a usable desktop
// package; fail closed instead of producing a silently incomplete artifact.
// Standalone CPython keeps python.exe at the root (see build-python-runtime.mjs); venv packs used Scripts/.
const pythonRuntimeExecutable = ["python.exe", "Scripts/python.exe"]
  .map((relative) => path.resolve(root, "dist", "python-runtime", relative))
  .find((candidate) => existsSync(candidate));
if (!pythonRuntimeExecutable) {
  console.error("required extraResource missing: ../dist/python-runtime/python.exe");
  process.exit(1);
}
for (const required of [
  "../.agents/skills/chart/SKILL.md",
  "../.agents/skills/spec/SKILL.md",
  "../.agents/knowledge/doc/rules.md",
  "../.agents/knowledge/doc/semantic_guide.md",
  "../.pi/SYSTEM.md",
]) {
  const source = path.resolve(frontend, required);
  if (!existsSync(source)) {
    console.error(`required extraResource missing: ${required}`);
    process.exit(1);
  }
}
const pythonProbe = spawnSync(pythonRuntimeExecutable, ["-c", "import sqlglot; print(sqlglot.__version__)"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
if (pythonProbe.status !== 0 || pythonProbe.stdout.trim() !== "30.17.0") {
  console.error("bundled Python runtime must include sqlglot 30.17.0 for strict Query Digest enforcement");
  process.exit(1);
}
for (const res of pkg.build?.extraResources ?? []) {
  const from = path.resolve(frontend, res.from);
  if (!existsSync(from)) {
    console.warn(`extraResource missing (skipped): ${res.from}`);
    continue;
  }
  const to = path.join(out, "resources", res.to);
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
}

// 5. Windows installer (NSIS from the electron-builder cache; electron-builder's
// own packaging flow intermittently fails with EPERM renaming its staging dir).
if (process.env.SKIP_INSTALLER !== "1") {
  const makensis = path.join(process.env.LOCALAPPDATA ?? "", "electron-builder", "Cache", "nsis", "nsis-3.0.4.1-nsis-3.0.4.1", "makensis.exe");
  if (!existsSync(makensis)) {
    console.warn("makensis not found; skipping installer");
  } else {
    const template = await import("node:fs").then(m => m.readFileSync(path.join(root, "scripts", "installer.template.nsi"), "utf8"));
    const releaseDir = path.dirname(out);
    const nsi = template
      .replace("{{APP_NAME}}", productName)
      .replace("{{APP_VERSION}}", pkg.version)
      .replace("{{SRC_DIR}}", path.resolve(out))
      .replace("{{OUT_FILE}}", path.resolve(releaseDir, installerName));
    const nsiPath = path.join(releaseDir, "data-agent.nsi");
    writeFileSync(nsiPath, nsi);
    exec(makensis, [nsiPath]);
    console.log(`installer OK -> ${path.join(releaseDir, installerName)}`);
  }
}

console.log(`manual packaging OK -> ${out}`);

function exec(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
  if (result.status !== 0) {
    console.error(`command failed: ${cmd} ${args.join(" ")}`);
    process.exit(1);
  }
}
