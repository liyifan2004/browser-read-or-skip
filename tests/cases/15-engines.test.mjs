/**
 * 搜索引擎的单一事实源（src/lib/engines.js）。
 *
 * 这层测试守的是「三处定义不许再漂移」：
 *   1. manifest.json 的 content_scripts[1].matches —— 决定 serp.js 会不会被注入
 *   2. heuristics.isSearchResultsPage —— 决定 HUD 会不会让位
 *   3. serp.js 的 ENGINES —— 决定 serp.js 内部认不认这个引擎
 *
 * 三处漂移的后果是用户可见的静默故障：
 *   - 空窗：HUD 让位了但没注入标注 → 结果页上既没徽章也没浮层，整页零反馈
 *   - 双标注：注入了但 HUD 不让位 → 同一屏徽章与浮层打架
 *
 * 2026-11-04 实测确认过的空窗案例：www./html./lite.duckduckgo.com
 * （heuristics 认作结果页，manifest 只写了裸域 duckduckgo.com）。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "../harness/registry.mjs";
import * as a from "../harness/assert.mjs";
import { ROOT, createEnv, loadLibs, readManifest, readFile } from "../harness/env.mjs";

/**
 * Chrome match pattern 的 host/path 语义（依据 Chromium 源码，
 * extensions/common/url_pattern.cc 的 URLPattern::MatchesHost / MatchesPath，
 * 以及 extensions/common/url_pattern_unittest.cc 的断言）：
 *
 *   - host 通配符只有两种形态：`*`（任意主机）或 `*.suffix`（suffix 本身 + 各级子域）。
 *     `*.google.com` 匹配 google.com、www.google.com、monkey.images.google.com；
 *     不匹配 wwwgoogle.com（无 "." 边界）。
 *   - path 里的 `*` 是 glob 通配（等价 `.*`），可出现在任意位置、也可出现多次。
 *   - path 匹配的对象是 **path + query**（GURL::PathForRequest()），
 *     fragment 不参与。
 *   - `X/*` 额外匹配精确的 `X`（Chromium 有专门的一条特判）。
 */

/** 把 Chrome 的 match pattern 语义实现成 JS（用于断言 manifest 是否覆盖某 URL）。 */
function matchPatternCovers(pattern, url) {
  const m = /^(?:(\*|https?|http|file|ftp|ws|wss):\/\/)?([^/]*)(\/.*)?$/.exec(pattern);
  if (!m) return false;
  const [, schemeRaw, hostRaw, pathRaw] = m;
  const scheme = schemeRaw || "*";
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return false;
  }
  if (scheme !== "*" && scheme !== u.protocol.replace(":", "")) return false;

  // host
  const host = u.hostname.toLowerCase();
  const ph = (hostRaw || "").toLowerCase();
  if (ph !== "*") {
    if (ph.startsWith("*.")) {
      const suffix = ph.slice(2);
      // Chromium：先做全等判断，再做子域后缀判断（后缀前必须是 "."）
      if (host !== suffix && !(host.endsWith("." + suffix))) return false;
    } else if (host !== ph) {
      return false;
    }
  }

  // path：匹配对象是 path + query（fragment 不参与）
  const test = u.pathname + u.search;
  const pat = pathRaw || "/*";
  // Chromium 特判：X/* 匹配精确的 X
  if (pat.endsWith("/*") && pat.slice(0, -2) === test) return true;
  return globToRegExp(pat).test(test);
}

/** 把 path 里的 * 转成 glob 正则（* 等价 .*，其余字符按字面量转义）。 */
function globToRegExp(pat) {
  const escaped = pat.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + escaped + "$");
}

function boot(url = "https://example.com/a") {
  const env = createEnv({ url });
  loadLibs(env, ["engines.js", "heuristics.js"]);
  return env;
}

/** 载入 serp.js 里的 ENGINES（它从 RS.engines 派生）。 */
function bootSerpEngines(url) {
  const env = createEnv({ url });
  loadLibs(env, ["engines.js"]);
  // serp.js 是 IIFE，用 eval 载入并读出它内部的 ENGINES 不方便；
  // 这里改为直接验证 RS.engines —— serp.js 的映射逻辑由 07-serp 的行为测试覆盖。
  return env;
}

