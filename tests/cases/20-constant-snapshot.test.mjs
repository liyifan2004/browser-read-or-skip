/**
 * 常量表快照（suite 20）。
 *
 * 上一轮反证实验查出的同一类盲区，在这个仓库里出现了三次：
 *
 * - 可信度名单 `TRUST_HIGH`（42 项）里 43 个域名**零覆盖** ——
 *   原有断言只有形态级（全小写、无空格），挡不住「删掉一个域名」。
 * - 搜索引擎数据表（`snippetSel` / `titleSel` / `hosts`）只有「结构完整」
 *   断言，删掉一条 Google 摘要选择器，321 条用例全绿。
 * - 默认设置 18 个字段里只有 1 个被断言了内容 ——
 *   默认关注主题加一项「区块链技术」，同样全绿。
 *
 * 根因一样：**常量表不能自己守自己**。断言「列表非空」「数组有 N 项」
 * 只能守住结构，守不住内容；而内容就是用户能感知的东西 ——
 * 可信度差 33 分会翻转结论，默认主题决定了首装用户的相关度基准。
 *
 * 这里用一份**独立的快照文件**当锚点（tests/fixtures/trust-lists.txt），
 * 加上对 DEFAULT_SETTINGS / 引擎表的整表 deepEqual。
 * 表可以变，但必须与快照对得上 —— 改动要留下痕迹。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "../harness/registry.mjs";
import * as a from "../harness/assert.mjs";
import { createEnv, loadLibs } from "../harness/env.mjs";

const ROOT = path.resolve(process.cwd());

/** 读快照文件里的某一段（## 标题分隔） */
function snapshotSection(text, section) {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.trim() === "## " + section);
  if (start < 0) throw new Error("快照里没有 ## " + section);
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("## ")) break;
    if (line && !line.startsWith("#")) out.push(line);
  }
  return out;
}

function loadConstants() {
  const env = createEnv({});
  loadLibs(env, [], { includeBase: true });
  return env.win.RS;
}

describe("常量表 / 可信度名单快照", () => {
  it("TRUST_HIGH 与快照逐条一致", () => {
    const RS = loadConstants();
    const snap = fs.readFileSync(path.join(ROOT, "tests/fixtures/trust-lists.txt"), "utf8");
    const expected = snapshotSection(snap, "TRUST_HIGH");
    const actual = RS.TRUST_HIGH;
    const missing = expected.filter((d) => !actual.includes(d));
    const extra = actual.filter((d) => !expected.includes(d));
    a.deepEqual(missing, [], "高可信名单少了这些（对照 tests/fixtures/trust-lists.txt）：" + missing.join(", "));
    a.deepEqual(extra, [], "高可信名单多了这些：" + extra.join(", "));
  });

  it("TRUST_LOW 与快照逐条一致", () => {
    const RS = loadConstants();
    const snap = fs.readFileSync(path.join(ROOT, "tests/fixtures/trust-lists.txt"), "utf8");
    const expected = snapshotSection(snap, "TRUST_LOW");
    const actual = RS.TRUST_LOW;
    const missing = expected.filter((d) => !actual.includes(d));
    const extra = actual.filter((d) => !expected.includes(d));
    a.deepEqual(missing, [], "低可信名单少了这些：" + missing.join(", "));
    a.deepEqual(extra, [], "低可信名单多了这些：" + extra.join(", "));
  });

  it("可信名单里没有重复项", () => {
    const RS = loadConstants();
    for (const name of ["TRUST_HIGH", "TRUST_LOW"]) {
      const seen = new Set();
      const dups = [];
      for (const d of RS[name]) {
        if (seen.has(d)) dups.push(d);
        seen.add(d);
      }
      a.deepEqual(dups, [], name + " 有重复项：" + dups.join(", "));
    }
  });
});

describe("常量表 / 默认设置快照", () => {
  it("DEFAULT_SETTINGS 的内容不得漂移", () => {
    const RS = loadConstants();
    const d = RS.DEFAULT_SETTINGS;
    // 默认关注主题直接决定首装用户的「相关度」基准 ——
    // 悄悄加一项就等于把用户的评分基准换掉，而界面上没有任何地方说明。
    a.deepEqual(d.topics, ["AI / 大模型", "浏览器扩展开发", "前端工程"], "默认关注主题不得漂移");
    // 隐私模式的默认值决定了「正文摘录是否离开用户机器」。
    a.equal(d.privacyMode, "full", "隐私模式默认必须是 full");
    // 判定词与等级标签
    a.deepEqual(RS.VALUE_LABEL, { high: "高", medium: "中", low: "低" });
    a.deepEqual(RS.VERDICT_ORDER, ["read", "skim", "skip"]);
  });

  it("默认站点黑名单不得漂移", () => {
    const RS = loadConstants();
    const list = RS.DEFAULT_SETTINGS.siteBlocklist;
    a.ok(list.includes("localhost"), "默认黑名单应含 localhost");
    a.ok(list.includes("/login"), "默认黑名单应含 /login");
    a.ok(list.includes("mail.google.com"), "默认黑名单应含 mail.google.com");
    // 预置的社交流名单是刻意选的三个，注释里写了理由
    a.ok(list.includes("weibo.com"), "默认黑名单应含 weibo.com");
    a.ok(list.includes("x.com"), "默认黑名单应含 x.com");
    a.ok(list.includes("douyin.com"), "默认黑名单应含 douyin.com");
  });
});

describe("常量表 / 搜索引擎数据表", () => {
  it("每个引擎的关键选择器都在位", () => {
    const RS = loadConstants();
    const engines = RS.engines.ENGINES;
    const google = engines.find((e) => e.id === "google");
    // Google 改版时摘要选择器最先失效；删掉它症状是「摘要静默为空」，
    // 用户只看到内容变短，排查成本极高。
    a.ok(google.snippetSel.includes(".VwiC3b"), "Google 摘要选择器 .VwiC3b 不得丢失");
    a.equal(google.titleSel, "a h3", "Google 标题选择器不得改动");
    a.ok(google.resultSel.includes("div.MjjYud"), "Google 结果选择器 div.MjjYud 不得丢失");
    a.ok(google.hosts.includes(".google.com"), "Google 主机名不得丢失 .google.com");
    a.ok(google.hosts.includes(".google.com.hk"), "Google 主机名不得丢失 .google.com.hk");
    a.ok(google.hosts.includes(".google.com.tw"), "Google 主机名不得丢失 .google.com.tw");
  });

  it("每个引擎都有查询参数与结果选择器", () => {
    const RS = loadConstants();
    for (const engine of RS.engines.ENGINES) {
      const id = engine.id;
      a.ok(Array.isArray(engine.queryParams) && engine.queryParams.length > 0, id + " 缺 queryParams");
      a.ok(Array.isArray(engine.resultSel) && engine.resultSel.length > 0, id + " 缺 resultSel");
      a.ok(typeof engine.titleSel === "string" && engine.titleSel, id + " 缺 titleSel");
      a.ok(Array.isArray(engine.hosts) && engine.hosts.length > 0, id + " 缺 hosts");
    }
  });
});
