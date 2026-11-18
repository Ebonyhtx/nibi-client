/**
 * 组件级证据截图：未知工具兜底卡、来源徽标折行、macOS 字体平滑 N/A 代码卡。
 *
 * 先启动 harness：
 *   pnpm exec vite --config scripts/visual-evidence/harness/vite.config.ts
 * 再运行：
 *   node scripts/visual-evidence/capture-harness.mjs <evidence-dir>
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const evidenceDir =
  process.argv[2] ??
  "C:\\Users\\ebony\\.zcode\\v2\\visualizations\\82f99954015178f5bb581d6e0a9014c220cfc1dbb7d87edbaa6cf2a8505fd833\\visual-quick-wins";
const chromePaths = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
const harnessUrl = "http://127.0.0.1:4319/";

const { existsSync } = await import("node:fs");
const executablePath = chromePaths.find((candidate) => existsSync(candidate));
if (!executablePath) throw new Error("No local Chrome/Edge executable found");

await mkdir(evidenceDir, { recursive: true });
const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 1600 }, deviceScaleFactor: 1 });
const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(String(error)));
await page.goto(harnessUrl, { waitUntil: "networkidle" });
await page.waitForSelector('[data-evidence-section="fallback"]', { timeout: 60_000 });
await page.evaluate(() => document.fonts?.ready);
await page.waitForTimeout(800);

async function screenshotSection(section, name) {
  const element = page.locator(`[data-evidence-section="${section}"]`);
  await element.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await element.screenshot({ path: join(evidenceDir, `${name}.png`) });
  return element.boundingBox();
}

const fallbackBox = await screenshotSection("fallback", "05a-fallback-tool-card-component");
const originBox = await screenshotSection("origin", "08a-origin-badge-wrap-component");
const naBox = await screenshotSection("na", "09a-macos-font-smoothing-code-card");

const facts = await page.evaluate(() => {
  const read = (element) => {
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      width: rect.width,
      height: rect.height,
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      whiteSpace: style.whiteSpace,
      overflowWrap: style.overflowWrap,
      text: (element.textContent ?? "").replace(/\s+/gu, " ").trim(),
    };
  };
  return {
    fallbackCards: Array.from(
      document.querySelectorAll('[data-evidence-section="fallback"] [data-evidence-card]'),
    ).map((card) => ({
      label: card.getAttribute("data-evidence-card"),
      hasParameters: Boolean(card.querySelector('[data-fallback-section="true"]')),
      sectionLabels: Array.from(card.querySelectorAll("h4")).map((item) =>
        (item.textContent ?? "").trim(),
      ),
      hasCopyButton: Boolean(card.querySelector('button[aria-label^="复制"], button[aria-label^="Copy"]')),
      text: (card.textContent ?? "").replace(/\s+/gu, " ").trim().slice(0, 400),
    })),
    originBadges: Array.from(
      document.querySelectorAll('[data-evidence-section="origin"] [data-evidence-dialog]'),
    ).map((dialog) => {
      const badge = dialog.querySelector('[data-interaction-origin-badge="subagent"]');
      return {
        dialog: dialog.getAttribute("data-evidence-dialog"),
        dialogWidth: Number(dialog.getAttribute("data-evidence-width")),
        badge: read(badge),
      };
    }),
    naCodeCard: read(document.querySelector('[data-evidence-section="na"] pre, [data-evidence-section="na"] div')),
  };
});

await writeFile(
  join(evidenceDir, "harness-facts.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      harnessUrl,
      viewport: { width: 1200, height: 1600 },
      screenshotBoxes: { fallbackBox, originBox, naBox },
      consoleErrors,
      ...facts,
    },
    null,
    2,
  ),
  "utf-8",
);

await browser.close();
console.log(`[harness] screenshots written to ${resolve(evidenceDir)}`);
console.log(JSON.stringify({ fallbackBox, originBox, naBox, consoleErrors }, null, 2));