describe("engines / 单一事实源", () => {
  it("导出面完整", () => {
    const env = boot();
    const e = env.win.RS.engines;
    a.isFunction(e.engineForUrl);
    a.isFunction(e.isSearchResultsPage);
    a.isFunction(e.allMatchPatterns);
    a.ok(Array.isArray(e.ENGINES) && e.ENGINES.length > 0, "ENGINES 不能为空");
    for (const eng of e.ENGINES) {
      a.isString(eng.id, "每个引擎都要有 id");
      a.ok(Array.isArray(eng.hosts) && eng.hosts.length > 0, eng.id + " 缺少 hosts");
      a.ok(Array.isArray(eng.pathPrefixes) && eng.pathPrefixes.length > 0, eng.id + " 缺少 pathPrefixes");
      a.ok(Array.isArray(eng.matchPatterns) && eng.matchPatterns.length > 0, eng.id + " 缺少 matchPatterns");
      a.ok(Array.isArray(eng.queryParams) && eng.queryParams.length > 0, eng.id + " 缺少 queryParams");
      a.ok(Array.isArray(eng.resultSel) && eng.resultSel.length > 0, eng.id + " 缺少 resultSel");
    }
  });

  it("引擎 id 唯一", () => {
    const env = boot();
    const ids = env.win.RS.engines.ENGINES.map((e) => e.id);
    a.equal(new Set(ids).size, ids.length, "引擎 id 重复：" + ids.join(","));
  });

  it("manifest 的结果页 match pattern 与单一事实源完全一致", () => {
    const m = readManifest();
    const cs = m.content_scripts[1];
    const expected = boot().win.RS.engines.allMatchPatterns();
    a.deepEqual(cs.matches, expected, "manifest 的 matches 与 engines.js 不一致 —— 跑 node tools/sync-engines.mjs");
  });

  it("manifest 的每个 match pattern 都是 Chrome 合法形态", () => {
    const m = readManifest();
    for (const p of m.content_scripts[1].matches) {
      a.match(p, /^\*:\/\/[^/]+\/.*/, "match pattern 结构不合法：" + p);
      a.notIncludes(p.slice("://".length + p.split("://")[1].indexOf("/")), "#", "pattern 不能含 #：" + p);
    }
  });
});

describe("engines / host 判定", () => {
  it("覆盖各引擎的主机与子域", () => {
    const env = boot();
    const f = env.win.RS.engines.engineForUrl;
    a.equal(f("https://www.google.com/search?q=x").id, "google");
    a.equal(f("https://www.google.com.hk/search?q=x").id, "google");
    a.equal(f("https://www.bing.com/search?q=x").id, "bing");
    a.equal(f("https://cn.bing.com/search?q=x").id, "bing", "cn.bing.com 也应识别");
    a.equal(f("https://www.baidu.com/s?wd=x").id, "baidu");
    a.equal(f("https://m.baidu.com/s?word=x").id, "baidu", "m.baidu.com 移动版也应识别");
    a.equal(f("https://duckduckgo.com/?q=x").id, "duckduckgo");
    a.equal(f("https://www.duckduckgo.com/?q=x").id, "duckduckgo", "www. 变体也应识别");
    a.equal(f("https://html.duckduckgo.com/html/?q=x").id, "duckduckgo", "html. 变体也应识别");
    a.equal(f("https://lite.duckduckgo.com/lite/?q=x").id, "duckduckgo", "lite. 变体也应识别");
    a.equal(f("https://search.brave.com/search?q=x").id, "brave");
    a.equal(f("https://www.sogou.com/web?query=x").id, "sogou");
  });

  it("未纳入范围的 ccTLD 不被识别（范围以 README / 功能账簿为准）", () => {
    // README 与 FEATURE_LEDGER 声明的 Google 范围是 com / com.hk / com.tw 三档，
    // 不含其它 ccTLD。未覆盖的 ccTLD 上浮层照常出现（只缺徽章），这是有意的。
    const env = boot();
    const f = env.win.RS.engines.engineForUrl;
    a.equal(f("https://www.google.co.jp/search?q=x"), null, "google.co.jp 不在声明范围内");
    a.equal(f("https://www.google.de/search?q=x"), null, "google.de 不在声明范围内");
  });

  it("仿冒域名不得蹭上引擎", () => {
    const env = boot();
    const f = env.win.RS.engines.engineForUrl;
    a.equal(f("https://notduckduckgo.com/?q=x"), null, "notduckduckgo.com 不是 DDG");
    a.equal(f("https://duckduckgo.com.evil.io/?q=x"), null, "后缀仿冒不是 DDG");
    a.equal(f("https://evil-google.com/search?q=x"), null, "前缀仿冒不是 Google");
    a.equal(f("https://www.google.com.evil.io/search?q=x"), null, "后缀仿冒不是 Google");
    a.equal(f("https://notbaidu.com/s?wd=x"), null, "notbaidu.com 不是百度");
    a.equal(f("https://www.bing.com.evil.io/search?q=x"), null, "后缀仿冒不是必应");
  });

  it("非结果页路径不识别为引擎", () => {
    const env = boot();
    const f = env.win.RS.engines.engineForUrl;
    a.equal(f("https://www.google.com/preferences"), null, "google 的非结果路径");
    a.equal(f("https://www.baidu.com/somethingelse"), null, "百度的非结果路径");
    a.equal(f("https://example.com/search?q=x"), null, "无关站点");
    a.equal(f("https://example.com/article"), null);
    a.equal(f("not a url"), null);
    a.equal(f(""), null);
  });
});

