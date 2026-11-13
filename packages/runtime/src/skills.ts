import { readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { unquoted } from "./primitives.js";

export interface SkillDefinition {
  readonly name: string;
  readonly description: string;
  readonly content: string;
  readonly filePath: string;
  readonly allowedTools?: string[];
  /** Tools that must be granted for the Skill to be listed or loaded (e.g. Answering protocol Skills). */
  readonly requiredTools?: string[];
  /** Model-visible trigger rendered in the Skill catalog next to the description. */
  readonly whenToUse?: string;
  readonly disableModelInvocation?: boolean;
}

export interface SkillDiagnostic {
  path: string;
  message: string;
  code?: string;
}

const CANONICAL_TOOLS = new Set([
  "list_workspace", "read_file", "write_file", "run_python",
  "search_knowledge", "read_knowledge", "update_knowledge",
  "load_skill", "generate_dashboard", "show_widget", "render_chart",
  "query_database", "publish_query_result", "ask_user_clarification",
  "export_query", "begin_answer_spec", "revise_answer_spec", "set_answer_spec", "begin_query_task", "inspect_answer",
  "subagent",
]);

export interface SkillRootOptions {
  /** Repository root used by development installs. */
  projectRoot?: string;
  /** Application resources root used by packaged installs. */
  packagedRoot?: string;
}

/** Resolve only the two application-owned Skill roots. */
export function resolveSkillRoots(options: SkillRootOptions = {}): string[] {
  const developmentRoot = path.resolve(options.projectRoot ?? process.cwd(), ".agents", "skills");
  const packagedRoot = path.resolve(options.packagedRoot ?? options.projectRoot ?? process.cwd(), ".agents", "skills");
  return [...new Set([developmentRoot, packagedRoot])];
}

function diagnostic(filePath: string, message: string, code?: string): SkillDiagnostic {
  return code ? { path: filePath, message, code } : { path: filePath, message };
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function frontmatterValue(frontmatter: string, key: string): string | undefined {
  const match = new RegExp(`^${key}\\s*:\\s*(.+)$`, "mi").exec(frontmatter);
  return match?.[1] === undefined ? undefined : unquoted(match[1]);
}

function parseToolList(frontmatter: string, keys: readonly string[], label: string, filePath: string, diagnostics: SkillDiagnostic[]): string[] | undefined {
  let key: RegExpExecArray | null = null;
  for (const candidate of keys) {
    key = new RegExp(`^${candidate}\\s*:`, "mi").exec(frontmatter);
    if (key) break;
  }
  if (!key) return undefined;
  const line = frontmatter.slice(key.index).split("\n")[0] ?? "";
  const inline = line.slice(line.indexOf(":") + 1).trim();
  const values: string[] = [];
  if (inline) {
    if (!inline.startsWith("[") || !inline.endsWith("]")) {
      diagnostics.push(diagnostic(filePath, `${label} must be a list`, "invalid_metadata"));
    } else {
      values.push(...inline.slice(1, -1).split(",").map(unquoted).filter(Boolean));
    }
  } else {
    const start = frontmatter.slice(key.index + key[0].length);
    for (const item of start.split("\n")) {
      if (/^\s*-\s*/.test(item)) {
        const value = /^\s*-\s*(\S.*?)\s*$/.exec(item)?.[1];
        if (value) values.push(unquoted(value));
      } else if (item.trim() && !/^\s/.test(item)) break;
    }
  }
  const unknown = values.filter((tool) => !CANONICAL_TOOLS.has(tool));
  if (unknown.length > 0) diagnostics.push(diagnostic(filePath, `unknown tool names: ${unknown.join(", ")}`, "unknown_tool"));
  return values;
}

function parseToolMetadata(frontmatter: string, filePath: string): { allowedTools?: string[]; requiredTools?: string[]; disableModelInvocation?: boolean; diagnostics: SkillDiagnostic[] } {
  const diagnostics: SkillDiagnostic[] = [];
  const allowedTools = parseToolList(frontmatter, ["allowed-tools", "allowedTools"], "allowed-tools", filePath, diagnostics);
  const requiredTools = parseToolList(frontmatter, ["requires-tools", "requiredTools"], "requires-tools", filePath, diagnostics);
  const disabled = frontmatterValue(frontmatter, "disable-model-invocation") ?? frontmatterValue(frontmatter, "disableModelInvocation");
  return {
    ...(allowedTools ? { allowedTools } : {}),
    ...(requiredTools ? { requiredTools } : {}),
    ...(disabled === "true" ? { disableModelInvocation: true } : {}),
    diagnostics,
  };
}

function parseSkill(raw: string, filePath: string): { skill?: SkillDefinition; diagnostics: SkillDiagnostic[] } {
  const diagnostics: SkillDiagnostic[] = [];
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---\n")) return { diagnostics: [diagnostic(filePath, "missing frontmatter", "invalid_metadata")] };
  const marker = normalized.indexOf("\n---", 4);
  if (marker < 0) return { diagnostics: [diagnostic(filePath, "unterminated frontmatter", "invalid_metadata")] };
  const frontmatter = normalized.slice(4, marker);
  const name = frontmatterValue(frontmatter, "name");
  const description = frontmatterValue(frontmatter, "description");
  if (!name || !description) return { diagnostics: [diagnostic(filePath, "name and description are required", "invalid_metadata")] };
  const metadata = parseToolMetadata(frontmatter, filePath);
  diagnostics.push(...metadata.diagnostics);
  const whenToUse = frontmatterValue(frontmatter, "when_to_use") ?? frontmatterValue(frontmatter, "whenToUse");
  const body = normalized.slice(marker + 4).replace(/^\n/, "").trim();
  return {
    skill: {
      name,
      description,
      content: body,
      filePath,
      ...(metadata.allowedTools ? { allowedTools: metadata.allowedTools } : {}),
      ...(metadata.requiredTools ? { requiredTools: metadata.requiredTools } : {}),
      ...(whenToUse ? { whenToUse } : {}),
      ...(metadata.disableModelInvocation ? { disableModelInvocation: true } : {}),
    },
    diagnostics,
  };
}

async function skillFiles(root: string, diagnostics: SkillDiagnostic[]): Promise<string[]> {
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      diagnostics.push(diagnostic(directory, error instanceof Error ? error.message : String(error), "read_failed"));
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name === "SKILL.md") files.push(full);
    }
  };
  await walk(root);
  return files;
}

