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

  async function getSettings() {
    const saved = (await rawGet(SK.SETTINGS)) || {};
    const merged = Object.assign({}, RS.DEFAULT_SETTINGS, saved);
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
    return Object.assign({}, RS.DEFAULT_SETTINGS, next);
  }

  function onSettingsChanged(cb) {
    if (!hasStorage() || !chrome.storage.onChanged) return () => {};
    const handler = (changes, area) => {
      if (area === "local" && changes[SK.SETTINGS]) {
        cb(Object.assign({}, RS.DEFAULT_SETTINGS, changes[SK.SETTINGS].newValue || {}));
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

  async function putCacheEntry(url, result, extra) {
    if (!result) return;
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
    await rawSet(SK.CACHE, {});
  }

  async function cacheStats() {
    const map = await getCacheMap();
    const keys = Object.keys(map);
    const bytes = JSON.stringify(map).length;
    return { count: keys.length, bytes };
  }

  /* ---------------- 统计 ---------------- */

  async function bumpStats(patch) {
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
    if (patch.verdict && cur.verdicts) {
      cur.verdicts[patch.verdict] = (cur.verdicts[patch.verdict] || 0) + 1;
    }
    cur.lastAt = Date.now();
    await rawSet(SK.STATS, cur);
    return cur;
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
