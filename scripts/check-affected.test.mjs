import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadWorkspaces, planChecks } from "./check-affected.mjs";

const workspaces = loadWorkspaces(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
const checked = (plan) => plan.check.map((item) => item.name);

test("a charts change checks charts and its dependents, and builds their dependencies", () => {
  const plan = planChecks(workspaces, ["packages/charts/src/compile.ts"]);
  assert.equal(plan.full, false);
  assert.deepEqual(new Set(checked(plan)), new Set(["@data-agent/charts", "@data-agent/runtime", "@data-agent/channel-feishu", "@data-agent/electron-host", "@data-agent/server", "frontend"]));
  assert.ok(plan.build.includes("@data-agent/contracts"));
  assert.ok(plan.build.indexOf("@data-agent/contracts") < plan.build.indexOf("@data-agent/charts"));
  assert.ok(plan.build.indexOf("@data-agent/charts") < plan.build.indexOf("@data-agent/runtime"));
  assert.ok(!checked(plan).includes("@data-agent/mcp-mysql"));
});

test("a leaf change checks only that workspace", () => {
  const plan = planChecks(workspaces, ["packages/mcp-pg/src/index.ts"]);
  assert.deepEqual(checked(plan), ["@data-agent/mcp-pg"]);
  assert.deepEqual(plan.build, ["@data-agent/mcp-pg"]);
});

test("docs alone check nothing; skills count as runtime", () => {
  assert.deepEqual(checked(planChecks(workspaces, ["docs/adr/0008.md", "README.md"])), []);
  assert.ok(checked(planChecks(workspaces, [".agents/skills/chart/SKILL.md"])).includes("@data-agent/runtime"));
});

test("root manifests and unknown paths fall back to a full run", () => {
  for (const file of ["package-lock.json", "package.json", "scripts/some-new-tool.mjs", "tsconfig.base.json"]) {
    const plan = planChecks(workspaces, [file]);
    assert.equal(plan.full, true, file);
    assert.equal(plan.check.length, workspaces.length);
  }
});

test("runtime keeps its negative type tests", () => {
  const runtime = planChecks(workspaces, ["packages/runtime/src/index.ts"]).check.find((item) => item.name === "@data-agent/runtime");
  assert.deepEqual(runtime.scripts, ["typecheck", "typecheck:negative", "test"]);
});

test("root scripts map to what actually checks them", () => {
  const architecture = planChecks(workspaces, ["scripts/verify-backend-architecture.mjs"]);
  assert.equal(architecture.full, false);
  assert.deepEqual(architecture.check, []);
  assert.deepEqual(architecture.rootScripts, []);
  const self = planChecks(workspaces, ["scripts/check-affected.mjs"]);
  assert.deepEqual(self.check, []);
  assert.deepEqual(self.rootScripts, ["test:scripts"]);
  const release = planChecks(workspaces, ["scripts/build-distribution.mjs", "scripts/smoke-web-host.mjs"]);
  assert.equal(release.full, false);
  assert.deepEqual(release.check, []);
  assert.equal(release.hints.length, 1);
});
