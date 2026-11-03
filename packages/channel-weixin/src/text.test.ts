import { describe, expect, it } from "vitest";
import { answerText, pieces, plainText, publicationText, questionText, resultRows, tableText } from "./text.js";

const publication = { type: "publication.delivered" as const, receiptId: "r-1", taskId: "t-1", format: "inline" as const, publicRef: "/x" };

describe("WeChat text", () => {
  it("reads results given as CSV or as a Markdown table", () => {
    expect(resultRows("区域,销售额\n\"华东, 上海\",100\n华北,80\n")).toEqual([["区域", "销售额"], ["华东, 上海", "100"], ["华北", "80"]]);
    expect(resultRows("| 区域 | 销售额 |\n|---|---:|\n| 华东 | 100 |")).toEqual([["区域", "销售额"], ["华东", "100"]]);
  });

  it("shows the first rows of a result and says how many there are", () => {
    const rows = [["n"], ...Array.from({ length: 12 }, (_, index) => [String(index + 1)])];
    const text = tableText(rows);
    expect(text.split("\n")).toHaveLength(12);
    expect(text).toContain("共 12 行，这里显示前 10 行");
  });

  it("writes a publication with its rows, disclosure and receipt, and points to the computer when rows are left out", () => {
    const short = publicationText({ ...publication, disclosure: "按支付时间统计" }, "区域,销售额\n华东,100");
    expect(short).toContain("区域 | 销售额\n华东 | 100");
    expect(short).toContain("口径说明：按支付时间统计");
    expect(short).toContain("发布记录：r-1");
    expect(short).not.toContain("完整结果");
    const long = publicationText(publication, ["n", ...Array.from({ length: 11 }, (_, index) => String(index))].join("\n"));
    expect(long).toContain("完整结果请在电脑上的 yourdb 中查看或下载");
    expect(publicationText(publication, undefined)).toContain("完整结果");
  });

  it("turns the model's Markdown into plain text and drops links only the Web app opens", () => {
    expect(plainText("## 结论\n\n**华东**最高，见 [明细](reports/a.csv) 和 [官网](https://example.com)。\n\n- `100` 万")).toBe("结论\n\n华东最高，见 明细 和 官网（https://example.com）。\n\n• 100 万");
  });

  it("numbers the options of a question, and a number in reply picks one", () => {
    expect(questionText("统计哪种订单？", ["已支付", "全部"])).toContain("1. 已支付\n2. 全部");
    expect(answerText("2", ["已支付", "全部"])).toBe("全部");
    expect(answerText("3", ["已支付", "全部"])).toBe("3");
    expect(answerText("只看退款", ["已支付"])).toBe("只看退款");
  });

  it("cuts long text at line ends", () => {
    const text = Array.from({ length: 30 }, (_, index) => `第 ${index} 行`.padEnd(100, "。")).join("\n");
    const parts = pieces(text, 1_000);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 1_000)).toBe(true);
    expect(parts.join("\n")).toBe(text);
  });
});
