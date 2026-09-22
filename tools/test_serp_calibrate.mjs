/**
 * SERP 判定校准脚本：对导航型 / 信息型 / 交易型三类真实查询各评 3 条结果，
 * 输出 verdict 分布，作为「几乎不出值得读」修复的校准证据。
 * Key 只从 src/lib/config.js（或环境变量）读取，不写入任何会提交的内容。
 * 用法：node tools/test_serp_calibrate.mjs
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

/* ---- 载入扩展的共享脚本（间接 eval，落在全局作用域） ---- */
for (const f of ["namespace.js", "constants.js", "jev.js", "questions.js"]) {
  const code = fs.readFileSync(path.join(root, "src", "lib", f), "utf8");
  (0, eval)(code);
}
const RS = globalThis.RS;

/* ---- 取 key ---- */
let apiKey = process.env.TYPESAFE_API_KEY || "";
if (!apiKey) {
  const cfg = fs.readFileSync(path.join(root, "src", "lib", "config.js"), "utf8");
  const m = /apiKey:\s*"([^"]+)"/.exec(cfg);
  if (m) apiKey = m[1];
}
if (!apiKey) {
  console.error("没有找到 API Key。请设置 TYPESAFE_API_KEY 或填写 src/lib/config.js");
  process.exit(1);
}

const settings = {
  topics: ["AI Agent 编排", "浏览器扩展开发", "前端工程"],
  model: "jev-latest",
  timeoutMs: 20000
};

const domainOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch (e) {
    return "";
  }
};

const CASES = [
  {
    name: "导航型：字节",
    query: "字节",
    items: [
      {
        url: "https://www.bytedance.com/zh/",
        title: "字节跳动",
        snippet: "字节跳动官方网站，了解公司、产品与最新动态。"
      },
      {
        url: "https://jobs.bytedance.com/",
        title: "字节跳动招聘",
        snippet: "字节跳动招聘官网，查看在招职位并投递简历。"
      },
      {
        url: "https://zh.wikipedia.org/wiki/%E5%AD%97%E8%8A%82%E8%B7%B3%E5%8A%A8",
        title: "字节跳动 - 维基百科，自由的百科全书",
        snippet: "字节跳动是一家中国的互联网技术公司，旗下产品包括抖音、今日头条等。"
      }
    ]
  },
  {
    name: "信息型：manifest v3 service worker 生命周期",
    query: "manifest v3 service worker 生命周期",
    items: [
      {
        url: "https://developer.chrome.com/docs/extensions/develop/concepts/service-workers",
        title: "Service workers in Manifest V3 extensions - Chrome for Developers",
        snippet: "Extension service workers are the central event handlers. Learn the lifecycle: registration, activation, termination after 30 seconds of inactivity, and event registration rules."
      },
      {
        url: "https://blog.example.com/mv3-sw-notes",
        title: "MV3 Service Worker 迁移踩坑记录",
        snippet: "记录把 MV2 扩展迁移到 MV3 时 service worker 被终止、状态丢失、消息端口断开的问题，以及用 chrome.storage 和 alarms 解决的方案。"
      },
      {
        url: "https://stackoverflow.com/questions/tagged/manifest-v3",
        title: "Newest 'manifest-v3' Questions - Stack Overflow",
        snippet: "Questions tagged manifest-v3, about service worker lifecycle issues, wake-up events and state persistence in Chrome extensions."
      }
    ]
  },
  {
    name: "交易型：机械键盘 推荐",
    query: "机械键盘 推荐",
    items: [
      {
        url: "https://www.zhihu.com/question/keyboard-2026",
        title: "2026 年有哪些值得买的机械键盘推荐？ - 知乎",
        snippet: "求推荐一把 300 元以内、适合长时间打字的机械键盘，青轴茶轴红轴怎么选？"
      },
      {
        url: "https://mall.example.com/keyboards-sale",
        title: "机械键盘 - 限时特惠，全场 5 折起",
        snippet: "机械键盘价格、品牌、图片一应俱全，爆款直降，立即下单抢购！"
      },
      {
        url: "https://www.bilibili.com/video/keyboard-review",
        title: "十把热门机械键盘横评：哪一把最值得买",
        snippet: "实测十把热门机械键盘的手感、噪音与做工，从轴体到键帽逐一对比，给出购买建议。"
      }
    ]
  }
];

function line(c = "─") {
  return c.repeat(64);
}

const counts = { read: 0, skim: 0, skip: 0, other: 0 };
let apiOk = 0;
let apiFail = 0;

for (const c of CASES) {
  console.log("\n" + line());
  console.log(c.name + "  (query=\"" + c.query + "\")");
  console.log(line());
  const q = RS.questions.serpQuestions(settings);
  const tally = { read: 0, skim: 0, skip: 0 };

  for (const item of c.items) {
    const state = {
      url: item.url,
      domain: domainOf(item.url),
      title: item.title,
      snippet: item.snippet.slice(0, 400),
      engine: "google",
      query: c.query,
      focusTopics: settings.topics
    };
    try {
      const resp = await RS.jev.systemOne({
        state,
        questions: q,
        apiKey,
        model: settings.model,
        timeoutMs: settings.timeoutMs,
        maxRetries: 1
      });
      const norm = RS.questions.normalizeSerp(resp.answers, { model: resp.model, usage: resp.usage });
      tally[norm.verdict] = (tally[norm.verdict] || 0) + 1;
      if (counts[norm.verdict] != null) counts[norm.verdict]++;
      else counts.other++;
      apiOk++;
      console.log(
        "[" + norm.verdict.toUpperCase().padEnd(5) + "] " +
        "rel " + String(norm.relevance).padStart(3) + "%  " +
        "cred " + String(norm.credibility).padStart(3) + "%  " +
        "intent " + (norm.intentMatch == null ? "-" : Math.round(norm.intentMatch * 100) + "%") + "  " +
        (norm.warning ? "⚠" + norm.warning + "  " : "") +
        domainOf(item.url) + " — " + item.title.slice(0, 40)
      );
    } catch (e) {
      apiFail++;
      console.log("❌ [" + (e.code || "ERR") + "] " + e.message + "  (" + domainOf(item.url) + ")");
    }
  }
  console.log("── 小结: read=" + (tally.read || 0) + " skim=" + (tally.skim || 0) + " skip=" + (tally.skip || 0));
}

console.log("\n" + line());
console.log("总计 verdict 分布: read=" + counts.read + " skim=" + counts.skim + " skip=" + counts.skip +
  (counts.other ? " other=" + counts.other : "") +
  "  | API 成功 " + apiOk + " 失败 " + apiFail);