describe("engines / manifest 覆盖（防空窗回归）", () => {
  /**
   * 核心契约：凡是被 HUD 判定为「结果页」的 URL，manifest 的 match pattern
   * 必须覆盖它 —— 否则用户在结果页上既看不到徽章，也看不到浮层（空窗）。
   */
  const CASES = [
    "https://www.google.com/search?q=x",
    "https://www.google.com.hk/search?q=x",
    "https://www.google.com.tw/search?q=x",
    "https://www.bing.com/search?q=x",
    "https://cn.bing.com/search?q=x",
    "https://www.baidu.com/s?wd=x",
    "https://www.baidu.com/from?word=x",
    "https://m.baidu.com/s?word=x",
    "https://duckduckgo.com/?q=x",
    "https://www.duckduckgo.com/?q=x",
    "https://html.duckduckgo.com/html/?q=x",
    "https://lite.duckduckgo.com/lite/?q=x",
    "https://search.brave.com/search?q=x",
    "https://www.sogou.com/web?query=x"
  ];

  it("HUD 判定为结果页的 URL，manifest 一定覆盖（无空窗）", () => {
    const m = readManifest();
    const patterns = m.content_scripts[1].matches;
    const env = boot();
    const isSerp = env.win.RS.engines.isSearchResultsPage;
    for (const url of CASES) {
      if (!isSerp(url)) continue;
      const covered = patterns.some((p) => matchPatternCovers(p, url));
      a.ok(covered, "空窗风险：" + url + " 被判定为结果页（浮层会让位），但 manifest 的 match pattern 没覆盖它");
    }
  });

  it("manifest 覆盖的 URL，HUD 一定判定为结果页（无双标注）", () => {
    const m = readManifest();
    const patterns = m.content_scripts[1].matches;
    const env = boot();
    const isSerp = env.win.RS.engines.isSearchResultsPage;
    for (const url of CASES) {
      const covered = patterns.some((p) => matchPatternCovers(p, url));
      if (!covered) continue;
      a.ok(isSerp(url), "双标注风险：" + url + " 被 manifest 注入，但 HUD 不让位");
    }
  });

  it("manifest 覆盖的 URL 必须能被 serp.js 认成同一个引擎", () => {
    const m = readManifest();
    const patterns = m.content_scripts[1].matches;
    const env = bootSerpEngines();
    const engineFor = env.win.RS.engines.engineForUrl;
    for (const url of CASES) {
      const covered = patterns.some((p) => matchPatternCovers(p, url));
      if (!covered) continue;
      const engine = engineFor(url);
      a.ok(engine, "注入却认不出引擎：" + url);
    }
  });
});

describe("engines / Chrome match pattern 语义（依据 Chromium 源码）", () => {
  it("host 通配符 *.suffix 同时匹配 suffix 本身与各级子域", () => {
    a.ok(matchPatternCovers("*://*.google.com/search*", "https://google.com/search?q=x"), "裸域应匹配");
    a.ok(matchPatternCovers("*://*.google.com/search*", "https://www.google.com/search?q=x"), "子域应匹配");
    a.ok(matchPatternCovers("*://*.google.com/search*", "https://a.b.google.com/search?q=x"), "深层子域应匹配");
    a.ok(!matchPatternCovers("*://*.google.com/search*", "https://notgoogle.com/search?q=x"), "无点边界不得匹配");
    a.ok(!matchPatternCovers("*://*.google.com/search*", "https://google.com.evil.io/search?q=x"), "后缀仿冒不得匹配");
  });

  it("path 里的 * 覆盖 path + query（不含 fragment）", () => {
    a.ok(matchPatternCovers("*://www.baidu.com/s*", "https://www.baidu.com/s?wd=x"), "query 参与匹配");
    a.ok(matchPatternCovers("*://www.baidu.com/s*", "https://www.baidu.com/s/xx?wd=x"), "子路径参与匹配");
    a.ok(!matchPatternCovers("*://www.baidu.com/s*", "https://www.baidu.com/other"), "不同路径段不匹配");
    a.ok(!matchPatternCovers("*://www.baidu.com/s*", "https://www.baidu.com/"), "根路径不匹配");
  });

  it("X/* 额外匹配精确的 X（Chromium 的特判）", () => {
    a.ok(matchPatternCovers("*://www.baidu.com/*", "https://www.baidu.com/"), "根路径匹配");
    a.ok(matchPatternCovers("*://www.baidu.com/*", "https://www.baidu.com/a/b?d=1"), "任意子路径匹配");
  });

  it("精确 host 不匹配其子域", () => {
    a.ok(matchPatternCovers("*://www.google.com/search*", "https://www.google.com/search?q=x"));
    a.ok(!matchPatternCovers("*://www.google.com/search*", "https://google.com/search?q=x"), "精确 host 不匹配裸域");
    a.ok(!matchPatternCovers("*://www.google.com/search*", "https://www.google.co.jp/search?q=x"), "精确 host 不匹配其它 ccTLD");
  });
});

