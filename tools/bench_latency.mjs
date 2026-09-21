/**
 * 延迟基准：输入长度对 Jev 往返耗时的影响。
 * 用来确定「摘录上限」这个默认值该怎么定。
 * 用法：node tools/bench_latency.mjs
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
for (const f of ["namespace.js", "constants.js", "jev.js", "questions.js"]) {
  (0, eval)(fs.readFileSync(path.join(root, "src", "lib", f), "utf8"));
}
const RS = globalThis.RS;

let apiKey = process.env.TYPESAFE_API_KEY || "";
if (!apiKey) {
  const m = /apiKey:\s*"([^"]+)"/.exec(fs.readFileSync(path.join(root, "src", "lib", "config.js"), "utf8"));
  if (m) apiKey = m[1];
}
if (!apiKey) {
  console.error("缺少 API Key");
  process.exit(1);
}

// 用一段真实感较强的技术文本反复拼接，模拟不同长度的页面
const PARA =
  "扩展的 service worker 与网页 worker 不同：Chrome 会在闲置 30 秒后终止它。因此模块级变量不可靠，" +
  "状态必须写进 chrome.storage。事件监听必须在顶层同步注册，否则 worker 重启后不知道要唤醒哪些事件。" +
  "长时间任务要用 chrome.alarms，最小间隔 30 秒，setInterval 不可靠。";

const settings = { topics: ["浏览器扩展开发", "AI Agent 编排"] };

const SIZES = [500, 1500, 3000, 6000];
const ROUNDS = 2;

console.log("输入字符数\t平均耗时\t输入tokens\t输出tokens");
console.log("-".repeat(56));

for (const size of SIZES) {
  let content = "";
  while (content.length < size) content += PARA + "\n";
  content = content.slice(0, size);

  const times = [];
  let inTok = 0;
  let outTok = 0;

  for (let i = 0; i < ROUNDS; i++) {
    const t0 = Date.now();
    try {
      const resp = await RS.jev.systemOne({
        state: { url: "https://developer.chrome.com/docs/extensions", title: "Service worker 生命周期", content, focusTopics: settings.topics },
        questions: RS.questions.pageQuestions(settings),
        apiKey,
        model: "jev-latest",
        timeoutMs: 20000,
        maxRetries: 0
      });
      times.push(Date.now() - t0);
      inTok = resp.usage.input_tokens;
      outTok = resp.usage.output_tokens;
    } catch (e) {
      console.log(size + "\t\t失败: " + e.message);
      break;
    }
  }
  if (times.length) {
    const avg = Math.round(times.reduce((a, b) => a + b, 0) / times.length);
    console.log(size + "\t\t" + avg + "ms\t\t" + inTok + "\t\t" + outTok);
  }
}
