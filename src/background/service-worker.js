/**
 * Read or Skip —— background service worker。
 *
 * 职责：
 *  1. 唯一持有 API Key，唯一发起跨域请求（内容脚本受页面 CORS 限制，不能直接调用）。
 *  2. 结果缓存读写、用量统计。
 *  3. 工具栏徽章。
 *  4. 快捷键 → 转发给内容脚本。
 */
importScripts("/src/lib/namespace.js");
try {
  importScripts("/src/lib/config.js");
} catch (e) {
  importScripts("/src/lib/config.example.js");
}
importScripts(
  "/src/lib/constants.js",
  "/src/lib/jev.js",
  "/src/lib/storage.js",
  "/src/lib/questions.js"
);

const RS = globalThis.RS;

/* ---------------- 安装 / 更新 ---------------- */

chrome.runtime.onInstalled.addListener(async (details) => {
  const cur = await RS.storage.getSettings();
  const patch = {};
  if (!cur.apiKey && RS.DEFAULT_CONFIG && RS.DEFAULT_CONFIG.apiKey) {
    patch.apiKey = RS.DEFAULT_CONFIG.apiKey;
  }
  if (Object.keys(patch).length) await RS.storage.saveSettings(patch);

  if (details.reason === "install") {
    chrome.action.setBadgeText({ text: "" });
  }
});

chrome.runtime.onStartup.addListener(() => {
  chrome.action.setBadgeText({ text: "" });
});

/* ---------------- 徽章 ---------------- */

async function paintBadge(tabId, result) {
  if (typeof tabId !== "number") return;
  const v = RS.VERDICT[(result && result.verdict) || "unknown"] || RS.VERDICT.unknown;
  const glyph = { read: "读", skim: "扫", skip: "跳" }[v.key] || "·";
  try {
    await chrome.action.setBadgeText({ tabId, text: glyph });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: v.color });
    await chrome.action.setTitle({
      tabId,
      title: "Read or Skip — " + v.label
    });
  } catch (e) {
    /* tab 已关闭，忽略 */
  }
}

/* ---------------- 并发池 ---------------- */

async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let idx = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try {
        out[i] = { ok: true, value: await worker(items[i], i) };
      } catch (e) {
        out[i] = {
          ok: false,
          error: { code: e && e.code ? e.code : "ERROR", message: e && e.message ? e.message : String(e) }
        };
      }
    }
  });
  await Promise.all(runners);
  return out;
}

/* ---------------- 网页评估 ---------------- */

async function handleEvaluate(payload) {
  const settings = await RS.storage.getSettings();
  if (!settings.enabled) return { ok: false, error: { code: "DISABLED", message: "扩展已暂停。" } };

  const page = payload && payload.page;
  if (!page || !page.url) return { ok: false, error: { code: "NO_PAGE", message: "缺少页面数据。" } };

  // force 由界面上的「重新评估」触发：必须绕过缓存真的重新问一次模型，
  // 否则用户点了按钮却看到完全一样的结论，会以为坏了。
  if (!(payload && payload.force)) {
    const cached = await RS.storage.getCacheEntry(page.url, settings);
    if (cached && cached.result && !cached.partial) {
      return { ok: true, result: Object.assign({}, cached.result, { source: "cache" }), from: "cache" };
    }
  }

  const state = payload.state || extractStateFallback(page, settings);
  const questions = RS.questions.pageQuestions(settings);
  const t0 = Date.now();

  try {
    const resp = await RS.jev.systemOne({
      state,
      questions,
      apiKey: settings.apiKey,
      model: settings.model,
      timeoutMs: settings.timeoutMs
    });
    const result = RS.questions.normalizePage(resp.answers, {
      model: resp.model,
      usage: resp.usage
    });
    result.elapsedMs = Date.now() - t0;
    result.approximate = false;

    await RS.storage.putCacheEntry(page.url, result, { title: page.title });
    await RS.storage.bumpStats({
      calls: 1,
      inputTokens: (resp.usage && resp.usage.input_tokens) || 0,
      outputTokens: (resp.usage && resp.usage.output_tokens) || 0,
      pages: 1,
      verdict: result.verdict
    });
    return { ok: true, result, from: "jev" };
  } catch (e) {
    return {
      ok: false,
      error: {
        code: (e && e.code) || "ERROR",
        message: (e && e.message) || "评估失败",
        status: (e && e.status) || 0
      }
    };
  }
}

