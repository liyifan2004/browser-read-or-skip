/**
 * 存储层（storage.js）：URL 归一化、缓存 TTL 与 LRU、预判不覆盖完整评估、用量统计。
 * 缓存写错会直接导致"重新评估没反应"或"搜索结果预判把完整结论冲掉"。
 */
import { describe, it } from "../harness/registry.mjs";
import * as a from "../harness/assert.mjs";
import { createEnv, loadLibs } from "../harness/env.mjs";

const DAY = 24 * 60 * 60 * 1000;

function boot(chromeOpts = {}) {
  const env = createEnv({ chromeOpts });
  loadLibs(env, ["storage.js"]);
  return env;
}

function result(over = {}) {
  return Object.assign({ kind: "page", verdict: "read", source: "jev", at: Date.now() }, over);
}

describe("storage / urlKey 归一化", () => {
  it("去掉 hash 与跟踪参数，保留有意义的参数", () => {
    const env = boot();
    const k = env.win.RS.storage.urlKey;
    a.equal(k("https://x.com/a?utm_source=nl&id=3#section"), "https://x.com/a?id=3");
    a.equal(k("https://x.com/a?fbclid=zzz&spm=a1.b2&from=share"), "https://x.com/a");
    a.equal(k("https://x.com/a"), "https://x.com/a");
    a.equal(k("https://x.com/a?ref=homepage"), "https://x.com/a");
    a.equal(k("https://x.com/p/1?gclid=x&q=hello"), "https://x.com/p/1?q=hello");
  });

  it("同一篇文章的不同来源链接归一为同一个 key", () => {
    const env = boot();
    const k = env.win.RS.storage.urlKey;
    a.equal(
      k("https://x.com/p/1?utm_campaign=a#top"),
      k("https://x.com/p/1"),
      "带跟踪参数与不带参数的同一页应命中同一缓存"
    );
  });

  it("非法 URL 退化为去掉 hash 的原串，不抛错", () => {
    const env = boot();
    const k = env.win.RS.storage.urlKey;
    a.equal(k("not-a-url#frag"), "not-a-url");
    a.equal(k(""), "");
    a.equal(k(null), "");
    a.equal(k(undefined), "");
  });
});

describe("storage / 设置读写", () => {
  it("没存过任何设置时返回完整默认值", async () => {
    const env = boot();
    const s = await env.win.RS.storage.getSettings();
    a.equal(s.model, env.win.RS.DEFAULT_MODEL);
    a.equal(s.enabled, true);
    a.equal(s.showHud, true);
    a.equal(s.excerptChars, 6000);
    a.isArray(s.topics);
    a.gt(s.topics.length, 0, "默认应带一组关注主题，否则相关度没参照");
  });

  it("部分保存后与默认值合并，而不是整体替换", async () => {
    const env = boot();
    const s = await env.win.RS.storage.saveSettings({ showHud: false });
    a.equal(s.showHud, false);
    a.equal(s.model, env.win.RS.DEFAULT_MODEL, "未改的字段应保留默认值");
    const again = await env.win.RS.storage.getSettings();
    a.equal(again.showHud, false);
    a.equal(again.enabled, true);
  });

  it("本地 config.js 里的 Key 会在没有手填时被采用", async () => {
    const env = boot();
    env.win.RS.DEFAULT_CONFIG = { apiKey: "apikey_local_test", model: "jev-1.13.0" };
    const s = await env.win.RS.storage.getSettings();
    a.equal(s.apiKey, "apikey_local_test");
    a.equal(s.model, "jev-1.13.0", "没手填 model 时用配置文件里的");
  });

  it("手填的设置优先于 config.js", async () => {
    const env = boot();
    env.win.RS.DEFAULT_CONFIG = { apiKey: "apikey_local_test", model: "jev-1.13.0" };
    await env.win.RS.storage.saveSettings({ apiKey: "apikey_user", model: "jev-latest" });
    const s = await env.win.RS.storage.getSettings();
    a.equal(s.apiKey, "apikey_user");
    a.equal(s.model, "jev-latest");
  });

  it("设置变更会通知订阅者，且带上合并后的默认值", async () => {
    const env = boot();
    let got = null;
    env.win.RS.storage.onSettingsChanged((next) => {
      got = next;
    });
    await env.win.RS.storage.saveSettings({ topics: ["RAG 评测"] });
    a.ok(got, "没有收到变更通知");
    a.deepEqual(got.topics, ["RAG 评测"]);
    a.equal(got.model, env.win.RS.DEFAULT_MODEL, "通知里也应是合并后的完整设置");
  });

  it("没有 chrome.storage 时退回内存实现，不崩", async () => {
    const env = boot();
    delete env.win.chrome;
    await env.win.RS.storage.saveSettings({ showHud: false });
    const s = await env.win.RS.storage.getSettings();
    a.equal(s.showHud, false);
  });
});

