/**
 * background service worker：消息路由、缓存、并发池、徽章、快捷键。
 * 这是唯一持有 API Key 和唯一发跨域请求的地方，也是"重新评估没反应"这类问题的源头。
 */
import { describe, it } from "../harness/registry.mjs";
import * as a from "../harness/assert.mjs";
import { createEnv, loadBackground, jsonResponse, sleep } from "../harness/env.mjs";
import { dispatch, emit } from "../harness/chrome-mock.mjs";

function pageJev(over = {}) {
  return Object.assign(
    {
      model: "jev-1.13.0",
      answers: {
        verdict: { type: "choice", choice: "read", confidence: 0.82, probabilities: { read: 0.88 } },
        relevance: { type: "score", score: 3.9 },
        novelty: { type: "score", score: 3.1 },
        credibility: { type: "score", score: 3.8 },
        redundancy: { type: "noul", noul: 0.1 },
        value: { type: "choice", choice: "high", probabilities: { high: 0.9 } },
        contentType: { type: "choice", choice: "reference", probabilities: { reference: 0.9 } },
        timelessness: { type: "score", score: 3 }
      },
      usage: { input_tokens: 900, output_tokens: 220 }
    },
    over
  );
}

function serpJev(choice = "read") {
  return {
    model: "jev-1.13.0",
    answers: {
      verdict: { type: "choice", choice, confidence: 0.9, probabilities: { [choice]: 0.9 } },
      relevance: { type: "score", score: 3.9 },
      credibility: { type: "score", score: 3.0 },
      intentMatch: { type: "noul", noul: 0.9 }
    },
    usage: { input_tokens: 100, output_tokens: 20 }
  };
}

function bootSw(opts = {}) {
  const env = createEnv({
    url: "https://example.com/background",
    chromeOpts: {
      store: opts.store || {},
      tabs: opts.tabs || [{ id: 7, active: true, url: "https://example.com/a" }]
    },
    fetch: opts.fetchImpl || (() => Promise.resolve(jsonResponse(pageJev())))
  });
  loadBackground(env, opts.config === "missing" || !opts.config ? { hideConfig: true } : { configStub: opts.config });
  return env;
}

const TAB = { tab: { id: 7, url: "https://example.com/a" } };

function send(env, msg, sender = TAB) {
  return dispatch(env.chrome.__listeners.message, msg, sender);
}

function payload(url = "https://x.com/p/1") {
  return {
    page: { url, title: "标题", domain: "x.com", text: "内容".repeat(300), charCount: 600 },
    state: { url, title: "标题", content: "内容".repeat(100), focusTopics: ["测试"] }
  };
}

describe("sw / 装载", () => {
  it("config.js 缺失时回落到模板，仍能正常启动", () => {
    const env = bootSw();
    a.ok(env.win.RS, "RS 命名空间应已建立");
    a.isFunction(env.win.RS.jev.systemOne);
    a.isFunction(env.win.RS.questions.normalizePage);
    a.ok(env.win.RS.DEFAULT_CONFIG, "应加载到默认配置模板");
    a.equal(env.win.RS.DEFAULT_CONFIG.apiKey, "", "模板里的 Key 应为空");
  });

  it("有 config.js 时用它填充默认配置", () => {
    const env = bootSw({ config: { apiKey: "apikey_stub", model: "jev-1.13.0" } });
    a.equal(env.win.RS.DEFAULT_CONFIG.apiKey, "apikey_stub");
  });
});

