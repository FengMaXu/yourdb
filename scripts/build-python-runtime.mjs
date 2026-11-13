import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const source = process.argv[2]; const output = process.argv[3];
if (!source || !output) throw new Error("Usage: node build-python-runtime.mjs <source-runtime> <output-runtime>");
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(source, output, { recursive: true, force: true });
const hash = createHash("sha256");
const requiredSqlglotVersion = "30.17.0";
const executable = path.join(output, process.platform === "win32" ? "python.exe" : "bin/python");
const files = await readFile(executable);

// Charts are drawn from ChartSpec, never in Python (ADR-0008), so the pack ships no plotting library.
// These distributions exist only for matplotlib; pillow and pyparsing are general-purpose and stay.
const PLOTTING_DISTRIBUTIONS = ["matplotlib", "contourpy", "cycler", "kiwisolver", "fonttools"];
const REMOVE_DISTRIBUTIONS = `
import importlib.metadata as md, json, pathlib, sys
removed = []
for name in json.loads(sys.argv[1]):
    try:
        dist = md.distribution(name)
    except md.PackageNotFoundError:
        continue
    root = pathlib.Path(dist.locate_file(""))
    dirs = set()
    for entry in dist.files or []:
        path = pathlib.Path(dist.locate_file(entry))
        if path.is_file():
            path.unlink()
            dirs.add(path.parent)
    for directory in sorted(dirs, key=lambda d: len(d.parts), reverse=True):
        while directory != root and directory.exists() and not any(directory.iterdir()):
            directory.rmdir()
            directory = directory.parent
    removed.append(name)
print(json.dumps(removed))
`;
// pip is only needed to build the pack; the shipped runtime never installs packages.
// User site-packages on the build machine must not mask a missing dependency.
const isolatedEnv = { ...process.env, PYTHONNOUSERSITE: "1" };
const removal = spawnSync(executable, ["-c", REMOVE_DISTRIBUTIONS, JSON.stringify([...PLOTTING_DISTRIBUTIONS, "pip"])], { encoding: "utf8", env: isolatedEnv });
if (removal.status !== 0) {
  console.error(`Removing plotting libraries and pip failed\n${removal.stderr || removal.stdout}`);
  process.exit(1);
}

// Build-time and GUI parts of a standalone CPython, plus the test suites that
// numpy and pandas install alongside their code; none are imported at runtime.
const UNUSED_PATHS = ["tcl", "include", "libs", "Lib/idlelib", "Lib/tkinter", "Lib/turtledemo", "Lib/ensurepip", "Lib/test", "DLLs/_tkinter.pyd", "DLLs/tcl86t.dll", "DLLs/tk86t.dll"];
for (const relative of UNUSED_PATHS) await rm(path.join(output, relative), { recursive: true, force: true });
for (const entry of await readdir(path.join(output, "Lib", "site-packages"), { recursive: true, withFileTypes: true }).catch(() => [])) {
  if (entry.isDirectory() && entry.name === "tests" && /[\\/](numpy|pandas)([\\/]|$)/.test(entry.parentPath)) {
    await rm(path.join(entry.parentPath, entry.name), { recursive: true, force: true });
  }
}

// A ._pth file fixes sys.path to the pack and keeps `site` from adding the
// user's own site-packages, so packages a user installed with their Python
// cannot shadow the pack's numpy/pandas/sqlglot. It also ignores PYTHON* env
// vars, which Python jobs already strip.
if (process.platform === "win32") {
  const dll = (await readdir(output)).find((name) => /^python3\d+\.dll$/i.test(name));
  if (!dll) throw new Error("python3XY.dll not found; cannot write the ._pth isolation file");
  await writeFile(path.join(output, `${dll.slice(0, -4)}._pth`), ["DLLs", "Lib", "Lib\\site-packages", "."].join("\r\n") + "\r\n", "utf8");
}

// The manifest must describe an executable capability, not an intended one.
// Fail the pack build if the data dependencies are unimportable or a plotting library is still present.
const dataCheck = spawnSync(executable, ["-c", "import importlib.util, numpy, pandas, sqlglot; print('sqlglot='+sqlglot.__version__); print('matplotlib=' + ('present' if importlib.util.find_spec('matplotlib') else 'absent'))"], { encoding: "utf8", env: isolatedEnv });
if (dataCheck.status !== 0 || !dataCheck.stdout.includes(`sqlglot=${requiredSqlglotVersion}`) || !dataCheck.stdout.includes("matplotlib=absent")) {
  console.error(`Python data/query pack is incomplete or still ships matplotlib: numpy, pandas and sqlglot ${requiredSqlglotVersion} must import, matplotlib must be absent\n${dataCheck.stderr || dataCheck.stdout}`);
  process.exit(1);
}
hash.update(files);
const manifest = { runtimeId: `python-data-${process.platform}-${process.arch}`, pythonVersion: process.env.PYTHON_VERSION ?? "3.13.x", platform: process.platform, arch: process.arch, packs: ["base", "data", "sqlglot"], sha256: hash.digest("hex") };
await writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
console.log(JSON.stringify(manifest));
