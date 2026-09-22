/**
 * 弹窗页与设置页（popup.js / options.js）。
 * 这两页是"配置入口"，坏了用户连 Key 都填不进去，必须能真跑起来。
 */
import path from "node:path";
import { describe, it } from "../harness/registry.mjs";
import * as a from "../harness/assert.mjs";
import { createEnv, readFile, evalRel, waitFor, sleep, jsonResponse } from "../harness/env.mjs";

/** 把 HTML 文件里声明的 <script src> 按顺序注入到 jsdom */
function loadPage(relHtml, opts = {}) {
  const html = readFile(relHtml);
  const dir = path.posix.dirname(relHtml);
  // fetch 要单独传给 createEnv，不能混进 chrome 模拟的选项里（否则会落到"禁止真实请求"的兜底上）
  const { fetch, ...chromeOpts } = opts;
  const env = createEnv({ url: "https://read-or-skip.test/" + relHtml, html, chromeOpts, fetch });
  const srcs = [...html.matchAll(/<script src="([^"]+)"\s*>/g)].map((m) => m[1]);
  for (const src of srcs) {
    // 跳过本地密钥文件：它带有真实 Key，测试里一律用 config.example.js 的空值代替
    if (/(^|\/)lib\/config\.js$/.test(src)) continue;
    evalRel(env.win, path.posix.normalize(path.posix.join(dir, src)));
  }
  env.scriptSources = srcs;
  return env;
}

/**
 * 等页面脚本真正跑完。
 * 注意不能用 `!card.hidden` 这类条件：那些元素在静态 HTML 里就是可见的，
 * 条件一开始就成立，等于没等，后面所有断言都会读到脚本执行前的初始值。
 */
function popupReady(env) {
  return waitFor(() => env.doc.getElementById("loading").hidden, { label: "弹窗脚本就绪" });
}

function optionsReady(env) {
  return waitFor(() => env.doc.getElementById("ver").textContent.length > 0, { label: "设置页脚本就绪" });
}

const errText = (env) => env.pageErrors.map((e) => (e && e.message) || String(e));

function hudState(over = {}) {
  return Object.assign(
    {
      ok: true,
      mounted: true,
      expanded: true,
      skipped: null,
      page: { title: "标题", domain: "example.com", charCount: 4200 },
      result: {
        kind: "page",
        verdict: "read",
        relevance: 94,
        novelty: 78,
        credibility: 88,
        timelessness: 62,
        value: "high",
        valueKey: "high",
        contentType: "tutorial",
        redundancy: 0.1,
        confidence: 0.82,
        lowConfidence: false,
        warning: null,
        source: "jev",
        model: "jev-1.13.0",
        elapsedMs: 380,
        readingMinutes: 9,
        reason: "内容新且来源可信。"
      }
    },
    over
  );
}