describe("sw / 网页评估路由", () => {
  it("首次评估：调模型、写缓存、记统计、刷徽章", async () => {
    let calls = 0;
    const env = bootSw({
      store: { "rs.settings": { apiKey: "k" } },
      fetchImpl: () => {
        calls++;
        return Promise.resolve(jsonResponse(pageJev()));
      }
    });
    const res = await send(env, { type: env.win.RS.MSG.EVALUATE, payload: payload() });

    a.equal(res.ok, true);
    a.equal(res.from, "jev");
    a.equal(res.result.verdict, "read");
    a.equal(res.result.source, "jev");
    a.isNumber(res.result.elapsedMs);
    a.equal(res.result.approximate, false);
    a.equal(calls, 1);

    const stats = await env.win.RS.storage.getStats();
    a.equal(stats.calls, 1);
    a.equal(stats.pages, 1);
    a.equal(stats.inputTokens, 900);
    a.equal(stats.verdicts.read, 1);

    const cached = await env.win.RS.storage.getCacheEntry("https://x.com/p/1", null);
    a.ok(cached, "应写入缓存");
    a.equal(cached.title, "标题");

    a.equal(env.chrome.__log.badgeText.length, 1);
    a.equal(env.chrome.__log.badgeText[0].tabId, 7);
    a.equal(env.chrome.__log.badgeText[0].text, "读");
    a.equal(env.chrome.__log.badgeColor[0].color, env.win.RS.VERDICT.read.color);
    a.includes(env.chrome.__log.title[0].title, "值得认真读");
  });

  it("第二次同样请求命中缓存，不再调模型", async () => {
    let calls = 0;
    const env = bootSw({
      store: { "rs.settings": { apiKey: "k" } },
      fetchImpl: () => {
        calls++;
        return Promise.resolve(jsonResponse(pageJev()));
      }
    });
    await send(env, { type: env.win.RS.MSG.EVALUATE, payload: payload() });
    const second = await send(env, { type: env.win.RS.MSG.EVALUATE, payload: payload() });
    a.equal(second.from, "cache");
    a.equal(second.result.source, "cache");
    a.equal(calls, 1, "缓存命中不该再发请求");
  });

  it("force=true 时绕过缓存，真的重新问一次模型", async () => {
    let calls = 0;
    const env = bootSw({
      store: { "rs.settings": { apiKey: "k" } },
      fetchImpl: () => {
        calls++;
        return Promise.resolve(jsonResponse(pageJev()));
      }
    });
    await send(env, { type: env.win.RS.MSG.EVALUATE, payload: payload() });
    a.equal(calls, 1);
    const forced = await send(env, {
      type: env.win.RS.MSG.EVALUATE,
      payload: Object.assign(payload(), { force: true })
    });
    a.equal(forced.from, "jev", "点「重新评估」必须真的重新问，而不是把缓存再吐一遍");
    a.equal(calls, 2);
  });

  it("没配 Key 时返回 NO_KEY，而不是抛异常", async () => {
    const env = bootSw({ store: { "rs.settings": { apiKey: "" } } });
    const res = await send(env, { type: env.win.RS.MSG.EVALUATE, payload: payload() });
    a.equal(res.ok, false);
    a.equal(res.error.code, "NO_KEY");
    a.equal(env.chrome.__log.badgeText.length, 0, "失败不应该刷徽章");
  });

  it("扩展暂停时直接拒绝，且不发请求", async () => {
    let calls = 0;
    const env = bootSw({
      store: { "rs.settings": { apiKey: "k", enabled: false } },
      fetchImpl: () => {
        calls++;
        return Promise.resolve(jsonResponse(pageJev()));
      }
    });
    const res = await send(env, { type: env.win.RS.MSG.EVALUATE, payload: payload() });
    a.equal(res.error.code, "DISABLED");
    a.equal(calls, 0);
  });

  it("缺页面数据时返回 NO_PAGE", async () => {
    const env = bootSw({ store: { "rs.settings": { apiKey: "k" } } });
    const res = await send(env, { type: env.win.RS.MSG.EVALUATE, payload: {} });
    a.equal(res.error.code, "NO_PAGE");
  });

  it("模型报错时把错误码透传给前端，不刷徽章", async () => {
    const env = bootSw({
      store: { "rs.settings": { apiKey: "bad" } },
      fetchImpl: () => Promise.resolve(jsonResponse({}, 401))
    });
    const res = await send(env, { type: env.win.RS.MSG.EVALUATE, payload: payload() });
    a.equal(res.ok, false);
    a.equal(res.error.code, "HTTP_401");
    a.equal(res.error.status, 401);
    a.equal(env.chrome.__log.badgeText.length, 0);
  });

  it("内容脚本没带 state 时后台能自己拼一个最低限度的 state", async () => {
    let body = null;
    const env = bootSw({
      store: { "rs.settings": { apiKey: "k", excerptChars: 50 } },
      fetchImpl: (_url, init) => {
        body = JSON.parse(init.body);
        return Promise.resolve(jsonResponse(pageJev()));
      }
    });
    await send(env, {
      type: env.win.RS.MSG.EVALUATE,
      payload: { page: { url: "https://x.com/p/2", title: "t", domain: "x.com", text: "正文".repeat(100) } }
    });
    a.equal(body.state.url, "https://x.com/p/2");
    a.equal(body.state.content.length, 50, "兜底 state 也要遵守摘录上限");
  });

  it("没有 tab 上下文（例如设置页触发）时不会因为刷徽章而崩", async () => {
    const env = bootSw({ store: { "rs.settings": { apiKey: "k" } } });
    const res = await send(env, { type: env.win.RS.MSG.EVALUATE, payload: payload() }, {});
    a.equal(res.ok, true);
    a.equal(env.chrome.__log.badgeText.length, 0);
  });

  it("未知消息类型不响应，也不抛错", async () => {
    const env = bootSw();
    const res = await send(env, { type: "RS_NOT_A_REAL_TYPE" });
    a.equal(res, undefined);
  });

  it("REQUEST_STATE 能按 URL 取出缓存（搜索结果预判的消费端）", async () => {
    const env = bootSw({ store: { "rs.settings": { apiKey: "k" } } });
    await send(env, { type: env.win.RS.MSG.EVALUATE, payload: payload() });
    const res = await send(env, { type: env.win.RS.MSG.REQUEST_STATE, url: "https://x.com/p/1" });
    a.equal(res.ok, true);
    a.equal(res.entry.result.verdict, "read");
    const none = await send(env, { type: env.win.RS.MSG.REQUEST_STATE, url: "https://x.com/nope" });
    a.equal(none.entry, null);
  });

  it("OPEN_OPTIONS 会打开设置页", async () => {
    const env = bootSw();
    const res = await send(env, { type: env.win.RS.MSG.OPEN_OPTIONS });
    a.equal(res.ok, true);
    a.equal(env.chrome.__log.openOptions, 1);
  });
});