describe("storage / 结果缓存", () => {
  it("写入后能按 URL 读回，并带上标题", async () => {
    const env = boot();
    const st = env.win.RS.storage;
    await st.putCacheEntry("https://x.com/p/1?utm_source=a", result(), { title: "标题" });
    const e = await st.getCacheEntry("https://x.com/p/1", null);
    a.ok(e, "同一页面去掉跟踪参数后应能命中");
    a.equal(e.result.verdict, "read");
    a.equal(e.title, "标题");
    a.equal(e.partial, false);
  });

  it("没写过的 URL 返回 null", async () => {
    const env = boot();
    a.equal(await env.win.RS.storage.getCacheEntry("https://x.com/none", null), null);
  });

  it("完整评估超过 TTL 后失效", async () => {
    const env = boot();
    const st = env.win.RS.storage;
    const url = "https://x.com/p/1";
    await st.putCacheEntry(url, result(), {});
    const key = st.urlKey(url);
    env.chrome.__store[env.win.RS.SK.CACHE][key].at = Date.now() - 8 * DAY;
    a.equal(await st.getCacheEntry(url, { cacheTtlMs: 7 * DAY, partialCacheTtlMs: DAY }), null);
  });

  it("搜索结果预判用更短的 TTL", async () => {
    const env = boot();
    const st = env.win.RS.storage;
    const url = "https://x.com/p/1";
    await st.putCacheEntry(url, result({ kind: "serp", partial: true }), {});
    const key = st.urlKey(url);
    env.chrome.__store[env.win.RS.SK.CACHE][key].at = Date.now() - 2 * DAY;
    const settings = { cacheTtlMs: 7 * DAY, partialCacheTtlMs: DAY };
    a.equal(await st.getCacheEntry(url, settings), null, "预判超过 1 天应失效");
    env.chrome.__store[env.win.RS.SK.CACHE][key].at = Date.now() - 2 * 60 * 60 * 1000;
    a.ok(await st.getCacheEntry(url, settings), "预判 2 小时内仍应有效");
  });

  it("搜索结果预判不能覆盖已有的完整评估", async () => {
    const env = boot();
    const st = env.win.RS.storage;
    const url = "https://x.com/p/1";
    await st.putCacheEntry(url, result({ verdict: "read" }), { title: "完整" });
    await st.putCacheEntry(url, result({ kind: "serp", verdict: "skip", partial: true }), { title: "预判" });
    const e = await st.getCacheEntry(url, null);
    a.equal(e.result.verdict, "read", "完整评估必须保住");
    a.equal(e.result.kind, "page");
    a.equal(e.partial, false);
  });

  it("完整评估可以覆盖搜索结果预判", async () => {
    const env = boot();
    const st = env.win.RS.storage;
    const url = "https://x.com/p/1";
    await st.putCacheEntry(url, result({ kind: "serp", verdict: "skip", partial: true }), {});
    await st.putCacheEntry(url, result({ verdict: "read" }), {});
    const e = await st.getCacheEntry(url, null);
    a.equal(e.result.verdict, "read");
    a.equal(e.partial, false);
  });

  it("超过条目上限时按最久未更新淘汰（LRU）", async () => {
    const env = boot();
    const st = env.win.RS.storage;
    await st.saveSettings({ cacheLimit: 3 });
    const base = Date.now();
    for (let i = 1; i <= 4; i++) {
      const url = "https://x.com/p/" + i;
      await st.putCacheEntry(url, result(), {});
      const map = env.chrome.__store[env.win.RS.SK.CACHE];
      const key = st.urlKey(url);
      // 序号越大越"新"（时间戳都放到过去，避免写入瞬间的 Date.now() 打乱顺序）
      if (map[key]) map[key].at = base - (10 - i) * 60000;
    }
    const map = env.chrome.__store[env.win.RS.SK.CACHE];
    a.equal(Object.keys(map).length, 3, "应只保留 3 条");
    a.equal(map[st.urlKey("https://x.com/p/1")], undefined, "最久未更新的一条应被淘汰");
    a.ok(map[st.urlKey("https://x.com/p/4")], "最新的一条应保留");
  });

  it("并发写入不会互相覆盖（搜索结果页 5 路并发就靠这个）", async () => {
    const env = boot();
    const st = env.win.RS.storage;
    const urls = Array.from({ length: 6 }, (_, i) => "https://x.com/concurrent/" + i);
    await Promise.all(urls.map((u) => st.putCacheEntry(u, result(), {})));
    const c = await st.cacheStats();
    a.equal(c.count, 6, "6 条并发写入必须全部落盘，不能只剩最后一条");
    for (const u of urls) {
      a.ok(await st.getCacheEntry(u, null), u + " 应该能读到");
    }
  });

  it("cacheStats 报告条数与体积", async () => {
    const env = boot();
    const st = env.win.RS.storage;
    await st.putCacheEntry("https://x.com/p/1", result(), {});
    const c = await st.cacheStats();
    a.equal(c.count, 1);
    a.gt(c.bytes, 10);
  });

  it("clearCache 之后读不到任何条目", async () => {
    const env = boot();
    const st = env.win.RS.storage;
    await st.putCacheEntry("https://x.com/p/1", result(), {});
    await st.clearCache();
    a.equal(await st.getCacheEntry("https://x.com/p/1", null), null);
    a.equal((await st.cacheStats()).count, 0);
  });

  it("传 null 结果时不写入，避免污染缓存", async () => {
    const env = boot();
    const st = env.win.RS.storage;
    await st.putCacheEntry("https://x.com/p/1", null, {});
    a.equal((await st.cacheStats()).count, 0);
  });
});