/** Load model resources without making Pi a capability-layer dependency. */
export async function loadSkillsFromRoots(roots: string[]): Promise<{ skills: SkillDefinition[]; diagnostics: SkillDiagnostic[] }> {
  const normalizedRoots = [...new Set(roots.map((root) => path.resolve(root)))];
  const diagnostics: SkillDiagnostic[] = [];
  const trustedRoots: string[] = [];
  for (const root of normalizedRoots) {
    try {
      trustedRoots.push(await realpath(root));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") diagnostics.push(diagnostic(root, error instanceof Error ? error.message : String(error), "read_failed"));
    }
  }
  const candidates: SkillDefinition[] = [];
  // Scan each root by its canonical path: a root reached through a junction, a symlink or an
  // 8.3 short name (C:\Users\RUNNER~1) differs from its realpath but is still the same root.
  for (const root of [...new Set(trustedRoots)]) {
    for (const filePath of await skillFiles(root, diagnostics)) {
      let canonicalFilePath: string;
      try {
        canonicalFilePath = await realpath(filePath);
      } catch (error) {
        diagnostics.push(diagnostic(filePath, error instanceof Error ? error.message : String(error), "read_failed"));
        continue;
      }
      if (!trustedRoots.some((trusted) => isWithinRoot(trusted, canonicalFilePath))) {
        diagnostics.push(diagnostic(filePath, "skill path escapes configured root", "path_escape"));
        continue;
      }
      let raw: string;
      try {
        raw = await readFile(canonicalFilePath, "utf8");
      } catch (error) {
        diagnostics.push(diagnostic(filePath, error instanceof Error ? error.message : String(error), "read_failed"));
        continue;
      }
      const parsed = parseSkill(raw, canonicalFilePath);
      diagnostics.push(...parsed.diagnostics);
      if (parsed.skill) candidates.push(parsed.skill);
    }
  }
  const counts = new Map<string, number>();
  for (const skill of candidates) counts.set(skill.name, (counts.get(skill.name) ?? 0) + 1);
  const skills = candidates.filter((skill) => {
    if ((counts.get(skill.name) ?? 0) <= 1) return true;
    diagnostics.push(diagnostic(skill.filePath, `duplicate skill name: ${skill.name}`, "duplicate_name"));
    return false;
  });
  return { skills, diagnostics };
}