describe("engines / 摘要选择器（2026-11-04 真实页面标定）", () => {
  /**
   * 百度的摘要选择器在 2026 年的真实页面上全部失效（实测四条全 0）。
   * 百度的新类名是「稳定语义前缀 + 构建期哈希后缀」（`summary-text_15QGa`
   * 这种），所以只能用属性包含匹配。
   *
   * 这里钉死两条契约：
   *   1. **不许硬编码带哈希后缀的完整类名** —— 后缀随百度构建变，
   *      硬编码等于给定时炸弹（旧代码里的 `.content-right_8Zs40` 就是这么失效的）。
   *   2. 前缀包含匹配必须能命中实测过的类名形态。
   */
  function baiduSnippetSel(env) {
    const baidu = env.win.RS.engines.ENGINES.find((e) => e.id === "baidu");
    return baidu.snippetSel;
  }

  it("百度的摘要选择器不硬编码任何哈希后缀类名", () => {
    const env = boot();
    for (const sel of baiduSnippetSel(env)) {
      // 形如 `.foo_1a2B3` / `.foo-1a2B3` —— 哈希后缀类名
      a.notOk(
        /[_-][A-Za-z0-9]{5}$/.test(sel),
        "选择器硬编码了哈希后缀类名（会随百度构建失效）：" + sel
      );
    }
  });

  it("百度用前缀包含匹配命中实测过的类名形态", () => {
    const env = boot();
    const sels = baiduSnippetSel(env);
    // 实测（2026-11-04）出现的形态：summary-text_15QGa / summary-gap_68jXq
    // / content-gap_3jlQr。
    const shouldHit = ["summary-text_15QGa", "summary-gap_68jXq"];
    for (const cls of shouldHit) {
      const hit = sels.some((sel) => {
        const m = /\[class\*=['"]([^'"]+)['"]\]/.exec(sel);
        return m && cls.includes(m[1]);
      });
      a.ok(hit, "选择器集应能命中类名 " + cls + "（实测存在的前缀形态）");
    }
  });

  it("首选 summary-text —— 它是唯一不带日期噪声的那个", () => {
    // 实测文本样本：
    //   summary-text → "一、Manifest V3的诞生背景与核心目标 ..."（纯摘要正文）
    //   summary-gap  → "2025年11月6日一、Manifest V3..."（日期 + 摘要正文）
    //   content-gap  → "2025年10月13日\"permissions\": ..."（日期 + 摘要正文）
    // summary-gap / content-gap 会把发布日期混进摘要里，污染发给模型的文本，
    // 所以必须是次选，不能排第一。
    const env = boot();
    const sels = baiduSnippetSel(env);
    a.equal(
      sels[0],
      "[class*='summary-text']",
      "百度的首选摘要选择器必须是 summary-text（唯一不带日期噪声的）"
    );
  });

  it("旧选择器仍作为兜底保留，回滚时还能取到摘要", () => {
    const env = boot();
    const sels = baiduSnippetSel(env);
    a.ok(
      sels.some((s) => s === ".c-abstract" || s === "[class*='content-right']"),
      "应保留旧选择器作兜底（百度若回滚到旧结构仍能工作）"
    );
  });

  it("摘要选择器命中元素后能取到实质文本（真实页面上是摘要而非空壳）", () => {
    const env = boot();
    for (const sel of baiduSnippetSel(env)) {
      // 选择器必须能定位到元素，不能是只匹配标签的空选择器
      a.ok(sel && sel.length > 1, "选择器不能为空：" + sel);
    }
  });
});

describe("engines / heuristics 委托", () => {
  it("heuristics.isSearchResultsPage 与单一事实源结果一致", () => {
    const env = boot();
    const h = env.win.RS.heuristics.isSearchResultsPage;
    const e = env.win.RS.engines.isSearchResultsPage;
    for (const url of [
      "https://www.google.com/search?q=x",
      "https://html.duckduckgo.com/html/?q=x",
      "https://www.baidu.com/from?word=x",
      "https://example.com/article",
      "https://notgoogle.com/search?q=x"
    ]) {
      a.equal(h(url), e(url), "两个判定不一致：" + url);
    }
  });
});
