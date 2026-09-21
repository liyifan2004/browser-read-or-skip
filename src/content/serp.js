/**
 * Read or Skip —— 搜索结果页标注。
 *
 * 在每条自然结果的标题前插入一枚等级徽章（值得读 / 可扫 / 跳过）+ 可信度分数，
 * 并在结果列表顶部插入一行汇总条。
 * 副产品：评估结果会写入按 URL 索引的缓存，点进结果页时浮层可以瞬时给出结论。
 */
(function (RS) {
  if (window !== window.top) return;
  if (window.__RS_SERP_LOADED__) return;
  window.__RS_SERP_LOADED__ = true;

  const CHIP_CLASS = "rs-serp-chip";

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

  const S = {
    settings: null,
    engine: null,
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

    await waitForResults();
    scan();
    observe();
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
    chip.className = CHIP_CLASS;
    chip.dataset.state = "pending";
    chip.textContent = "…";
    applyChipStyle(chip);
    try {
      target.parentNode.insertBefore(chip, target);
    } catch (e) {
      return;
    }
    if (!S.chips.has(item.url)) S.chips.set(item.url, []);
    S.chips.get(item.url).push(chip);
  }

  function applyChipStyle(el) {
    // 用行内样式，避免依赖页面 CSS 变量；不改动宿主页已有样式
    el.style.cssText = [
      "display:inline-flex",
      "align-items:center",
      "gap:4px",
      "font:600 11px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif",
      "padding:1px 7px",
      "margin-right:7px",
      "border-radius:6px",
      "vertical-align:middle",
      "white-space:nowrap",
      "letter-spacing:.2px",
      "position:relative",
      "top:-1px",
      "cursor:help",
      "transition:transform .15s ease",
      "background:rgba(148,163,184,.16)",
      "color:#64748B",
      "border:1px solid rgba(148,163,184,.35)"
    ].join(";");
  }

  function paintChip(el, result) {
    const v = RS.VERDICT[result.verdict] || RS.VERDICT.unknown;
    const cred = typeof result.credibility === "number" ? " · " + result.credibility + "%" : "";
    el.textContent = v.label + cred;
    el.style.background = hexA(v.color, 0.14);
    el.style.color = v.color;
    el.style.borderColor = hexA(v.color, 0.42);
    const tip = [];
    tip.push(v.label);
    if (typeof result.relevance === "number") tip.push("与你关注主题相关度 " + result.relevance + "%");
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
      bar.style.cssText = [
        "display:flex",
        "align-items:center",
        "gap:10px",
        "flex-wrap:wrap",
        "margin:6px 0 12px",
        "padding:9px 12px",
        "border-radius:10px",
        "font:500 12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif",
        "background:linear-gradient(180deg,rgba(96,165,250,.10),rgba(96,165,250,.04))",
        "border:1px solid rgba(96,165,250,.28)",
        "color:#334155"
      ].join(";");

      const host = document.querySelector(S.engine.container) || document.body;
      host.insertBefore(bar, host.firstChild);
      S.summaryEl = bar;
    }

    const dot = (color) =>
      '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + color +
      ';margin-right:5px;vertical-align:middle"></span>';

    bar.innerHTML =
      '<span style="display:inline-flex;align-items:center;font-weight:700;color:#1D4ED8">Read or Skip</span>' +
      '<span style="opacity:.35">|</span>' +
      '<span>' + dot(RS.VERDICT.read.color) + "值得读 <b>" + stats.read + "</b></span>" +
      '<span>' + dot(RS.VERDICT.skim.color) + "可扫 <b>" + stats.skim + "</b></span>" +
      '<span>' + dot(RS.VERDICT.skip.color) + "可跳过 <b>" + stats.skip + "</b></span>" +
      (stats.pending ? '<span style="opacity:.6">评估中 ' + stats.pending + "</span>" : "") +
      '<span style="margin-left:auto;opacity:.6">共 ' + total + " 条结果被标注</span>";
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

  function hexA(hex, a) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return hex;
    return (
      "rgba(" + parseInt(m[1], 16) + "," + parseInt(m[2], 16) + "," + parseInt(m[3], 16) + "," + a + ")"
    );
  }
})(globalThis.RS);