describe("sw / 搜索结果批量评估", () => {
  const items = [
    { url: "https://a.com/1", title: "甲标题甲", snippet: "摘要一" },
    { url: "https://b.com/2", title: "乙标题乙", snippet: "摘要二" },
    { url: "https://c.com/3", title: "丙标题丙", snippet: "摘要三" }
  ];

  it("逐条返回结果，并写成 partial 缓存", async () => {
    const env = bootSw({
      store: { "rs.settings": { apiKey: "k" } },
      fetchImpl: () => Promise.resolve(jsonResponse(serpJev("read")))
    });
    const res = await send(env, {
      type: env.win.RS.MSG.EVALUATE_SERP,
      payload: { engine: "google", query: "q", items }
    });
    a.equal(res.ok, true);
    a.equal(Object.keys(res.results).length, 3);
    a.equal(res.results["https://a.com/1"].kind, "serp");
    a.equal(res.results["https://a.com/1"].partial, true);

    const cached = await env.win.RS.storage.getCacheEntry("https://a.com/1", null);
    a.ok(cached, "预判结果应写进缓存，供点进去时秒出");
    a.equal(cached.partial, true);
  });

  it("命中缓存时不重复计入调用次数与 token", async () => {
    let calls = 0;
    const env = bootSw({
      store: { "rs.settings": { apiKey: "k" } },
      fetchImpl: () => {
        calls++;
        return Promise.resolve(jsonResponse(serpJev("skim")));
      }
    });
    const payload = { engine: "google", query: "q", items };
    await send(env, { type: env.win.RS.MSG.EVALUATE_SERP, payload });
    let st = await env.win.RS.storage.getStats();
    a.equal(st.calls, 3, "三条新结果 = 三次调用");
    a.equal(st.inputTokens, 300);

    await send(env, { type: env.win.RS.MSG.EVALUATE_SERP, payload });
    st = await env.win.RS.storage.getStats();
    a.equal(calls, 3, "第二次应该全部命中缓存");
    a.equal(st.calls, 3, "缓存命中不该再累加调用次数");
    a.equal(st.inputTokens, 300, "token 也不该重复累加");
  });

  it("遵守 serpMaxResults 上限", async () => {
    let calls = 0;
    const env = bootSw({
      store: { "rs.settings": { apiKey: "k", serpMaxResults: 2 } },
      fetchImpl: () => {
        calls++;
        return Promise.resolve(jsonResponse(serpJev()));
      }
    });
    const res = await send(env, { type: env.win.RS.MSG.EVALUATE_SERP, payload: { engine: "google", items } });
    a.equal(Object.keys(res.results).length, 2);
    a.equal(calls, 2);
  });

  it("并发受限，不会一次性打爆接口", async () => {
    let inFlight = 0;
    let peak = 0;
    const env = bootSw({
      store: { "rs.settings": { apiKey: "k", serpMaxResults: 20 } },
      fetchImpl: () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        return new Promise((resolve) =>
          setTimeout(() => {
            inFlight--;
            resolve(jsonResponse(serpJev()));
          }, 12)
        );
      }
    });
    const many = Array.from({ length: 12 }, (_, i) => ({
      url: "https://s" + i + ".com/p",
      title: "标题" + i,
      snippet: "摘要"
    }));
    const res = await send(env, { type: env.win.RS.MSG.EVALUATE_SERP, payload: { engine: "google", items: many } });
    a.equal(Object.keys(res.results).length, 12);
    a.lte(peak, 5, "并发上限应生效");
    a.gte(peak, 2, "应该是并发而不是串行");
  });

  it("个别条目失败不影响其余结果", async () => {
    let n = 0;
    const env = bootSw({
      store: { "rs.settings": { apiKey: "k" } },
      fetchImpl: () => {
        n++;
        return n === 2 ? Promise.resolve(jsonResponse({}, 422)) : Promise.resolve(jsonResponse(serpJev()));
      }
    });
    const res = await send(env, { type: env.win.RS.MSG.EVALUATE_SERP, payload: { engine: "google", items } });
    a.equal(res.ok, true, "只要有一条成功就算成功");
    a.equal(Object.keys(res.results).length, 2);
    a.ok(res.error, "应把第一个错误带回去，供界面提示");
    a.equal(res.error.code, "HTTP_422");
  });

  it("全部失败时 ok 为 false，且错误只有一个", async () => {
    const env = bootSw({
      store: { "rs.settings": { apiKey: "k" } },
      fetchImpl: () => Promise.resolve(jsonResponse({}, 401))
    });
    const res = await send(env, { type: env.win.RS.MSG.EVALUATE_SERP, payload: { engine: "google", items } });
    a.equal(res.ok, false);
    a.equal(res.error.code, "HTTP_401");
    a.deepEqual(res.results, {});
  });

  it("关掉结果页标注后直接拒绝", async () => {
    const env = bootSw({ store: { "rs.settings": { apiKey: "k", annotateSerp: false } } });
    const res = await send(env, { type: env.win.RS.MSG.EVALUATE_SERP, payload: { engine: "google", items } });
    a.equal(res.error.code, "DISABLED");
  });

  it("空列表安全返回空结果", async () => {
    const env = bootSw({ store: { "rs.settings": { apiKey: "k" } } });
    const res = await send(env, { type: env.win.RS.MSG.EVALUATE_SERP, payload: { engine: "google", items: [] } });
    a.equal(res.ok, true);
    a.deepEqual(res.results, {});
  });

  it("搜索结果预判不会盖掉页面完整评估", async () => {
    const env = bootSw({
      store: { "rs.settings": { apiKey: "k" } },
      fetchImpl: () => Promise.resolve(jsonResponse(pageJev()))
    });
    await send(env, { type: env.win.RS.MSG.EVALUATE, payload: payload("https://a.com/1") });
    await send(env, {
      type: env.win.RS.MSG.EVALUATE_SERP,
      payload: { engine: "google", items: [{ url: "https://a.com/1", title: "甲标题甲", snippet: "摘要" }] }
    });
    const cached = await env.win.RS.storage.getCacheEntry("https://a.com/1", null);
    a.equal(cached.result.kind, "page", "完整评估必须保住");
  });
});

