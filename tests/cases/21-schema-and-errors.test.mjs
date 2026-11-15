/**
 * 存储 schema 与失败出口（suite 21）。
 *
 * 上一轮反证实验查出两处**会真的伤到用户**的盲区：
 *
 * 1. 存储层没有 schema 版本、没有字段校验。老版本升级、或数据被外部写坏时，
 *    `siteBlocklist` 可能是个字符串而不是数组 —— 设置页的
 *    `settings.siteBlocklist.join("\n")` 直接抛 TypeError，整个设置页打不开。
 *    用户唯一的出路是清扩展数据，那意味着 **API Key 与全部设置丢失**。
 *    设置页必须永远打得开 —— 那是用户唯一的自救入口。
 *
 * 2. 弹窗的 `init().catch(() => {})` 静默吞错。HUD 侧早就改掉了这个反模式，
 *    弹窗侧没改：存储读失败时弹窗**永久停在转圈**，一个字的原因都没有。
 *
 * 这两条都属于「失败时用户看到什么」，而这正是测试体系此前最薄弱的地方。
 */
import path from "node:path";
import { describe, it } from "../harness/registry.mjs";
import * as a from "../harness/assert.mjs";
import { createEnv, readFile, evalRel, loadLibs, waitFor } from "../harness/env.mjs";

/** 把 HTML 文件里声明的 <script src> 按顺序注入到 jsdom */
function loadPage(relHtml, opts = {}) {
  const html = readFile(relHtml);
  const dir = path.posix.dirname(relHtml);
  const { fetch, ...chromeOpts } = opts;
  const env = createEnv({ url: "https://read-or-skip.test/" + relHtml, html, chromeOpts, fetch });
  const srcs = [...html.matchAll(/<script src="([^"]+)"\s*>/g)].map((m) => m[1]);
  for (const src of srcs) {
    if (/(^|\/)lib\/config\.js$/.test(src)) continue;
    evalRel(env.win, path.posix.normalize(path.posix.join(dir, src)));
  }
  return env;
}

function optionsReady(env) {
  return waitFor(() => env.doc.getElementById("ver").textContent.length > 0, { label: "设置页脚本就绪" });
}

function popupReady(env) {
  return waitFor(() => env.doc.getElementById("loading").hidden, { label: "弹窗脚本就绪" });
}

/** 只注入存储层，用来单独测 getSettings 的行为 */
function loadStorageOnly(opts = {}) {
  const env = createEnv({ url: "https://read-or-skip.test/", chromeOpts: opts });
  loadLibs(env, ["storage.js"], { includeBase: true });
  return env;
}

