import { describe, expect, it } from "vitest";
import path from "node:path";
import { createModels, type Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { defineDataAgentTool } from "../tools/tool-definition.js";
import { loadSkillsFromRoots } from "../skills.js";
import { isSkillAvailable, renderSkillCatalog } from "./skill-prompt-catalog.js";
import { ToolPromptCatalog } from "./tool-prompt-catalog.js";
import { withToolPromptCatalog } from "./tool-prompt-models.js";

const skills = [
  { name: "query-task", description: "ablation flow", requiredTools: ["begin_query_task"] },
  { name: "spec", description: "Answer Spec\n流程", whenToUse: "每个取数请求", requiredTools: ["set_answer_spec", "query_database"] },
  { name: "hidden", description: "application only", disableModelInvocation: true },
  { name: "chart", description: "charting" },
];

describe("Skill catalog", () => {
  it("lists only model-invocable Skills whose required tools are granted, in a stable order", () => {
    const granted = new Set(["load_skill", "set_answer_spec", "query_database"]);
    expect(renderSkillCatalog(skills, ["load_skill", "query_database"], granted)).toBe([
      "## 可用 Skill",
      "任务匹配时先用 `load_skill(name)` 加载对应 Skill，再按其流程执行。",
      "- `chart`：charting",
      "- `spec`：Answer Spec 流程。适用：每个取数请求",
    ].join("\n"));
    expect(isSkillAvailable(skills[0]!, granted)).toBe(false);
  });

  it("renders nothing when load_skill is not active in the request", () => {
    expect(renderSkillCatalog(skills, ["query_database"], new Set(["load_skill", "query_database"]))).toBe("");
  });

  it("prepends the Skill catalog before the tool directory at the Models seam", async () => {
    const faux = fauxProvider({ provider: "skill-catalog", models: [{ id: "model" }] });
    const models = createModels();
    models.setProvider(faux.provider);
    const loadSkill = defineDataAgentTool({
      name: "load_skill",
      label: "load_skill",
      description: "load",
      replay: "safe",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() { return { content: [{ type: "text", text: "ok" }], details: null }; },
    }, { promptSnippet: "加载技能。", promptGuidelines: ["只加载现存技能。"] });
    let prompt = "";
    faux.setResponses([async (context) => { prompt = context.systemPrompt ?? ""; return fauxAssistantMessage("ok"); }]);
    const wrapped = withToolPromptCatalog(models, new ToolPromptCatalog([loadSkill]), {
      renderPreamble: (active) => renderSkillCatalog(skills, active, new Set(["load_skill"])),
    });
    const base: Context = { systemPrompt: "BASE", messages: [], tools: [loadSkill.tool] };
    await wrapped.streamSimple(faux.models[0], base).result();
    expect(prompt.indexOf("BASE")).toBe(0);
    expect(prompt.indexOf("## 可用 Skill")).toBeGreaterThan(0);
    expect(prompt.indexOf("## 可用 Skill")).toBeLessThan(prompt.indexOf("## 当前可用工具"));
    expect(prompt).toContain("`chart`");
    expect(prompt).not.toContain("`spec`");
  });

  it("ships the protocol Skills with the metadata that keeps each arm exclusive", async () => {
    const repo = path.resolve(process.cwd(), "..", "..");
    const { skills: loaded, diagnostics } = await loadSkillsFromRoots([
      path.join(repo, ".agents", "skills"),
      path.join(repo, "evaluations", "spider2", "skills"),
    ]);
    expect(diagnostics.filter((item) => item.path.includes("spec") || item.path.includes("query-task"))).toEqual([]);
    const spec = loaded.find((skill) => skill.name === "spec");
    const queryTask = loaded.find((skill) => skill.name === "query-task");
    // The semantic and ablation arms each have their own protocol Skill, so neither sees the other's tools.
    expect(spec).toMatchObject({ requiredTools: ["set_answer_spec", "query_database"], whenToUse: expect.any(String) });
    expect(queryTask).toMatchObject({ requiredTools: ["begin_query_task", "query_database"] });
    expect(spec?.allowedTools).toBeUndefined();
  });
});