describe("sw / 安装与快捷键", () => {
  it("安装时把配置文件里的 Key 灌进设置", async () => {
    const env = bootSw({ config: { apiKey: "apikey_seed", model: "jev-1.13.0" } });
    emit(env.chrome.__listeners.installed, { reason: "install" });
    await sleep(30);
    const s = await env.win.RS.storage.getSettings();
    a.equal(s.apiKey, "apikey_seed");
    a.equal(env.chrome.__log.badgeText.length, 1, "安装后应清空徽章");
  });

  it("已有 Key 时安装流程不覆盖用户的设置", async () => {
    const env = bootSw({
      config: { apiKey: "apikey_seed" },
      store: { "rs.settings": { apiKey: "apikey_user" } }
    });
    emit(env.chrome.__listeners.installed, { reason: "install" });
    await sleep(30);
    a.equal((await env.win.RS.storage.getSettings()).apiKey, "apikey_user");
  });

  it("快捷键 toggle-panel 转发给当前标签页的内容脚本", async () => {
    const env = bootSw();
    emit(env.chrome.__listeners.command, "toggle-panel");
    await sleep(30);
    a.equal(env.chrome.__log.tabsSendMessage.length, 1);
    a.deepEqual(env.chrome.__log.tabsSendMessage[0].msg, { type: "RS_TOGGLE_PANEL" });
    a.equal(env.chrome.__log.tabsSendMessage[0].tabId, 7);
  });

  it("其他命令不转发", async () => {
    const env = bootSw();
    emit(env.chrome.__listeners.command, "something-else");
    await sleep(20);
    a.equal(env.chrome.__log.tabsSendMessage.length, 0);
  });

  it("没有可用标签页时快捷键不崩", async () => {
    const env = bootSw({ tabs: [] });
    emit(env.chrome.__listeners.command, "toggle-panel");
    await sleep(20);
    a.equal(env.chrome.__log.tabsSendMessage.length, 0);
  });
});
