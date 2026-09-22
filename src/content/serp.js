/**
 * Read or Skip —— 搜索结果页标注。
 *
 * 在每条自然结果的标题前插入一枚等级徽章（值得读 / 可扫 / 跳过）+ 可信度分数，
 * 并在结果列表顶部插入一行汇总条。
 * 副产品：评估结果会写入按 URL 索引的缓存，点进结果页时浮层可以瞬时给出结论。
 *
 * 样式策略：所有徽章 / 汇总条样式集中在一次注入的 <style id="rs-serp-style"> 里，
 * 用 data-v（等级）与 rs-lt / rs-dk（明暗主题）两个属性驱动，宿主页样式不影响它们。
 * 明暗主题按结果容器背景的相对亮度选择（> 0.5 视为浅色页）。
 * 每档等级除颜色外还有非颜色线索：实心点（read）/ 空心底（skim）/ 短横（skip）。
 */
(function (RS) {
  if (window !== window.top) return;
  if (window.__RS_SERP_LOADED__) return;
  window.__RS_SERP_LOADED__ = true;

  const CHIP_CLASS = "rs-serp-chip";
  /* 主题类名必须带 rs- 前缀：裸的 lt / dk 太通用，Google 等站的压缩 CSS 里
     很可能有同名规则，会把宿主页样式直接泼到我们的徽章上。 */
  const THEME_LIGHT = "rs-lt";
  const THEME_DARK = "rs-dk";
  const STYLE_ID = "rs-serp-style";

  const ENGINES = [
    {
      id: "google",
      match: (u) => /(^|\.)google\./.test(u.hostname) && u.pathname.startsWith("/search"),
      container: "#search, #rso, #center_col",
      resultSel: ["div.MjjYud", "div.g", "div[jscontroller][data-hveid]"],
      titleSel: "a h3",
      linkSel: "a[href]",
      snippetSel: [".VwiC3b", "[data-sncf]", ".IsZvec", "div[style*='-webkit-line-clamp']"]
    },
    {
      id: "bing",
      match: (u) => /(^|\.)bing\.com$/.test(u.hostname) && u.pathname.startsWith("/search"),
      container: "#b_results",
      resultSel: ["li.b_algo"],
      titleSel: "h2 a",
      linkSel: "h2 a",
      snippetSel: [".b_caption p", ".b_algoSlug", "p"]
    },
    {
      id: "baidu",
      match: (u) => /(^|\.)baidu\.com$/.test(u.hostname) && (u.pathname.startsWith("/s") || u.pathname.startsWith("/from")),
      container: "#content_left, .result-op, #wrapper",
      resultSel: [".result", ".c-container"],
      titleSel: "h3 a",
      linkSel: "h3 a",
      snippetSel: [".c-abstract", ".content-right_8Zs40", "[class*='content-right']", ".c-span-last p"]
    },
    {
      id: "duckduckgo",
      match: (u) => /(^|\.)duckduckgo\.com$/.test(u.hostname),
      container: "#links, ol.react-results--main, [data-testid='mainline']",
      resultSel: ["article[data-testid='result']", "div.result", "li.result"],
      titleSel: "a[data-testid='result-title-a'], h2 a",
      linkSel: "a[data-testid='result-title-a'], h2 a",
      snippetSel: ["[data-result='snippet']", ".result__snippet"]
    },
    {
      id: "brave",
      match: (u) => /(^|\.)search\.brave\.com$/.test(u.hostname),
      container: "#results, main",
      resultSel: ["div.snippet", "#results > div"],
      titleSel: ".title",
      linkSel: "a",
      snippetSel: [".snippet-description", ".snippet-content"]
    },
    {
      id: "sogou",
      match: (u) => /(^|\.)sogou\.com$/.test(u.hostname),
      container: "#main, .results",
      resultSel: [".vrwrap", ".rb"],
      titleSel: "h3 a",
      linkSel: "h3 a",
      snippetSel: [".str_info", ".fz-mid", ".space-txt"]
    }
  ];

  /* 所有颜色对都来自 constants.js 的 RS.SERP_THEME（测试会用 WCAG 公式复算 ≥ 4.5:1）。 */
  const SERP_CSS = `
.${CHIP_CLASS} {
  display: inline-flex; align-items: center; gap: 5px;
  font: 600 12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
  padding: 1px 7px; margin-right: 7px; border-radius: 4px;
  vertical-align: middle; white-space: nowrap; letter-spacing: .2px;
  position: relative; top: -1px; cursor: help; border: 1px solid transparent;
  /* 防御宿主页规则波及徽章排版：翻转 / 竖排 / RTL 一律就地否定（!important 只
     用于这几个防御项， scoped 到本徽章类，不影响宿主页任何元素）。 */
  transform: none !important; direction: ltr !important;
  unicode-bidi: isolate !important; writing-mode: horizontal-tb !important;
}
.${CHIP_CLASS}::before { content: ""; display: inline-block; flex: none; }
.${CHIP_CLASS}[data-marker="dot-solid"]::before { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.${CHIP_CLASS}[data-marker="dot-hollow"]::before { width: 6px; height: 6px; border-radius: 50%; border: 1.5px solid currentColor; box-sizing: border-box; }
.${CHIP_CLASS}[data-marker="dash"]::before { width: 8px; height: 2px; border-radius: 999px; background: currentColor; }
.${CHIP_CLASS}.${THEME_LIGHT} { border-color: rgba(15,23,42,.14); }
.${CHIP_CLASS}.${THEME_DARK} { border-color: rgba(255,255,255,.16); }
.${CHIP_CLASS}.${THEME_LIGHT}[data-v="read"]    { color: ${RS.SERP_THEME.light.read.fg};    background: ${RS.SERP_THEME.light.read.bg}; }
.${CHIP_CLASS}.${THEME_LIGHT}[data-v="skim"]    { color: ${RS.SERP_THEME.light.skim.fg};    background: ${RS.SERP_THEME.light.skim.bg}; }
.${CHIP_CLASS}.${THEME_LIGHT}[data-v="skip"]    { color: ${RS.SERP_THEME.light.skip.fg};    background: ${RS.SERP_THEME.light.skip.bg}; }
.${CHIP_CLASS}.${THEME_LIGHT}[data-v="pending"] { color: ${RS.SERP_THEME.light.pending.fg}; background: ${RS.SERP_THEME.light.pending.bg}; }
.${CHIP_CLASS}.${THEME_DARK}[data-v="read"]    { color: ${RS.SERP_THEME.dark.read.fg};    background: ${RS.SERP_THEME.dark.read.bg}; }
.${CHIP_CLASS}.${THEME_DARK}[data-v="skim"]    { color: ${RS.SERP_THEME.dark.skim.fg};    background: ${RS.SERP_THEME.dark.skim.bg}; }
.${CHIP_CLASS}.${THEME_DARK}[data-v="skip"]    { color: ${RS.SERP_THEME.dark.skip.fg};    background: ${RS.SERP_THEME.dark.skip.bg}; }
.${CHIP_CLASS}.${THEME_DARK}[data-v="pending"] { color: ${RS.SERP_THEME.dark.pending.fg}; background: ${RS.SERP_THEME.dark.pending.bg}; }
#rs-serp-summary {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  margin: 8px 0 12px; padding: 8px 12px; border-radius: 8px;
  font: 500 12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
  border: 1px solid transparent;
}
#rs-serp-summary.${THEME_LIGHT} { background: ${RS.SERP_THEME.summary.light.bg}; border-color: #C9D8EF; color: ${RS.SERP_THEME.summary.light.fg}; }
#rs-serp-summary.${THEME_LIGHT} .rs-brand { color: ${RS.SERP_THEME.summary.light.brand}; }
#rs-serp-summary.${THEME_DARK} { background: ${RS.SERP_THEME.summary.dark.bg}; border-color: #39445A; color: ${RS.SERP_THEME.summary.dark.fg}; }
#rs-serp-summary.${THEME_DARK} .rs-brand { color: ${RS.SERP_THEME.summary.dark.brand}; }
#rs-serp-summary .rs-sep { opacity: .35; }
#rs-serp-summary .rs-dim { opacity: .65; }
`;

  const S = {
    settings: null,
    engine: null,
    lightTheme: true,
    items: new Map(),   // url → item
    chips: new Map(),   // url → [elements]
    done: false,
    summaryEl: null
  };

  init().catch(() => {});

  async function init() {
    S.settings = await RS.storage.getSettings();
    if (!S.settings.enabled || !S.settings.annotateSerp) return;

    S.engine = ENGINES.find((e) => {
      try {
        return e.match(new URL(location.href));
      } catch (err) {
        return false;
      }
    });
    if (!S.engine) return;

    ensureStyle();
    await waitForResults();
    S.lightTheme = isLightHost();
    scan();
    observe();
  }

  /** 样式只注入一次；等级颜色随 data-v 与 rs-lt/rs-dk 类切换 */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = SERP_CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  /** WCAG 相对亮度；解析不了或全透明返回 null（继续向上找） */
  function bgLuminance(color) {
    const m = /rgba?\(([^)]+)\)/.exec(color || "");
    if (!m) return null;
    const parts = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some((n) => isNaN(n))) return null;
    if (parts.length > 3 && parts[3] === 0) return null;
    const f = (c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(parts[0]) + 0.7152 * f(parts[1]) + 0.0722 * f(parts[2]);
  }

  /** 读结果容器的背景亮度选明暗套；链上拿不到实色时按浅色处理（搜索引擎默认浅色） */
  function isLightHost() {
    let el = document.querySelector(S.engine.container) || document.body;
    for (let i = 0; i < 6 && el; i++, el = el.parentElement) {
      let bg = null;
      try {
        bg = window.getComputedStyle(el).backgroundColor;
      } catch (e) {}
      const lum = bgLuminance(bg);
      if (lum != null) return lum > 0.5;
    }
    return true;
  }

  function themeFor(verdict) {
    const t = S.lightTheme ? RS.SERP_THEME.light : RS.SERP_THEME.dark;
    return t[verdict] || t.pending;
  }

  function waitForResults() {
    return new Promise((resolve) => {
      let tries = 0;
      const tick = () => {
        tries++;
        if (collectNodes().length > 0 || tries > 40) return resolve();
        setTimeout(tick, 250);
      };
      tick();
    });
  }

  function collectNodes() {
    const out = [];
    for (const sel of S.engine.resultSel) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch (e) {
        continue;
      }
      for (const n of nodes) {
        if (!out.includes(n)) out.push(n);
      }
      if (out.length >= 3) break;
    }
    return out;
  }

  function pickText(node, selectors) {
    for (const sel of selectors) {
      try {
        const el = node.querySelector(sel);
        if (el && el.textContent && el.textContent.trim().length > 8) {
          return el.textContent.trim().replace(/\s+/g, " ");
        }
      } catch (e) {}
    }
    return "";
  }

  /**
   * 只排除"搜索引擎自己的页面"。
   * 不能用 /(baidu)\./ 这种宽松匹配：那会把 baijiahao.baidu.com、zhidao.baidu.com
   * 这些真内容站一起干掉——而它们恰恰是最需要打上可信度等级的结果。
   */
  const ENGINE_OWN_HOST = /^(?:www\.)?(?:google\.[a-z.]{2,10}|bing\.com|baidu\.com|duckduckgo\.com|sogou\.com|search\.brave\.com)$/i;

  function isEngineOwnLink(href) {
    try {
      const h = new URL(href).hostname;
      if (ENGINE_OWN_HOST.test(h)) return true;
      return h === location.hostname;
    } catch (e) {
      return true;
    }
  }

  function pickLink(node) {
    let a = null;
    try {
      a = node.querySelector(S.engine.linkSel) || node.querySelector("a[href^='http']");
    } catch (e) {}
    if (!a) return null;
    const href = a.href;
    if (!href || !/^https?:/.test(href)) return null;
    if (isEngineOwnLink(href)) return null;
    return { href, anchor: a };
  }

  function anchorNodeFor(node) {
    let a = null;
    try {
      a = node.querySelector(S.engine.titleSel) || node.querySelector("h3, h2");
    } catch (e) {}
    return a || node.querySelector("a[href^='http']") || node;
  }

  function scan() {
    const nodes = collectNodes();
    const fresh = [];
    for (const node of nodes) {
      if (node.dataset.rsDone === "1") continue;
      const link = pickLink(node);
      if (!link) continue;
      const title = pickText(node, [S.engine.titleSel, "h3", "h2"]) || (link.anchor.textContent || "").trim();
      if (!title || title.length < 2) continue;
      node.dataset.rsDone = "1";

      const snippet = pickText(node, S.engine.snippetSel);
      const item = { url: RS.storage.urlKey(link.href), rawHref: link.href, title, snippet, node };
      S.items.set(item.url, item);
      fresh.push(item);

      placeChip(item);
    }
    if (fresh.length) {
      renderSummary();
      void evaluate(fresh);
    }
  }

  function placeChip(item) {
    const target = anchorNodeFor(item.node);
    if (!target || !target.parentNode) return;
    const chip = document.createElement("span");
    chip.className = CHIP_CLASS + " " + (S.lightTheme ? THEME_LIGHT : THEME_DARK);
    chip.dataset.state = "pending";
    chip.dataset.v = "pending";
    chip.dataset.marker = themeFor("pending").marker;
    chip.textContent = "…";
    // 插到标题链接之前且与它同级：徽章彻底脱离 <a> 内部，
    // 宿主页针对链接内部（a > h3 / a > span）的规则不再命中徽章。
    const anchor = target.closest ? target.closest("a") : null;
    const host = anchor || target;
    try {
      host.parentNode.insertBefore(chip, host);
    } catch (e) {
      return;
    }
    if (!S.chips.has(item.url)) S.chips.set(item.url, []);
    S.chips.get(item.url).push(chip);
  }

  function paintChip(el, result) {
    const v = RS.VERDICT[result.verdict] || RS.VERDICT.unknown;
    const known = ["read", "skim", "skip", "pending"].indexOf(result.verdict) !== -1;
    const theme = themeFor(known ? result.verdict : "pending");
    const cred = typeof result.credibility === "number" ? " · " + result.credibility + "%" : "";
    el.textContent = v.label + cred;
    el.dataset.v = known ? result.verdict : "pending";
    el.dataset.marker = theme.marker;
    const tip = [];
    tip.push(v.label);
    if (typeof result.relevance === "number") tip.push("与查询意图相关度 " + result.relevance + "%");
    if (typeof result.credibility === "number") tip.push("信息可信度 " + result.credibility + "%");
    if (result.warning === "intent") tip.push("⚠️ 可能名不副实 / 商业页");
    el.title = tip.join("\n");
    el.dataset.state = "done";
  }

  async function evaluate(items) {
    const payloadItems = items.map((i) => ({ url: i.rawHref, title: i.title, snippet: i.snippet }));
    let resp;
    try {
      resp = await chrome.runtime.sendMessage({
        type: RS.MSG.EVALUATE_SERP,
        payload: {
          engine: S.engine.id,
          query: new URLSearchParams(location.search).get("q") || "",
          items: payloadItems
        }
      });
    } catch (e) {
      return;
    }
    if (!resp) return;
    const results = (resp && resp.results) || {};

    for (const item of items) {
      const r = results[item.url] || results[item.rawHref];
      if (!r) continue;
      item.result = r;
      for (const chip of S.chips.get(item.url) || []) paintChip(chip, r);
    }
    if (!resp.ok && resp.error && !Object.keys(results).length) {
      for (const item of items) {
        for (const chip of S.chips.get(item.url) || []) {
          chip.textContent = "未评估";
          chip.title = resp.error.message || "";
          chip.dataset.state = "error";
        }
      }
    }
    renderSummary();
  }

  function renderSummary() {
    const stats = { read: 0, skim: 0, skip: 0, pending: 0 };
    S.items.forEach((item) => {
      const r = item.result;
      if (!r) stats.pending++;
      else if (stats[r.verdict] != null) stats[r.verdict]++;
    });

    const total = stats.read + stats.skim + stats.skip + stats.pending;
    if (!total) return;

    let bar = S.summaryEl;
    if (!bar || !bar.isConnected) {
      bar = document.createElement("div");
      bar.id = "rs-serp-summary";
      bar.className = S.lightTheme ? THEME_LIGHT : THEME_DARK;

      const host = document.querySelector(S.engine.container) || document.body;
      host.insertBefore(bar, host.firstChild);
      S.summaryEl = bar;
    } else {
      bar.className = S.lightTheme ? THEME_LIGHT : THEME_DARK;
    }

    const dot = (color) =>
      '<span class="rs-dot" style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + color +
      ';margin-right:5px;vertical-align:middle"></span>';

    bar.innerHTML =
      '<span class="rs-brand" style="display:inline-flex;align-items:center;font-weight:700">Read or Skip</span>' +
      '<span class="rs-sep">|</span>' +
      '<span>' + dot(RS.VERDICT.read.color) + "值得读 <b>" + stats.read + "</b></span>" +
      '<span>' + dot(RS.VERDICT.skim.color) + "可扫 <b>" + stats.skim + "</b></span>" +
      '<span>' + dot(RS.VERDICT.skip.color) + "可跳过 <b>" + stats.skip + "</b></span>" +
      (stats.pending ? '<span class="rs-dim">评估中 ' + stats.pending + "</span>" : "") +
      '<span class="rs-dim" style="margin-left:auto">共 ' + total + " 条结果被标注</span>";
  }

  function observe() {
    const root = document.querySelector(S.engine.container) || document.body;
    if (!root) return;
    let t = 0;
    const mo = new MutationObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (S.seenUrl !== location.href) {
          S.seenUrl = location.href;
          S.items.clear();
          S.chips.clear();
          S.summaryEl = null;
          document.querySelectorAll("#" + "rs-serp-summary").forEach((n) => n.remove());
          document.querySelectorAll("." + CHIP_CLASS).forEach((n) => n.remove());
          document.querySelectorAll("[data-rs-done]").forEach((n) => n.removeAttribute("data-rs-done"));
        }
        scan();
      }, 400);
    });
    mo.observe(root, { childList: true, subtree: true });
    S.seenUrl = location.href;
  }
})(globalThis.RS);