describe("存储 schema / 脏数据不得让设置页打不开", () => {
  it("siteBlocklist 是字符串时退回数组，不抛异常", async () => {
    const env = loadStorageOnly({ store: { "rs.settings": { siteBlocklist: "abc" } } });
    const s = await env.win.RS.storage.getSettings();
    a.ok(Array.isArray(s.siteBlocklist), "siteBlocklist 必须是数组");
  });

  it("topics 不是数组时退回默认数组，不抛异常", async () => {
    const env = loadStorageOnly({ store: { "rs.settings": { topics: 42 } } });
    const s = await env.win.RS.storage.getSettings();
    a.ok(Array.isArray(s.topics), "topics 必须是数组");
  });

  it("数值字段存成字符串时退回默认值", async () => {
    const env = loadStorageOnly({
      store: { "rs.settings": { hudAutoCollapseMs: "abc", excerptChars: null } }
    });
    const s = await env.win.RS.storage.getSettings();
    a.equal(typeof s.hudAutoCollapseMs, "number");
    a.equal(typeof s.excerptChars, "number");
  });

  it("布尔字段存成 0 时退回默认值", async () => {
    const env = loadStorageOnly({ store: { "rs.settings": { showHud: 0, annotateSerp: "yes" } } });
    const s = await env.win.RS.storage.getSettings();
    a.equal(typeof s.showHud, "boolean");
    a.equal(typeof s.annotateSerp, "boolean");
  });

  it("pausedSites 不是对象时退回默认对象", async () => {
    const env = loadStorageOnly({ store: { "rs.settings": { pausedSites: "x" } } });
    const s = await env.win.RS.storage.getSettings();
    a.ok(s.pausedSites && typeof s.pausedSites === "object" && !Array.isArray(s.pausedSites));
  });

  it("老版本只有部分字段时，新字段拿到默认值、老字段原值保留", async () => {
    // 「升级不丢设置」的核心保证：合并语义必须保持。
    const env = loadStorageOnly({
      store: { "rs.settings": { apiKey: "keep_me", topics: ["老主题"] } }
    });
    const s = await env.win.RS.storage.getSettings();
    a.equal(s.apiKey, "keep_me", "老字段必须保留");
    a.deepEqual(s.topics, ["老主题"], "老字段必须保留");
    a.equal(typeof s.hudAutoCollapseMs, "number", "新增字段要拿到默认值");
    a.ok(Array.isArray(s.siteBlocklist), "新增字段要拿到默认值");
  });

  it("设置页遇到脏数据仍然打得开（用户唯一的自救入口）", async () => {
    const env = loadPage("src/options/options.html", {
      store: { "rs.settings": { siteBlocklist: "abc", topics: 42 } }
    });
    await optionsReady(env);
    a.ok(env.doc.getElementById("ver").textContent.length > 0, "设置页必须能正常打开");
    const hint = env.doc.getElementById("saveHint").textContent;
    a.notIncludes(hint, "加载设置失败", "脏数据不该被当成加载失败");
  });
});

describe("失败出口 / 每一个都要留下可读原因", () => {
  it("弹窗：存储读失败时不转圈，且说明原因", async () => {
    const env = loadPage("src/popup/popup.html", { storageGetError: new Error("存储不可用") });
    await waitFor(() => env.doc.getElementById("unsupported").hidden === false, { label: "弹窗给出失败提示" });
    a.ok(env.doc.getElementById("loading").hidden, "不得停在转圈状态");
    a.includes(env.doc.getElementById("utitle").textContent, "扩展没能启动");
    a.includes(env.doc.getElementById("udesc").textContent, "存储不可用", "必须带上原始原因");
  });

  it("设置页：存储读失败时说明原因", async () => {
    const env = loadPage("src/options/options.html", { storageGetError: new Error("存储不可用") });
    await waitFor(() => env.doc.getElementById("saveHint").textContent.includes("加载设置失败"), {
      label: "设置页失败提示"
    });
    a.includes(env.doc.getElementById("saveHint").textContent, "存储不可用");
  });

  it("设置页：主题超过上限时给出可读提示，而不是毫无反应", async () => {
    const env = loadPage("src/options/options.html", { store: { "rs.settings": {} } });
    await optionsReady(env);
    const input = env.doc.getElementById("topicInput");
    for (let i = 0; i < 12; i++) {
      input.value = "主题" + i;
      input.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }
    a.equal(env.doc.querySelectorAll("#topicTags .tag").length, 12, "应加满 12 个");
    // 第 13 个必须被拒绝，并且说明原因
    input.value = "第13个";
    input.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    a.equal(env.doc.querySelectorAll("#topicTags .tag").length, 12, "第 13 个不得被加入");
    a.includes(env.doc.getElementById("saveHint").textContent, "最多 12", "超限必须给出可读原因");
  });

  it("设置页：黑名单里的空行不得变成垃圾条目", async () => {
    const env = loadPage("src/options/options.html", { store: { "rs.settings": {} } });
    await optionsReady(env);
    const field = env.doc.getElementById("siteBlocklist");
    field.value = "a.com\n\n  \nb.com\n";
    env.doc.getElementById("save").dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
    await waitFor(() => env.doc.getElementById("saveHint").textContent.includes("已保存"), { label: "保存完成" });
    const stored = env.chrome.__store["rs.settings"];
    a.deepEqual(stored.siteBlocklist, ["a.com", "b.com"], "空行与空白项必须被过滤掉");
  });
});
