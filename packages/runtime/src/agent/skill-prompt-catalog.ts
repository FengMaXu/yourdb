import { oneLine } from "../primitives.js";

export interface SkillCatalogEntry {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  readonly requiredTools?: readonly string[];
  readonly disableModelInvocation?: boolean;
}

/**
 * A Skill is available only when every tool it requires is granted. This is
 * how a protocol Skill (e.g. answer-spec) stays invisible and unloadable in a
 * composition that does not register its tools, such as an ablation arm.
 */
export function isSkillAvailable(skill: Pick<SkillCatalogEntry, "requiredTools">, grantedToolNames: ReadonlySet<string>): boolean {
  return (skill.requiredTools ?? []).every((name) => grantedToolNames.has(name));
}

/**
 * Deterministic, request-local Skill directory. It is rendered only when
 * `load_skill` is active in this request and lists only model-invocable
 * Skills whose required tools are granted.
 */
export function renderSkillCatalog(
  skills: readonly SkillCatalogEntry[],
  activeToolNames: readonly string[],
  grantedToolNames: ReadonlySet<string>,
): string {
  if (!activeToolNames.includes("load_skill")) return "";
  const visible = skills
    .filter((skill) => !skill.disableModelInvocation && isSkillAvailable(skill, grantedToolNames))
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  if (visible.length === 0) return "";
  return [
    "## 可用 Skill",
    "任务匹配时先用 `load_skill(name)` 加载对应 Skill，再按其流程执行。",
    ...visible.map((skill) => `- \`${skill.name}\`：${oneLine(skill.description)}${skill.whenToUse ? `。适用：${oneLine(skill.whenToUse)}` : ""}`),
  ].join("\n");
}
