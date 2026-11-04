/**
 * Read or Skip —— 搜索引擎的**单一事实源**。
 *
 * 背景（2026-11-04 核实）：
 * 「哪些页面是搜索结果页」这件事此前在三个地方各写了一遍：
 *   1. manifest.json 的 content_scripts[1].matches —— 决定 serp.js 会不会被注入
 *   2. src/lib/heuristics.js 的 SEARCH_ENGINE_PATTERNS —— 决定 HUD 会不会让位
 *   3. src/content/serp.js 的 ENGINES[].match —— 决定 serp.js 内部认不认这个引擎
 * 三处一旦漂移，出现两种用户可见故障：
 *   - **空窗**：HUD 让位了（页面被当成结果页）但 serp.js 没被注入 → 用户在结果页
 *     既看不到徽章，也看不到浮层，整页没有任何反馈。
 *   - **双标注**：serp.js 被注入了但 HUD 不让位 → 同一屏同时出现徽章与浮层。
 * 实测（真实 Chromium + 本地 host 映射）确认过空窗的真实案例：
 *   www.duckduckgo.com / html.duckduckgo.com / lite.duckduckgo.com
 *   —— heuristics 认作结果页，manifest 只写了裸域 duckduckgo.com，于是三档都空窗。
 *
 * 本模块把「一个引擎长什么样」收成一份数据：
 *   - id            引擎标识（上报给模型时用）
 *   - hosts         该引擎的主机名规则（字符串后缀 / 精确）
 *   - pathPrefixes  结果页路径前缀
 *   - queryParams   查询词参数名（按顺序取第一个非空）
 *   - selectors     结果容器 / 结果条目 / 标题 / 链接 / 摘要的选择器
 *   - matchPatterns 对应的 Chrome match pattern（注入用）
 *
 * 三处都从这里派生：
 *   - manifest.json 的 matches 由 tools/sync-engines.mjs 生成（并由测试守住一致）
 *   - heuristics.isSearchResultsPage 用 RS.engines.matchHostAndPath()
 *   - serp.js 用 RS.engines.ENGINES
 *
 * 为什么 host 用后缀匹配而不是 Chrome 的 `*.` 通配符：
 * Chrome 的 `*.example.com` 同时匹配 `example.com` 本身与各级子域（Chromium
 * 源码 URLPattern::MatchesHost：先做全等判断，再做子域后缀判断），但**不能**
 * 表达「只匹配 www.」这种精确主机。这里用后缀列表 + 显式的主机集合表达，
 * 语义比通配符更精确，且与 manifest 的 match pattern 一一对应。
 */
