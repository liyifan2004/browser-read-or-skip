/**
 * 开发自测脚本：直接调用 Jev，验证 questions.js 的问法与 normalize 映射是否成立。
 * 用法：
 *   node tools/test_jev.mjs            # 从 src/lib/config.js 读取 key
 *   TYPESAFE_API_KEY=xxx node tools/test_jev.mjs
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

const CASES = [
  {
    name: "A. 高质量技术长文（应判 read）",
    state: {
      url: "https://developer.chrome.com/docs/extensions/develop/concepts/service-workers",
      domain: "developer.chrome.com",
      title: "Service workers in Manifest V3 extensions",
      focusTopics: settings.topics,
      stats: { charCount: 6400, paragraphs: 34, headings: 12, codeBlocks: 9, linkDensity: 0.08 },
      content:
        "Extension service workers are an extension's central event handler. Unlike the web platform, " +
        "extension service workers have a hard lifetime: after 30 seconds of inactivity Chrome terminates them. " +
        "This means you must persist state in chrome.storage rather than in module-level variables. " +
        "Event listeners must be registered synchronously at the top level of the service worker script, " +
        "otherwise a restarted worker will not know which events to wake up for. " +
        "For long-running work, call chrome.alarms with a minimum period of 30 seconds; setInterval is unreliable. " +
        "Importing scripts: importScripts() works only in classic workers; module workers use static imports. " +
        "Common failure mode: keeping an in-flight fetch alive across termination — use a message port or " +
        "chrome.runtime.onMessage with a returned promise. Debugging is done from chrome://extensions → " +
        "Inspect views: service worker."
    }
  },
  {
    name: "B. 营销 / listicle（应判 skip 或 skim）",
    state: {
      url: "https://example-blog.com/top-10-ai-tools-2026",
      domain: "example-blog.com",
      title: "2026 年必装的 10 个 AI 神器，第 3 个我用了三年",
      focusTopics: settings.topics,
      stats: { charCount: 1800, paragraphs: 12, headings: 10, codeBlocks: 0, linkDensity: 0.31 },
      content:
        "AI 正在改变世界！今天给大家盘点 2026 年最值得装的 10 款 AI 神器。第一名：XX写作助手，一键生成公众号爆文，"
        + "限时优惠 5 折，点击下方链接立即购买！第二名：YY 绘图工具，输入文字即可出图。第三名：ZZ 会议纪要，"
        + "自动总结会议内容。这些工具我都亲测好用，真正做到零门槛上手。现在下单还送价值 999 元的会员大礼包，名额有限先到先得！"
    }
  },
  {
    name: "C. 搜索结果条目（SERP）",
    state: {
      url: "https://zhuanlan.zhihu.com/p/123456789",
      domain: "zhuanlan.zhihu.com",
      title: "从零实现一个浏览器扩展：Manifest V3 的 Service Worker 生命周期踩坑记录",
      snippet: "记录我在把 MV2 扩展迁移到 MV3 时遇到的服务端 worker 被终止、状态丢失、消息端口断开的问题，以及用 chrome.storage 和 alarms 解决的方案。",
      query: "manifest v3 service worker 生命周期",
      focusTopics: settings.topics
    },
    serp: true
  }
];

function line(c = "─") {
  return c.repeat(64);
}

let pass = 0;

for (const c of CASES) {
  console.log("\n" + line());
  console.log(c.name);
  console.log(line());
  const q = c.serp ? RS.questions.serpQuestions(settings) : RS.questions.pageQuestions(settings);
  const t0 = Date.now();
  try {
    const resp = await RS.jev.systemOne({
      state: c.state,
      questions: q,
      apiKey,
      model: settings.model,
      timeoutMs: settings.timeoutMs,
      maxRetries: 0
    });
    const ms = Date.now() - t0;
    const norm = c.serp
      ? RS.questions.normalizeSerp(resp.answers, { model: resp.model, usage: resp.usage })
      : RS.questions.normalizePage(resp.answers, { model: resp.model, usage: resp.usage });

    console.log("耗时 " + ms + "ms  |  模型 " + resp.model +
      "  |  tokens " + resp.usage.input_tokens + "/" + resp.usage.output_tokens);
    console.log("判定: " + norm.verdict + (norm.value ? "  阅读价值: " + norm.value : ""));
    console.log("相关度 " + norm.relevance + "%  新信息 " + norm.novelty + "%  可信度 " + norm.credibility +
      (norm.timelessness != null ? "%  时效性 " + norm.timelessness + "%" : "%"));
    console.log("置信度: " + norm.confidence + "  警告: " + (norm.warning || "无"));
    console.log("理由: " + (norm.reason || "-"));
    console.log("原始 answers:");
    console.log(JSON.stringify(resp.answers, null, 2));

    const want = { "A. 高质量技术长文（应判 read）": "read", "B. 营销 / listicle（应判 skip 或 skim）": ["skip", "skim"] };
    const expect = want[c.name];
    if (expect && (Array.isArray(expect) ? expect.includes(norm.verdict) : norm.verdict === expect)) {
      pass++;
      console.log("✅ PASS");
    } else if (expect) {
      console.log("⚠️  与预期不符（预期 " + expect + "）");
    }
  } catch (e) {
    console.log("❌ 失败: [" + (e.code || "ERR") + "] " + e.message);
  }
}

console.log("\n" + line());
console.log("断言通过 " + pass + " / 2");
