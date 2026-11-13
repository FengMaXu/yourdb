import { access, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? "");
if (!root) throw new Error("Usage: node smoke-python-runtime.mjs <runtime-root");
const requiredSqlglotVersion = "30.17.0";
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
const executable = path.join(root, process.platform === "win32" ? "python.exe" : "bin/python");
await access(executable);
await new Promise((resolve, reject) => {
  const child = spawn(executable, ["-c", "import importlib.util, numpy, pandas, sqlglot; print('data-agent-python-runtime-ok'); print('matplotlib=' + ('present' if importlib.util.find_spec('matplotlib') else 'absent')); print('sqlglot='+sqlglot.__version__)"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  let error = "";
  child.stdout.on("data", chunk => output += chunk);
  child.stderr.on("data", chunk => error += chunk);
  child.on("error", reject);
  child.on("close", code => code === 0 && output.includes("data-agent-python-runtime-ok") && output.includes("matplotlib=absent") && output.includes(`sqlglot=${requiredSqlglotVersion}`)
    ? resolve()
    : reject(new Error(`runtime smoke failed: ${code}: ${error || output}`)));
});
console.log(JSON.stringify({ ok: true, runtimeId: manifest.runtimeId, pythonVersion: manifest.pythonVersion }));
