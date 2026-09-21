#!/usr/bin/env node
/**
 * 零依赖测试运行器。
 *
 *   node tests/run.mjs                # 跑全部
 *   node tests/run.mjs heuristics     # 只跑名字含 heuristics 的套件 / 用例
 *
 * 退出码：0 全绿，1 有失败。
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { suites } from "./harness/registry.mjs";

const USE_COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
const C = {
  reset: USE_COLOR ? "\x1b[0m" : "",
  dim: USE_COLOR ? "\x1b[2m" : "",
  bold: USE_COLOR ? "\x1b[1m" : "",
  red: USE_COLOR ? "\x1b[31m" : "",
  green: USE_COLOR ? "\x1b[32m" : "",
  yellow: USE_COLOR ? "\x1b[33m" : "",
  cyan: USE_COLOR ? "\x1b[36m" : ""
};

const here = path.dirname(url.fileURLToPath(import.meta.url));
const casesDir = path.join(here, "cases");
const filter = process.argv.slice(2).join(" ").trim();

if (!fs.existsSync(casesDir)) {
  console.error("找不到测试目录：" + casesDir);
  process.exit(1);
}

const files = fs
  .readdirSync(casesDir)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort();

for (const f of files) {
  const href = url.pathToFileURL(path.join(casesDir, f)).href;
  try {
    await import(href);
  } catch (e) {
    console.error(C.red + "加载测试文件失败：" + f + C.reset);
    console.error("  " + (e && e.stack ? e.stack : e));
    process.exitCode = 1;
  }
}

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];
const startedAt = Date.now();

for (const suite of suites) {
  const cases = suite.tests.filter((t) => !filter || (suite.name + " " + t.name).includes(filter));
  if (!cases.length) continue;

  console.log("\n" + C.bold + C.cyan + "▶ " + suite.name + C.reset);

  for (const t of cases) {
    const t0 = Date.now();
    try {
      await withTimeout(t.fn(), 15000, t.name);
      const ms = Date.now() - t0;
      passed++;
      console.log("  " + C.green + "✓" + C.reset + " " + t.name + C.dim + " (" + ms + "ms)" + C.reset);
    } catch (e) {
      failed++;
      const ms = Date.now() - t0;
      console.log("  " + C.red + "✗ " + t.name + C.reset + C.dim + " (" + ms + "ms)" + C.reset);
      const detail = e && e.name === "AssertionError" ? e.message : e && e.stack ? e.stack : String(e);
      console.log(indent(detail, "      ", C.red));
      failures.push({ suite: suite.name, test: t.name, detail });
    }
  }
}

if (!passed && !failed) {
  console.log(C.yellow + "\n没有匹配的测试。" + C.reset + (filter ? "（过滤器：" + filter + "）" : ""));
  process.exit(1);
}

const total = passed + failed;
const secs = ((Date.now() - startedAt) / 1000).toFixed(1);

console.log("\n" + "─".repeat(64));
if (failed === 0) {
  console.log(C.green + C.bold + "全部通过" + C.reset + "  " + passed + " / " + total + C.dim + "  ·  " + secs + "s" + C.reset);
} else {
  console.log(
    C.red + C.bold + "有失败" + C.reset + "  通过 " + C.green + passed + C.reset + " · 失败 " + C.red + failed + C.reset + " · 共 " + total + C.dim + "  ·  " + secs + "s" + C.reset
  );
  console.log(C.dim + "失败清单：" + C.reset);
  for (const f of failures) console.log("  " + C.red + "·" + C.reset + " " + f.suite + " → " + f.test);
  process.exitCode = 1;
}

if (skipped) console.log(C.dim + "跳过 " + skipped + C.reset);

// hud.js 会注册 setInterval 观察 SPA 导航，jsdom 里这些定时器不会自己停。
// 等 stdout 排空后显式退出，否则 `npm test` 跑完会一直挂着不返回。
const exitCode = process.exitCode || 0;
process.stdout.write("", () => process.exit(exitCode));

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("用例超时（" + ms + "ms）：" + label)), ms);
    Promise.resolve(promise)
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

function indent(text, pad, color) {
  return String(text)
    .split("\n")
    .map((l) => color + pad + l + C.reset)
    .join("\n");
}