describe("popup / 渲染", () => {
  it("页面脚本按 HTML 声明的顺序加载，且能跑起来", async () => {
    const env = loadPage("src/popup/popup.html", { onTabsSendMessage: () => Promise.resolve(hudState()) });
    await popupReady(env);
    a.deepEqual(env.scriptSources, [
      "../lib/namespace.js",
      "../lib/constants.js",
      "../lib/storage.js",
      "../lib/heuristics.js",
      "popup.js"
    ]);
    a.ok(env.win.RS);
  });

  it("展示判定结论、指标与元信息", async () => {
    const env = loadPage("src/popup/popup.html", { onTabsSendMessage: () => Promise.resolve(hudState()) });
    await popupReady(env);

    a.equal(env.doc.getElementById("vlabel").textContent, "值得认真读");
    a.includes(env.doc.getElementById("score").textContent, "88");
    a.includes(env.doc.getElementById("vreason").textContent, "内容新且来源可信");

    const metrics = env.doc.getElementById("metrics").innerHTML;
    a.includes(metrics, "相关度");
    a.includes(metrics, "94%");
    a.includes(metrics, "新信息");
    a.includes(metrics, "可信度");

    const chips = env.doc.getElementById("chips").innerHTML;
    a.includes(chips, "阅读价值");
    a.includes(chips, "高");
    a.includes(chips, "教程");
    a.includes(chips, "9");

    const meta = env.doc.getElementById("metaline").textContent;
    a.includes(meta, "jev");
    a.includes(meta, "380ms");
    a.includes(meta, "example.com");
    a.equal(env.doc.getElementById("loading").hidden, true, "加载提示应已收起");
    a.deepEqual(errText(env), [], "页面脚本不应抛出未捕获异常");
  });

  it("高重复度时弹出「可能没有太多新信息」标记", async () => {
    const env = loadPage("src/popup/popup.html", {
      onTabsSendMessage: () => Promise.resolve(hudState({ result: Object.assign(hudState().result, { warning: "redundant" }) }))
    });
    await popupReady(env);
    a.includes(env.doc.getElementById("chips").innerHTML, "可能没有太多新信息");
  });

  it("各种「不评估」的原因都说清楚，而不是一句无力的失败", async () => {
    const cases = [
      ["serp", "直接标在每条结果上", "搜索结果页"],
      ["off", "浮层已在设置里关闭", "浮层已关闭"],
      ["blocked", "跳过评估", "站点已跳过"],
      ["not-readable", "不是", "不是可读页面"]
    ];
    for (const [skipped, expect, titleExpect] of cases) {
      const env = loadPage("src/popup/popup.html", {
        onTabsSendMessage: () => Promise.resolve({ ok: true, mounted: false, skipped, result: null, page: null })
      });
      await waitFor(() => !env.doc.getElementById("unsupported").hidden, { label: skipped + " 提示" });
      a.includes(env.doc.getElementById("udesc").textContent, expect, skipped + " 的说明不对");
      a.includes(env.doc.getElementById("utitle").textContent, titleExpect, skipped + " 的标题不对");
      a.equal(env.doc.getElementById("card").hidden, true);
    }
  });

  it("内容脚本联系不上时给出可操作的提示", async () => {
    const env = loadPage("src/popup/popup.html", {
      onTabsSendMessage: () => Promise.reject(new Error("Could not establish connection"))
    });
    await waitFor(() => !env.doc.getElementById("unsupported").hidden, { label: "兜底提示" });
    a.includes(env.doc.getElementById("udesc").textContent, "刷新");
  });

  it("扩展自身的页面被识别为不可注入", async () => {
    const env = loadPage("src/popup/popup.html", {
      tabs: [{ id: 1, active: true, url: "chrome://extensions" }],
      onTabsSendMessage: () => Promise.reject(new Error("no receiver"))
    });
    await waitFor(() => !env.doc.getElementById("unsupported").hidden, { label: "兜底提示" });
    a.includes(env.doc.getElementById("udesc").textContent, "内部页面");
  });

  it("统计行显示已评估页数、建议跳过数与缓存条数", async () => {
    const env = loadPage("src/popup/popup.html", {
      store: {
        "rs.stats": { calls: 12, inputTokens: 9000, outputTokens: 2000, pages: 10, verdicts: { read: 4, skim: 3, skip: 3 } },
        "rs.cache": { "https://a.com/1": { at: Date.now(), partial: false, result: {} } }
      },
      onTabsSendMessage: () => Promise.resolve(hudState())
    });
    await waitFor(() => env.doc.getElementById("stats").textContent.includes("10"), { label: "统计渲染" });
    const t = env.doc.getElementById("stats").textContent;
    a.includes(t, "已评估");
    a.includes(t, "10");
    a.includes(t, "缓存");
    a.includes(t, "1");
  });
});

describe("popup / 交互", () => {
  it("两个开关反映当前设置，改动会写回存储", async () => {
    const env = loadPage("src/popup/popup.html", {
      store: { "rs.settings": { showHud: true, annotateSerp: true } },
      onTabsSendMessage: () => Promise.resolve(hudState())
    });
    await popupReady(env);

    const hud = env.doc.getElementById("tg-hud");
    const serp = env.doc.getElementById("tg-serp");
    a.equal(hud.checked, true);
    a.equal(serp.checked, true);

    hud.checked = false;
    hud.dispatchEvent(new env.win.Event("change", { bubbles: true }));
    await sleep(20);
    a.equal(env.chrome.__store["rs.settings"].showHud, false, "关掉浮层应写回存储");

    serp.checked = false;
    serp.dispatchEvent(new env.win.Event("change", { bubbles: true }));
    await sleep(20);
    a.equal(env.chrome.__store["rs.settings"].annotateSerp, false);
  });

  it("重新评估会请求内容脚本强制刷新", async () => {
    const sent = [];
    const env = loadPage("src/popup/popup.html", {
      onTabsSendMessage: (tabId, msg) => {
        sent.push(msg);
        return Promise.resolve(hudState());
      }
    });
    await popupReady(env);
    env.doc.getElementById("reeval").dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
    await waitFor(() => sent.some((m) => m.type === "RS_FORCE_REFRESH"), { label: "发出强制刷新" });
    a.ok(true);
  });

  it("打开设置会请求后台打开设置页（入口收敛后只剩顶栏齿轮）", async () => {
    const env = loadPage("src/popup/popup.html", { onTabsSendMessage: () => Promise.resolve(hudState()) });
    await popupReady(env);
    env.doc.getElementById("gear").dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
    await sleep(30);
    a.equal(env.chrome.__log.openOptions, 1);
  });
});

