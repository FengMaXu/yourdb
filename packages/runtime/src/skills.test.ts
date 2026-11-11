import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, access, realpath, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { loadSkillsFromRoots, resolveSkillRoots } from "./skills.js";

describe("Skills", () => {
  it("loads migrated skills and flags unknown tools", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-agent-skills-"));
    const skillDir = join(root, "chart");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), `---\nname: chart\ndescription: charting\nallowed-tools:\n  - query_database\n  - legacy_tool\n---\n# body`, "utf8");
    const { skills, diagnostics } = await loadSkillsFromRoots([root]);
    expect(skills).toHaveLength(1);
    expect(skills[0].allowedTools).toEqual(["query_database", "legacy_tool"]);
    expect(diagnostics.some(d => d.message.includes("legacy_tool"))).toBe(true);
    await rm(root, { recursive: true, force: true });
  });

  it("uses explicit development and packaged roots", () => {
    expect(resolveSkillRoots({ projectRoot: "/project", packagedRoot: "/resources" })).toEqual([
      resolvePath("/project", ".agents", "skills"),
      resolvePath("/resources", ".agents", "skills"),
    ]);
  });

  it("does not let duplicate Skill names choose an implicit root priority", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "data-agent-project-skills-"));
    const packagedRoot = await mkdtemp(join(tmpdir(), "data-agent-packaged-skills-"));
    for (const root of [projectRoot, packagedRoot]) {
      await mkdir(join(root, "same"), { recursive: true });
      await writeFile(join(root, "same", "SKILL.md"), "---\nname: same\ndescription: duplicate\n---\nbody", "utf8");
    }
    const result = await loadSkillsFromRoots([projectRoot, packagedRoot]);
    expect(result.skills).toEqual([]);
    expect(result.diagnostics.filter((item) => item.code === "duplicate_name")).toHaveLength(2);
    await Promise.all([rm(projectRoot, { recursive: true, force: true }), rm(packagedRoot, { recursive: true, force: true })]);
  });

  it.skipIf(process.platform !== "win32")("loads an absolute Windows-style root through the native loader", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-agent-windows-skills-"));
    await mkdir(join(root, "windows"), { recursive: true });
    await writeFile(join(root, "windows", "SKILL.md"), "---\nname: windows\ndescription: Windows path regression\n---\nbody", "utf8");
    const windowsRoot = root.replaceAll("/", "\\");
    const result = await loadSkillsFromRoots([windowsRoot]);
    expect(result.diagnostics).toEqual([]);
    expect(result.skills.map((skill) => skill.name)).toEqual(["windows"]);
    // Loaded paths are canonical; a temp root may itself be an 8.3 short name such as RUNNER~1.
    expect(result.skills[0].filePath).toBe(join(await realpath(root), "windows", "SKILL.md"));
    await rm(root, { recursive: true, force: true });
  });

  it("loads a root reached through a junction or symlink", async () => {
    const real = await mkdtemp(join(tmpdir(), "data-agent-real-skills-"));
    await mkdir(join(real, "linked"), { recursive: true });
    await writeFile(join(real, "linked", "SKILL.md"), "---\nname: linked\ndescription: via link\n---\nbody", "utf8");
    const parent = await mkdtemp(join(tmpdir(), "data-agent-link-parent-"));
    const link = join(parent, "skills");
    await symlink(real, link, "junction");
    const result = await loadSkillsFromRoots([link]);
    expect(result.skills.map((skill) => skill.name)).toEqual(["linked"]);
    expect(result.skills[0].filePath).toBe(join(await realpath(real), "linked", "SKILL.md"));
    await rm(parent, { recursive: true, force: true });
    await rm(real, { recursive: true, force: true });
  });

  it("uses the native loader, skips malformed Skills, and never executes their body", async () => {
    const root = await mkdtemp(join(tmpdir(), "data-agent-native-skills-"));
    await mkdir(join(root, "valid", "nested"), { recursive: true });
    await writeFile(join(root, "valid", "nested", "SKILL.md"), "---\nname: nested\ndescription: valid\n---\n# native body", "utf8");
    await mkdir(join(root, "broken"), { recursive: true });
    await writeFile(join(root, "broken", "SKILL.md"), "# no frontmatter\n$(touch SHOULD_NOT_RUN)", "utf8");
    const result = await loadSkillsFromRoots([root]);
    expect(result.skills.map((skill) => skill.name)).toEqual(["nested"]);
    expect(result.skills[0].content).toBe("# native body");
    expect(result.diagnostics.some((item) => item.code === "invalid_metadata")).toBe(true);
    await expect(access(join(root, "SHOULD_NOT_RUN"))).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
  });

});
