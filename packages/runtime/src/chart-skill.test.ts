import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { exampleDataset } from "@data-agent/charts";
import { checkChartSpec, type ChartSpec } from "@data-agent/contracts";
import { renderChartSvg } from "./chart-render.js";

const SKILLS = ["report", "chart"];
const repo = path.resolve(process.cwd(), "..", "..");

async function chartExamples(skill: string): Promise<{ body: string; line: number }[]> {
  // Normalise line endings: a Windows checkout may turn the file into CRLF.
  const text = (await readFile(path.join(repo, ".agents", "skills", skill, "SKILL.md"), "utf8")).replace(/\r\n/g, "\n");
  const fence = /^```json chart-spec\n([\s\S]*?)^```/gm;
  const examples: { body: string; line: number }[] = [];
  for (let match = fence.exec(text); match; match = fence.exec(text)) examples.push({ body: match[1]!, line: text.slice(0, match.index).split("\n").length });
  return examples;
}

describe("Chart examples in Skills", () => {
  for (const skill of SKILLS) {
    it(`${skill}: every chart-spec example passes the schema and renders`, async () => {
      const examples = await chartExamples(skill);
      expect(examples.length).toBeGreaterThan(0);
      for (const example of examples) {
        const where = `${skill}/SKILL.md line ${example.line}`;
        const checked = checkChartSpec(JSON.parse(example.body));
        expect(checked.ok ? [] : checked.errors, where).toEqual([]);
        const spec = (checked as { spec: ChartSpec }).spec;
        const rendered = renderChartSvg(spec, exampleDataset(spec));
        expect(rendered.ok ? [] : rendered.errors, where).toEqual([]);
      }
    });
  }
});