describe("options / 表单", () => {
  function bootOptions(chromeOpts = {}) {
    return loadPage("src/options/options.html", chromeOpts);
  }

  it("把已有设置灌进表单", async () => {
    const env = bootOptions({
      store: {
        "rs.settings": {
          apiKey: "apikey_x",
          model: "jev-1.13.0",
          topics: ["RAG 评测", "Postgres 索引调优"],
          showHud: false,
          privacyMode: "titles",
          excerptChars: 3000,
          cacheLimit: 120,
          siteBlocklist: ["localhost", "/login"]
        }
      }
    });
    await optionsReady(env);
    a.equal(env.doc.getElementById("apiKey").value, "apikey_x");
    a.equal(env.doc.getElementById("model").value, "jev-1.13.0");
    a.equal(env.doc.getElementById("showHud").checked, false);
    a.equal(env.doc.getElementById("privacyMode").value, "titles");
    a.equal(env.doc.getElementById("excerptChars").value, "3000");
    a.equal(env.doc.getElementById("cacheLimit").value, "120");
    a.includes(env.doc.getElementById("siteBlocklist").value, "localhost");
    a.equal(env.doc.querySelectorAll("#topicTags .tag").length, 2);
    a.includes(env.doc.getElementById("ver").textContent, env.win.RS.version);
  });

  it("API Key 默认打码，可点按钮显示", async () => {
    const env = bootOptions({ store: { "rs.settings": { apiKey: "apikey_secret" } } });
    await optionsReady(env);
    a.equal(env.doc.getElementById("apiKey").value, "apikey_secret");
    const input = env.doc.getElementById("apiKey");
    a.equal(input.type, "password");
    env.doc.getElementById("toggleKey").dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
    a.equal(input.type, "text");
    a.equal(env.doc.getElementById("toggleKey").textContent, "隐藏");
    env.doc.getElementById("toggleKey").dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
    a.equal(input.type, "password");
  });

  it("回车添加主题、点 × 删除、去重、上限 12 个", async () => {
    const env = bootOptions({ store: { "rs.settings": { topics: [] } } });
    await optionsReady(env);

    const input = env.doc.getElementById("topicInput");
    const addTopic = (v) => {
      input.value = v;
      input.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    };

    addTopic("RAG 评测");
    addTopic("浏览器扩展");
    a.equal(env.doc.querySelectorAll("#topicTags .tag").length, 2);

    addTopic("RAG 评测");
    a.equal(env.doc.querySelectorAll("#topicTags .tag").length, 2, "重复主题不该再加一条");

    for (let i = 0; i < 15; i++) addTopic("主题" + i);
    a.equal(env.doc.querySelectorAll("#topicTags .tag").length, 12, "主题最多 12 个");

    env.doc.querySelector("#topicTags .tag button").dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
    a.equal(env.doc.querySelectorAll("#topicTags .tag").length, 11);
  });

  it("保存按钮把表单写回存储，并给出反馈", async () => {
    const env = bootOptions({ store: { "rs.settings": { topics: [] } } });
    await optionsReady(env);

    env.doc.getElementById("apiKey").value = "apikey_new";
    env.doc.getElementById("model").value = "jev-1.13.0";
    env.doc.getElementById("excerptChars").value = "1234";
    env.doc.getElementById("cacheTtl").value = "3";
    env.doc.getElementById("save").dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));

    await waitFor(() => env.doc.getElementById("saveHint").textContent.includes("已保存"), { label: "保存反馈" });
    const saved = env.chrome.__store["rs.settings"];
    a.equal(saved.apiKey, "apikey_new");
    a.equal(saved.model, "jev-1.13.0");
    a.equal(saved.excerptChars, 1234);
    a.equal(saved.cacheTtlMs, 3 * 24 * 60 * 60 * 1000, "天要换算成毫秒");
  });

  it("数值越界会被夹紧到合法区间", async () => {
    const env = bootOptions({ store: { "rs.settings": {} } });
    await optionsReady(env);
    env.doc.getElementById("excerptChars").value = "999999";
    env.doc.getElementById("timeout").value = "1";
    env.doc.getElementById("cacheLimit").value = "-5";
    env.doc.getElementById("save").dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
    await waitFor(() => env.doc.getElementById("saveHint").textContent.includes("已保存"), { label: "保存反馈" });
    const saved = env.chrome.__store["rs.settings"];
    a.equal(saved.excerptChars, 30000);
    a.equal(saved.timeoutMs, 1000);
    a.equal(saved.cacheLimit, 50);
  });

  it("清空缓存与恢复默认设置可用", async () => {
    const env = bootOptions({
      store: {
        "rs.settings": { apiKey: "apikey_x", excerptChars: 1234 },
        "rs.cache": { "https://a.com/1": { at: Date.now(), result: {} } }
      }
    });
    await optionsReady(env);

    env.doc.getElementById("clearCache").dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
    await waitFor(() => env.doc.getElementById("saveHint").textContent.includes("缓存已清空"), { label: "清缓存反馈" });
    a.deepEqual(env.chrome.__store["rs.cache"], {});

    env.doc.getElementById("resetSettings").dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
    await waitFor(() => env.doc.getElementById("excerptChars").value === "6000", { label: "恢复默认" });
    a.equal(env.doc.getElementById("apiKey").value, "", "恢复默认会清掉 Key，用户需要重新填");
  });

  it("用量面板给出调用次数、token 与估算花费", async () => {
    const env = bootOptions({
      store: {
        "rs.stats": { calls: 20, inputTokens: 50000, outputTokens: 4000, pages: 18, verdicts: { read: 6, skim: 6, skip: 6 } }
      }
    });
    await waitFor(() => env.doc.getElementById("statgrid").textContent.includes("18"), { label: "统计渲染" });
    const t = env.doc.getElementById("statgrid").textContent;
    a.includes(t, "累计评估页数");
    a.includes(t, "18");
    a.includes(t, "模型调用次数");
    a.includes(t, "20");
    a.includes(t, "54,000");
    a.match(t, /¥0\.0/, "应给出人民币估算花费");
  });
});

