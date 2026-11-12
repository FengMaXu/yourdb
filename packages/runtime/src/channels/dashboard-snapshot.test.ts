import { describe, expect, it } from "vitest";
import { createDashboardSnapshotter, findBrowser } from "./dashboard-snapshot.js";

function pngSize(png: Uint8Array): { width: number; height: number } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

describe.skipIf(!findBrowser())("dashboard snapshot", () => {
  it("captures the whole page, scrolled content included, as a PNG", async () => {
    const snapshot = createDashboardSnapshotter({ width: 600, scale: 1, settleMs: 100 });
    const png = await snapshot(new TextEncoder().encode("<!doctype html><body style=\"margin:0\"><div style=\"height:2000px;background:#2b6\">看板</div></body>"));
    expect(Array.from(png.slice(0, 8))).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    expect(pngSize(png)).toEqual({ width: 600, height: 2000 });
  }, 60_000);
});

describe("dashboard snapshot without a browser", () => {
  it("fails plainly on a configured browser that is missing, so the channel can fall back to the file", async () => {
    await expect(createDashboardSnapshotter({ browserPath: "Z:/missing/browser.exe" })(new Uint8Array())).rejects.toThrow("DASHBOARD_SNAPSHOT_NO_BROWSER");
  });
});