describe("storage / 用量统计", () => {
  it("首次读取给出全零结构", async () => {
    const env = boot();
    const s = await env.win.RS.storage.getStats();
    a.equal(s.calls, 0);
    a.equal(s.pages, 0);
    a.deepEqual(s.verdicts, { read: 0, skim: 0, skip: 0 });
  });

  it("多次累加 token 与判定分布", async () => {
    const env = boot();
    const st = env.win.RS.storage;
    await st.bumpStats({ calls: 1, inputTokens: 100, outputTokens: 20, pages: 1, verdict: "read" });
    await st.bumpStats({ calls: 2, inputTokens: 50, outputTokens: 10, verdict: "skip" });
    const s = await st.getStats();
    a.equal(s.calls, 3);
    a.equal(s.inputTokens, 150);
    a.equal(s.outputTokens, 30);
    a.equal(s.pages, 1);
    a.equal(s.verdicts.read, 1);
    a.equal(s.verdicts.skip, 1);
    a.equal(s.verdicts.skim, 0);
    a.isNumber(s.lastAt);
  });

  it("未知 verdict 不污染分布", async () => {
    const env = boot();
    await env.win.RS.storage.bumpStats({ calls: 1, verdict: "definitely" });
    const s = await env.win.RS.storage.getStats();
    a.deepEqual(s.verdicts, { read: 0, skim: 0, skip: 0 });
  });
});