describe("options / 连接自测", () => {
  it("没填 Key 时直接提示，不发请求", async () => {
    const env = loadPage("src/options/options.html", { store: { "rs.settings": {} } });
    await optionsReady(env);
    env.doc.getElementById("apiKey").value = "";
    env.doc.getElementById("testBtn").dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
    await waitFor(() => env.doc.getElementById("testResult").textContent.includes("请先填写"), { label: "提示" });
    a.equal(env.fetchCalls.length, 0);
  });

  it("连接成功时报告模型名与往返耗时", async () => {
    const env = loadPage("src/options/options.html", {
      store: { "rs.settings": { apiKey: "apikey_ok" } },
      fetch: () =>
        Promise.resolve(
          jsonResponse({
            model: "jev-1.13.0",
            answers: { alive: { type: "noul", noul: 1 } },
            usage: { input_tokens: 42, output_tokens: 3 }
          })
        )
    });
    await optionsReady(env);
    a.equal(env.doc.getElementById("apiKey").value, "apikey_ok");
    env.doc.getElementById("testBtn").dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
    await waitFor(() => env.doc.getElementById("testResult").className.includes("ok"), { label: "成功提示" });
    a.includes(env.doc.getElementById("testResult").textContent, "jev-1.13.0");
    a.includes(env.doc.getElementById("testResult").textContent, "42");
    a.equal(env.fetchCalls.length, 1);
  });

  it("连接失败时给出常见原因，而不是只丢一个错误码", async () => {
    const env = loadPage("src/options/options.html", {
      store: { "rs.settings": { apiKey: "apikey_bad" } },
      fetch: () => Promise.resolve(jsonResponse({ error: "unauthorized" }, 401))
    });
    await optionsReady(env);
    a.equal(env.doc.getElementById("apiKey").value, "apikey_bad");
    env.doc.getElementById("testBtn").dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
    await waitFor(() => env.doc.getElementById("testResult").className.includes("bad"), { label: "失败提示" });
    const t = env.doc.getElementById("testResult").textContent;
    a.includes(t, "API Key");
    a.includes(t, "早期访问");
  });
});
