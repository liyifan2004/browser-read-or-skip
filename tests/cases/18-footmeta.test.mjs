/**
 * 卡片底部元信息（footMeta）。
 *
 * 这里的字段都是数字，用真值判断就会踩 `0` 的坑：抽取和评估都足够快时，
 * 耗时正好是 0，`if (r.elapsedMs)` 会让"耗时 xx ms"整段消失 —— 而且消失与否
 * 取决于那一次运行是不是恰好 0 毫秒。这类"偶尔少一行"的显示没人会当成缺陷，
 * 只会觉得界面有点飘。
 *
 * 发现路径：16 的基线对比用例偶发失败（8 次里失败 1～4 次），差异只有
 * 「SPAN 28 vs 29」，追下去是 `.sep` 少了一个，再追是 footMeta 少了一段。
 */
import { describe, it } from "../harness/registry.mjs";
import * as a from "../harness/assert.mjs";
import { createEnv, loadContentScript, waitFor } from "../harness/env.mjs";

const LONG_CN = "这是一段用于测试的正文内容，长度足够让启发式打分认为它是一篇真实文章。".repeat(20);

function articleHtml() {
  return (
    "<!doctype html><html lang='zh-CN'><head><title>一篇足够长的文章</title></head><body><article><p>" +
    LONG_CN +
    "</p></article></body></html>"
  );
}

function modelResult() {
  return {
    kind: "page",
    verdict: "read",
    relevance: 94,
    novelty: 78,
    credibility: 88,
    timelessness: 62,
    value: "high",
    valueKey: "high",
    contentType: "tutorial",
    contentTypeKey: "tutorial",
    redundancy: 0.12,
    confidence: 0.82,
    lowConfidence: false,
    warning: null,
    source: "jev",
    model: "jev-1.13.0",
    usage: { input_tokens: 900, output_tokens: 200 },
    reason: "内容新且来源可信。",
    elapsedMs: 380,
    at: Date.now()
  };
}

function shadow(env) {
  const host = env.doc.getElementById("read-or-skip-host");
  return host ? host.shadowRoot : null;
}

async function boot(freezeClock) {
  const env = createEnv({
    url: "https://example.com/post/footmeta",
    html: articleHtml(),
    chromeOpts: { onRuntimeSendMessage: () => Promise.resolve({ ok: true, result: modelResult() }) }
  });
  // 冻结时钟：评估开始与结束取到同一个值，elapsedMs 必然是 0
  if (freezeClock) env.win.performance.now = () => 0;
  loadContentScript(env, 0);
  await waitFor(() => {
    const root = shadow(env);
    return root && root.querySelector(".plabel") && root.querySelector(".plabel").textContent === "值得读";
  }, { label: "模型结论落地" });
  return env;
}

describe("hud / 底部元信息", () => {
  it("耗时恰好 0ms 时仍然显示，而不是整段消失", async () => {
    const env = await boot(true);
    const foot = shadow(env).querySelector(".footmeta");
    a.ok(foot, "应有底部元信息");
    a.includes(foot.textContent, "耗时 0ms", "0 是合法耗时，不是「没有耗时」");
    a.includes(foot.textContent, "字", "字数是另一段，不受影响");
  });

  it("正常耗时不显示成 0ms", async () => {
    const env = await boot(false);
    const foot = shadow(env).querySelector(".footmeta");
    a.match(foot.textContent, /耗时 \d+ms/, "应带耗时");
  });
});