(function (RS) {
  /**
   * 一个引擎的完整描述。
   *
   * hosts 的判定规则（从宽松到严格，逐条命中即算匹配）：
   *   - 以 "." 开头：主机名必须以该后缀结尾（含该后缀本身的主机）。
   *     例 ".duckduckgo.com" 匹配 duckduckgo.com / www.duckduckgo.com /
   *     html.duckduckgo.com，但**不**匹配 notduckduckgo.com（后缀必须是 "." 边界）。
   *   - 不以 "." 开头：主机名必须**完全相等**（精确匹配，含子域）。
   *     例 "www.google.com" 只匹配 www.google.com，不匹配 www.google.com.hk。
   */
  const ENGINES = [
    {
      id: "google",
      hosts: [".google.com", ".google.com.hk", ".google.com.tw"],
      pathPrefixes: ["/search"],
      queryParams: ["q"],
      matchPatterns: [
        "*://*.google.com/search*",
        "*://*.google.com.hk/search*",
        "*://*.google.com.tw/search*",
      ],
      container: "#search, #rso, #center_col",
      resultSel: ["div.MjjYud", "div.g", "div[jscontroller][data-hveid]"],
      titleSel: "a h3",
      linkSel: "a[href]",
      snippetSel: [".VwiC3b", "[data-sncf]", ".IsZvec", "div[style*='-webkit-line-clamp']"],
    },
    {
      id: "bing",
      // www. / cn. / 裸域都要覆盖；用 "." 后缀覆盖各级子域
      hosts: [".bing.com"],
      pathPrefixes: ["/search"],
      queryParams: ["q"],
      matchPatterns: ["*://*.bing.com/search*"],
      container: "#b_results",
      resultSel: ["li.b_algo"],
      titleSel: "h2 a",
      linkSel: "h2 a",
      snippetSel: [".b_caption p", ".b_algoSlug", "p"],
    },
    {
      id: "baidu",
      hosts: [".baidu.com"],
      // 移动版 m.baidu.com 也走 /s；/from 是百度的另一个结果入口
      pathPrefixes: ["/s", "/from"],
      queryParams: ["wd", "word", "q"],
      matchPatterns: ["*://*.baidu.com/s*", "*://*.baidu.com/from*"],
      container: "#content_left, .result-op, #wrapper",
      resultSel: [".result", ".c-container"],
      titleSel: "h3 a",
      linkSel: "h3 a",
      snippetSel: [".c-abstract", ".content-right_8Zs40", "[class*='content-right']", ".c-span-last p"],
    },
    {
      id: "duckduckgo",
      hosts: [".duckduckgo.com"],
      // DDG 的 HTML 版 /lite/ 版 / JS 版都在根路径或子路径上
      pathPrefixes: ["/"],
      queryParams: ["q"],
      matchPatterns: ["*://*.duckduckgo.com/*"],
      container: "#links, ol.react-results--main, [data-testid='mainline']",
      resultSel: ["article[data-testid='result']", "div.result", "li.result"],
      titleSel: "a[data-testid='result-title-a'], h2 a",
      linkSel: "a[data-testid='result-title-a'], h2 a",
      snippetSel: [".result__snippet", "[data-result='snippet']"],
    },
    {
      id: "brave",
      hosts: [".search.brave.com"],
      pathPrefixes: ["/search"],
      queryParams: ["q"],
      matchPatterns: ["*://*.search.brave.com/search*"],
      container: "#results, main",
      resultSel: ["div.snippet", "#results > div"],
      titleSel: ".title",
      linkSel: "a",
      snippetSel: [".snippet-description", ".snippet-content"],
    },
    {
      id: "sogou",
      hosts: [".sogou.com"],
      pathPrefixes: ["/web"],
      queryParams: ["query", "q"],
      matchPatterns: ["*://*.sogou.com/web*"],
      container: "#main, .results",
      resultSel: [".vrwrap", ".rb"],
      titleSel: "h3 a",
      linkSel: "h3 a",
      snippetSel: [".str_info", ".fz-mid", ".space-txt"],
    },
  ];

  /**
   * 主机名是否落在该引擎的 hosts 规则内。
   * @param {string} hostname 已转小写的主机名
   * @param {object} engine
   */
  function hostMatches(hostname, engine) {
    const h = String(hostname || "").toLowerCase();
    if (!h) return false;
    for (const raw of engine.hosts || []) {
      const rule = String(raw || "").toLowerCase();
      if (!rule) continue;
      if (rule.startsWith(".")) {
        // 后缀必须落在 "." 边界上：notduckduckgo.com 不能命中 ".duckduckgo.com"
        if (h === rule.slice(1) || h.endsWith(rule)) return true;
      } else if (h === rule) {
        return true;
      }
    }
    return false;
  }

  /**
   * 路径是否落在该引擎的 pathPrefixes 内。
   *
   * 判定是**段边界**语义（比 Chrome 的 glob 更严格）：
   *   - prefix 为 "/" → 任意路径都算（DDG 的 JS 版 / HTML 版路径五花八门）
   *   - path 恰好等于 prefix → 命中
   *   - path 以 prefix + "/" 开头 → 命中（子路径）
   *   - path 只是「以 prefix 开头」但不在段边界上 → **不命中**
   *     例 "/sugrec" 不是百度的 "/s" 结果页。
   *
   * 为什么不直接用 Chrome 的 glob 语义（`/s*` 会命中 "/sugrec"）：
   * 本模块是「这页是不是结果页」的**权威判定**（HUD 让位与 serp.js 内部识别
   * 都用它），必须比 manifest 的 match pattern 更精确 —— manifest 略宽是安全的
   * （注入后 serp.js 认不出引擎会安静退出），本模块略宽则会让 HUD 在非结果页
   * 上让位，反而制造空窗。
   */
  function pathMatches(pathname, engine) {
    const p = String(pathname || "");
    for (const raw of engine.pathPrefixes || []) {
      const prefix = String(raw || "");
      if (!prefix) continue;
      if (prefix === "/") return true;
      if (p === prefix) return true;
      if (p.startsWith(prefix + "/")) return true;
    }
    return false;
  }

  /**
   * 找出该 URL 属于哪个引擎。
   * @param {string} url
   * @returns {object|null} 命中的引擎描述；不是结果页返回 null
   */
  function engineForUrl(url) {
    if (!url) return null;
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return null;
    }
    const host = u.hostname.toLowerCase();
    const path = u.pathname;
    for (const engine of ENGINES) {
      if (hostMatches(host, engine) && pathMatches(path, engine)) return engine;
    }
    return null;
  }

  /** 该 URL 是不是搜索结果页（任意引擎）。 */
  function isSearchResultsPage(url) {
    return engineForUrl(url) !== null;
  }

  /**
   * 该引擎对应的 Chrome match pattern 列表（注入用）。
   * @param {object} engine
   */
  function matchPatternsFor(engine) {
    return (engine && engine.matchPatterns) || [];
  }

  /** 全部引擎的 match pattern 汇总（manifest 同步脚本用）。 */
  function allMatchPatterns() {
    const out = [];
    for (const e of ENGINES) {
      for (const p of e.matchPatterns || []) {
        if (out.indexOf(p) === -1) out.push(p);
      }
    }
    return out;
  }

  RS.engines = {
    ENGINES,
    engineForUrl,
    isSearchResultsPage,
    hostMatches,
    pathMatches,
    matchPatternsFor,
    allMatchPatterns,
  };
})(globalThis.RS);