/** 兜底：内容脚本没带 state 时，在 SW 里用最少信息构造 */
function extractStateFallback(page, settings) {
  return {
    url: page.url,
    domain: page.domain,
    title: page.title,
    metaDescription: page.description || undefined,
    focusTopics: (settings && settings.topics) || [],
    content: (page.text || "").slice(0, (settings && settings.excerptChars) || 6000)
  };
}

/* ---------------- 搜索结果批量评估 ---------------- */

async function handleSerp(payload) {
  const settings = await RS.storage.getSettings();
  if (!settings.enabled || !settings.annotateSerp) {
    return { ok: false, error: { code: "DISABLED", message: "搜索结果标注未开启。" } };
  }
  const items = (payload && payload.items) || [];
  const max = settings.serpMaxResults || 8;
  const list = items.slice(0, max);
  if (!list.length) return { ok: true, results: {} };

  const questions = RS.questions.serpQuestions(settings);
  const t0 = Date.now();

  const settled = await pool(list, 5, async (item) => {
    const cached = await RS.storage.getCacheEntry(item.url, settings);
    if (cached && cached.result && cached.result.kind === "serp") {
      // 带上来源标记：命中旧的预判结果不能算成一次新的 API 调用，
      // 否则翻回上一页会凭空多出一堆调用次数和 token。
      return { result: cached.result, fromCache: true };
    }

    const state = {
      url: item.url,
      domain: domainOf(item.url),
      title: item.title,
      snippet: (item.snippet || "").slice(0, 400),
      engine: payload.engine || "",
      query: payload.query || "",
      focusTopics: settings.topics || []
    };
    const resp = await RS.jev.systemOne({
      state,
      questions,
      apiKey: settings.apiKey,
      model: settings.model,
      timeoutMs: settings.timeoutMs
    });
    const result = RS.questions.normalizeSerp(resp.answers, {
      model: resp.model,
      usage: resp.usage
    });
    await RS.storage.putCacheEntry(item.url, result, { title: item.title });
    return { result, fromCache: false };
  });

  let calls = 0;
  let inTok = 0;
  let outTok = 0;
  const results = {};
  let firstError = null;

  settled.forEach((s, i) => {
    const item = list[i];
    if (!s.ok) {
      if (!firstError) firstError = s.error;
      return;
    }
    const payloadValue = s.value && s.value.result ? s.value : { result: s.value, fromCache: false };
    const value = payloadValue.result;
    if (!value) return;
    results[item.url] = value;
    if (!payloadValue.fromCache) {
      calls++;
      if (value.usage) {
        inTok += value.usage.input_tokens || 0;
        outTok += value.usage.output_tokens || 0;
      }
    }
  });

  if (calls) {
    await RS.storage.bumpStats({ calls, inputTokens: inTok, outputTokens: outTok });
  }

  return {
    ok: Object.keys(results).length > 0,
    results,
    error: firstError || undefined,
    elapsedMs: Date.now() - t0
  };
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (e) {
    return "";
  }
}

/* ---------------- 消息路由 ---------------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = msg && msg.type;
  if (!type) return false;

  if (type === RS.MSG.EVALUATE) {
    handleEvaluate(msg.payload)
      .then(async (res) => {
        if (res.ok && res.result && sender.tab && sender.tab.id != null) {
          await paintBadge(sender.tab.id, res.result);
        }
        sendResponse(res);
      })
      .catch((e) =>
        sendResponse({ ok: false, error: { code: "FATAL", message: String(e && e.message ? e.message : e) } })
      );
    return true;
  }

  if (type === RS.MSG.EVALUATE_SERP) {
    handleSerp(msg.payload)
      .then(sendResponse)
      .catch((e) =>
        sendResponse({ ok: false, error: { code: "FATAL", message: String(e && e.message ? e.message : e) } })
      );
    return true;
  }

  if (type === RS.MSG.REQUEST_STATE) {
    (async () => {
      const settings = await RS.storage.getSettings();
      const entry = msg.url ? await RS.storage.getCacheEntry(msg.url, settings) : null;
      sendResponse({ ok: true, entry });
    })();
    return true;
  }

  if (type === RS.MSG.OPEN_OPTIONS) {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return false;
  }

  if (type === "RS_CLEAR_BADGE") {
    chrome.action.setBadgeText({ text: "" });
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

/* ---------------- 快捷键 ---------------- */

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-panel") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: "RS_TOGGLE_PANEL" });
  } catch (e) {
    /* 页面没有内容脚本（chrome:// 等），忽略 */
  }
});
