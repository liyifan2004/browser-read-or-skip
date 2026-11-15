/**
 * Read or Skip —— 存储层：设置、结果缓存（LRU）、统计。
 * 内容脚本 / service worker / 扩展页面共用。
 */
(function (RS) {
  const SK = RS.SK;

  function hasStorage() {
    return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
  }

  function memFallback() {
    if (!globalThis.__RS_MEM__) globalThis.__RS_MEM__ = {};
    return globalThis.__RS_MEM__;
  }

  async function rawGet(key) {
    if (hasStorage()) {
      const o = await chrome.storage.local.get(key);
      return o[key];
    }
    return memFallback()[key];
  }

  async function rawSet(key, value) {
    if (hasStorage()) return chrome.storage.local.set({ [key]: value });
    memFallback()[key] = value;
  }

  async function rawRemove(key) {
    if (hasStorage()) return chrome.storage.local.remove(key);
    delete memFallback()[key];
  }

  /* ---------------- 设置 ---------------- */

  /**
   * 把存下来的值整形成**当前版本期望的类型**。
   *
   * 为什么必须有这一步：`Object.assign({}, DEFAULT, saved)` 只能补齐
   * **缺失**的字段，管不住**类型不对**的字段。老版本升级、或数据被外部
   * 写坏时，`siteBlocklist` 可能是个字符串而不是数组 —— 设置页的
   * `settings.siteBlocklist.join("\n")` 会直接抛 TypeError，整个设置页
   * 打不开，用户唯一的出路是清扩展数据，那意味着 API Key 与全部设置丢失。
   *
   * 规则：类型不对就退回默认值，**绝不把脏数据往上抛**。
   * 设置页必须永远打得开 —— 那是用户唯一的自救入口。
   */
  function coerceSettings(saved) {
    const out = Object.assign({}, RS.DEFAULT_SETTINGS, saved);
    const def = RS.DEFAULT_SETTINGS;

    // 数组型字段：非数组一律退回默认
    for (const key of ["topics", "siteBlocklist"]) {
      if (!Array.isArray(out[key])) out[key] = Array.isArray(def[key]) ? def[key].slice() : [];
      else out[key] = out[key].filter((x) => typeof x === "string");
    }
    // 数字型字段：非数字或 NaN 一律退回默认
    for (const key of Object.keys(def)) {
      if (typeof def[key] === "number" && typeof out[key] !== "number") {
        out[key] = def[key];
      } else if (typeof def[key] === "number" && !Number.isFinite(out[key])) {
        out[key] = def[key];
      }
    }
    // 布尔型字段：非布尔一律退回默认
    for (const key of Object.keys(def)) {
      if (typeof def[key] === "boolean" && typeof out[key] !== "boolean") {
        out[key] = def[key];
      }
    }
    // 字符串型字段：非字符串一律退回默认
    for (const key of Object.keys(def)) {
      if (typeof def[key] === "string" && typeof out[key] !== "string") {
        out[key] = def[key];
      }
    }
    // 对象型字段（如 pausedSites）：非对象一律退回默认
    for (const key of Object.keys(def)) {
      if (def[key] && typeof def[key] === "object" && !Array.isArray(def[key])) {
        if (!out[key] || typeof out[key] !== "object" || Array.isArray(out[key])) {
          out[key] = Object.assign({}, def[key]);
        }
      }
    }
    return out;
  }

  async function getSettings() {
    const saved = (await rawGet(SK.SETTINGS)) || {};
    const merged = coerceSettings(saved);
    if (!merged.apiKey && RS.DEFAULT_CONFIG && RS.DEFAULT_CONFIG.apiKey) {
      merged.apiKey = RS.DEFAULT_CONFIG.apiKey;
    }
    if (RS.DEFAULT_CONFIG && RS.DEFAULT_CONFIG.model && !saved.model) {
      merged.model = RS.DEFAULT_CONFIG.model;
    }
    return merged;
  }

  async function saveSettings(patch) {
    const cur = (await rawGet(SK.SETTINGS)) || {};
    const next = Object.assign({}, cur, patch);
    await rawSet(SK.SETTINGS, next);
    return coerceSettings(next);
  }

  function onSettingsChanged(cb) {
    if (!hasStorage() || !chrome.storage.onChanged) return () => {};
    const handler = (changes, area) => {
      if (area === "local" && changes[SK.SETTINGS]) {
        cb(coerceSettings(changes[SK.SETTINGS].newValue || {}));
      }
    };
    chrome.storage.onChanged.addListener(handler);
    return () => chrome.storage.onChanged.removeListener(handler);
  }

  /* ---------------- 结果缓存 ---------------- */

  function urlKey(url) {
    try {
      const u = new URL(url);
      u.hash = "";
      // 去掉常见跟踪参数，避免同一篇文章多条缓存
      const drop = [];
      u.searchParams.forEach((_v, k) => {
        if (/^(utm_|ref|spm|from|share|fbclid|gclid|_hs)/i.test(k)) drop.push(k);
      });
      drop.forEach((k) => u.searchParams.delete(k));
      return u.toString();
    } catch (e) {
      return String(url || "").split("#")[0];
    }
  }

  async function getCacheMap() {
    return (await rawGet(SK.CACHE)) || {};
  }

  async function getCacheEntry(url, settings) {
    const map = await getCacheMap();
    const key = urlKey(url);
    const entry = map[key];
    if (!entry || !entry.result) return null;
    const ttl = entry.partial
      ? (settings && settings.partialCacheTtlMs) || RS.DEFAULT_SETTINGS.partialCacheTtlMs
      : (settings && settings.cacheTtlMs) || RS.DEFAULT_SETTINGS.cacheTtlMs;
    if (Date.now() - (entry.at || 0) > ttl) return null;
    return entry;
  }

  /**
   * 存储写入串行化（缓存与统计共用一把锁）。
   *
   * putCacheEntry / bumpStats 都是「读 → 改 → 写回」，而搜索结果页是并发 5 路一起评估的：
   * 多个协程各自读到同一份旧值、各自写回，后写的会盖掉先写的。
   * 缓存被覆盖的结果是"秒出结论"时灵时不灵；统计被覆盖的结果是调用次数与 token 凭空变少。
   */
  let writeChain = Promise.resolve();

  function withStorageWriteLock(fn) {
    const run = writeChain.then(fn, fn);
    writeChain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  function putCacheEntry(url, result, extra) {
    if (!result) return Promise.resolve();
    return withStorageWriteLock(async () => {
      const key = urlKey(url);
      const map = await getCacheMap();
      const prev = map[key];
      // 预判结果不得覆盖已有的完整评估
      if (prev && prev.result && !prev.partial && result.partial) return;
      map[key] = Object.assign(
        {
          at: Date.now(),
          title: (extra && extra.title) || "",
          partial: !!result.partial
        },
        { result }
      );
      await trimCache(map);
      await rawSet(SK.CACHE, map);
    });
  }

  async function trimCache(map) {
    const limit = (await getSettings()).cacheLimit || 300;
    const keys = Object.keys(map);
    if (keys.length <= limit) return map;
    keys
      .sort((a, b) => (map[a].at || 0) - (map[b].at || 0))
      .slice(0, keys.length - limit)
      .forEach((k) => delete map[k]);
    return map;
  }

  async function clearCache() {
    await withStorageWriteLock(() => rawSet(SK.CACHE, {}));
  }

  async function cacheStats() {
    const map = await getCacheMap();
    const keys = Object.keys(map);
    const bytes = JSON.stringify(map).length;
    return { count: keys.length, bytes };
  }

  /* ---------------- 统计 ---------------- */

  /** 与缓存写入共用同一把写锁：读-改-写在并发下不得丢更新 */
  function bumpStats(patch) {
    return withStorageWriteLock(async () => {
      const cur = (await rawGet(SK.STATS)) || {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        pages: 0,
        verdicts: { read: 0, skim: 0, skip: 0 }
      };
      cur.calls = (cur.calls || 0) + (patch.calls || 0);
      cur.inputTokens = (cur.inputTokens || 0) + (patch.inputTokens || 0);
      cur.outputTokens = (cur.outputTokens || 0) + (patch.outputTokens || 0);
      cur.pages = (cur.pages || 0) + (patch.pages || 0);
      // 只统计已知判定，避免上游传进意外值把统计结构撑出无名键
      if (patch.verdict && cur.verdicts && RS.VERDICT_ORDER.includes(patch.verdict)) {
        cur.verdicts[patch.verdict] = (cur.verdicts[patch.verdict] || 0) + 1;
      }
      cur.lastAt = Date.now();
      await rawSet(SK.STATS, cur);
      return cur;
    });
  }

  async function getStats() {
    return (
      (await rawGet(SK.STATS)) || {
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        pages: 0,
        verdicts: { read: 0, skim: 0, skip: 0 }
      }
    );
  }

  RS.storage = {
    getSettings,
    saveSettings,
    onSettingsChanged,
    getCacheEntry,
    putCacheEntry,
    clearCache,
    cacheStats,
    urlKey,
    bumpStats,
    getStats,
    rawGet,
    rawSet
  };
})(globalThis.RS);
