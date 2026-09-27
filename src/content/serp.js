/**
 * Read or Skip —— 搜索结果页标注。
 *
 * 在每条自然结果的标题前插入一枚等级徽章（值得读 / 可扫 / 跳过）+ 可信度分数，
 * 并在结果列表顶部插入一行汇总条。
 * 副产品：评估结果会写入按 URL 索引的缓存，点进结果页时浮层可以瞬时给出结论。
 *
 * 样式策略（三层）：
 * 1. 徽章渲染在自己的 Shadow DOM 里（hud.js 同款方案）：
 *    宿主 <span class="rs-serp-host"> 放在标题 <a> 内部、<h3> 之前（与标题同一行），
 *    徽章本体在宿主的 shadow root 中。页面 CSS 无法选中 shadow root 内部的元素。
 * 2. 汇总条 #rs-serp-summary 留在 light DOM，样式集中在一次注入的
 *    <style id="rs-serp-style"> 里（只含汇总条规则，不含徽章选择器）。
 * 3. 最后一道保险：徽章挂载后沿宿主祖先链审计计算样式（transform 族 / 排版属性）。
 *    三轮样式隔离（改类名 / 移出 <a> / Shadow DOM）都没修掉 Google 深色页上的
 *    徽章翻转，说明宿主页有条带 !important 的规则命中了宿主或祖先——按 CSS Scoping
 *    规范，外层文档的 !important 声明胜过 shadow host 的声明，:host 里的防御天生
 *    打不赢，所以不能在样式层面硬压，改走「审计取证 + 物理脱离」：一旦发现污染，
 *    该徽章的宿主被 document.body 收养（浮层挂在 body 上三年不出问题），切为
 *    overlay 模式（position:absolute + 标题矩形定位），审计结论写进宿主 title。
 * 明暗主题按结果容器背景的相对亮度选择（> 0.5 视为浅色页），
 * shadow 内用 :host { all: initial } 起手后把徽章样式全部显式重设。
 * 每档等级除颜色外还有非颜色线索：实心点（read）/ 空心底（skim）/ 短横（skip）。
 */
(function (RS) {
  if (window !== window.top) return;
  if (window.__RS_SERP_LOADED__) return;
  window.__RS_SERP_LOADED__ = true;

  const CHIP_CLASS = "rs-serp-chip";
  const HOST_CLASS = "rs-serp-host";
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

  /* 徽章样式：注入每个宿主的 shadow root。
     :host 用 all: initial 起手（hud.js 同款），把宿主页继承与样式波及全部切断，
     再显式重设徽章所需的全部属性。
     防御清单里除 transform 外必须包含 CSS Transforms Level 2 的三个独立属性
     scale / rotate / translate——transform: none 对它们无效，这是上一轮
     「徽章 180° 翻转」修复失败的盲区；filter 一并防御（invert 也会造成视觉翻转）。
     注意：外层文档带 !important 的规则在 shadow host 上仍然打赢 :host 里的
     !important（CSS Scoping 规范），所以这些防御只是第一层，真正的兜底是
     挂载后的样式审计 + 污染自动切换 overlay（见 diagnoseHost）。 */
  const SERP_CSS = `
:host {
  all: initial;
  display: inline-block;
  cursor: help;
  /* 宿主元素自己也可能被 a > span 这类规则命中，防御写在 :host 上 */
  transform: none !important; scale: none !important; rotate: none !important;
  translate: none !important; filter: none !important;
  direction: ltr !important; unicode-bidi: isolate !important;
  writing-mode: horizontal-tb !important;
}
:host(.rs-serp-overlay) {
  /* overlay 模式：宿主已被收养到 body，这里只做定位兜底（left/top 由内联样式给出） */
  position: absolute !important;
  z-index: 2147483640 !important;
  margin: 0 !important;
}
.${CHIP_CLASS} {
  display: inline-flex; align-items: center; gap: 5px;
  font: 600 12px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;
  padding: 1px 7px; margin-right: 7px; border-radius: 4px;
  vertical-align: middle; white-space: nowrap; letter-spacing: .2px;
  position: relative; top: -1px; border: 1px solid transparent;
  /* shadow 内本已隔离，此处是双保险：翻转 / 竖排 / RTL / 滤镜一律就地否定 */
  transform: none !important; scale: none !important; rotate: none !important;
  translate: none !important; filter: none !important;
  direction: ltr !important; unicode-bidi: isolate !important;
  writing-mode: horizontal-tb !important;
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
`;

  /* 汇总条样式：留在 light DOM，随页面级 <style id="rs-serp-style"> 注入。
     这里不允许残留任何徽章选择器——徽章规则只存在于 shadow 内部。 */
  const SUMMARY_CSS = `
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
    chips: new Map(),   // url → [{ host, chip, titleEl }]（host 是 light DOM 宿主，chip 在其 shadow root 里，titleEl 用于 overlay 定位）
    done: false,
    summaryEl: null,
    resizeBound: false  // resize 重测监听只绑一次
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

  /** 汇总条样式只注入一次；徽章样式随各自的 shadow root 注入 */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement("style");
    st.id = STYLE_ID;
    st.textContent = SUMMARY_CSS;
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

  /**
   * 徽章渲染成 Shadow DOM：
   * - 宿主 <span class="rs-serp-host"> 放回标题 <a> 内部、<h3> 之前（与标题同一行，
   *   解决徽章位置偏上的问题）；
   * - 徽章本体在宿主的 shadow root 里，页面 CSS 选不到它——宿主页任何规则
   *   （不管是不是 transform 类）都无法命中，结构性根除翻转问题；
   * - S.chips 存 { host, chip, titleEl } 句柄，paintChip 只操作 shadow 内部的 chip，
   *   titleEl（标题挂载点）供污染自愈后的 overlay 定位使用；
   * - 挂载后立即做宿主样式审计（diagnoseHost），发现污染自动切 overlay 模式。
   */
  function placeChip(item) {
    const target = anchorNodeFor(item.node);
    if (!target || !target.parentNode) return;
    const anchor = target.closest ? target.closest("a") : null;
    const mountPoint = anchor || target;
    if (!mountPoint.parentNode) return;

    const host = document.createElement("span");
    host.className = HOST_CLASS;
    let chip = null;
    try {
      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = SERP_CSS;
      chip = document.createElement("span");
      chip.className = CHIP_CLASS + " " + (S.lightTheme ? THEME_LIGHT : THEME_DARK);
      chip.dataset.state = "pending";
      chip.dataset.v = "pending";
      chip.dataset.marker = themeFor("pending").marker;
      chip.textContent = "…";
      shadow.append(style, chip);
      // 行内位置：<a> 内部、第一个子元素（<h3>）之前
      mountPoint.insertBefore(host, mountPoint.firstChild);
    } catch (e) {
      return;
    }
    const handle = { host, chip, titleEl: mountPoint };
    if (!S.chips.has(item.url)) S.chips.set(item.url, []);
    S.chips.get(item.url).push(handle);
    diagnoseHost(handle);
  }

  /* ===== 宿主样式审计 + 污染自愈 =====
     三轮样式隔离（改类名 / 移出 <a> / Shadow DOM）都没能修掉 Google 深色页上
     徽章 180° 翻转，说明宿主页有条带 !important 的规则命中了徽章的宿主或祖先——
     按 CSS Scoping 规范，外层文档的 !important 声明胜过 shadow host 的声明，
     :host 里的防御天生打不赢。所以策略改为：先审计取证，再物理脱离。 */

  /* ===== 审计基线与自家防御 CSS 的耦合（第四轮事故根因，改防御 CSS 必须同步这里） =====
     审计对象包含 shadow 内的 chip 与宿主自身，它们的计算值来自我们注入的 SERP_CSS：
     :host 与 .rs-serp-chip 都写了带 !important 的防御声明，真实浏览器里
     getComputedStyle 会返回这些防御值（如 unicode-bidi: isolate）。因此
     AUDIT_PROPS 的基线必须是「自家防御值」，而不是 CSS 规范默认值——否则每枚
     徽章都会被自家的 isolate 判成污染、全部误切 overlay（jsdom 不级联 shadow
     样式表所以测不出来，真实 Chrome 必现）。
     tests/cases/07-serp.test.mjs「QA 第四轮固化契约」有逐项一致性用例兜底。 */
  const AUDIT_PROPS = {
    transform: "none",
    scale: "none",
    rotate: "none",
    translate: "none",
    filter: "none",
    "backdrop-filter": "none",
    "writing-mode": "horizontal-tb",
    /* chip / host 基线 ltr：我们强制 ltr，若计算值不是 ltr 说明有外层 !important
       盖过了我们的防御——那是真污染，要抓。祖先链另用文档根方向做基线（见下）。 */
    direction: "ltr",
    "text-orientation": "mixed"
  };
  /* 允许集合：命中集合内任一值都算干净（区别于 AUDIT_PROPS 的单值基线）。
     unicode-bidi: isolate 是自家防御值（SERP_CSS 在 :host 与 .rs-serp-chip 上的
     !important 声明），必须放行；出现 bidi-override 之类才算污染。 */
  const AUDIT_ALLOW_SETS = {
    "unicode-bidi": ["normal", "isolate"]
  };
  /* 祖先链专用基线：direction 以 documentElement 的实际计算方向为准——
     阿拉伯语 / 希伯来语等 RTL 语言的搜索页，祖先 direction=rtl 是合法排版，
     不能按 ltr 基线误判成污染。懒计算并缓存（每窗口只读一次）。 */
  const AUDIT_ANCESTOR_BASIS = { direction: "root" };
  let cachedRootDirection = null;
  function ancestorBaseline(prop) {
    if (AUDIT_ANCESTOR_BASIS[prop] !== "root") return AUDIT_PROPS[prop];
    if (cachedRootDirection == null) {
      try {
        const v = window.getComputedStyle(document.documentElement).direction;
        cachedRootDirection = typeof v === "string" && v ? v : "ltr";
      } catch (e) {
        cachedRootDirection = "ltr";
      }
    }
    return cachedRootDirection;
  }
  const AUDIT_MAX_DEPTH = 16;
  const OVERLAY_CLASS = "rs-serp-overlay";
  /* overlay 的 z-index：低于浮层的 2147483646，仍盖过一切页面内容 */
  const OVERLAY_Z = "2147483640";

  /**
   * 沿宿主祖先链审计计算样式：shadow 内的 chip、宿主自身（depth 0）、
   * 祖先（depth 1..16，直到 documentElement）。逐属性读 getComputedStyle，
   * 与默认值比对，收集全部偏离项。读不到（抛错 / 空串 / undefined）就跳过该属性。
   * @returns {Array<{depth:number|string, tag:string, cls:string, prop:string, value:string}>}
   */
  function auditHostStyles(host, chip) {
    const findings = [];
    const targets = [];
    if (chip) targets.push({ el: chip, depth: "shadow" });
    targets.push({ el: host, depth: 0 });
    let anc = host.parentElement;
    for (let d = 1; anc && d <= AUDIT_MAX_DEPTH; d++, anc = anc.parentElement) {
      targets.push({ el: anc, depth: d });
    }
    for (const t of targets) {
      if (!t.el) continue;
      let cs = null;
      try {
        cs = window.getComputedStyle(t.el);
      } catch (e) {
        continue;
      }
      if (!cs) continue;
      /* chip（"shadow"）与宿主（0）按自家防御值基线判；祖先链上 direction
         改用文档根方向基线（RTL 语言页面合法），其余属性基线不变。 */
      const isOwnLayer = t.depth === "shadow" || t.depth === 0;
      for (const prop of Object.keys(AUDIT_PROPS)) {
        let val = null;
        try {
          val = cs[prop];
        } catch (e) {
          continue;
        }
        if (typeof val !== "string" || val === "") continue;
        const allowed = AUDIT_ALLOW_SETS[prop]
          ? AUDIT_ALLOW_SETS[prop].indexOf(val) !== -1
          : false;
        const baseline = isOwnLayer ? AUDIT_PROPS[prop] : ancestorBaseline(prop);
        if (allowed || val === baseline) continue;
        findings.push({
          depth: t.depth,
          tag: String(t.el.tagName || "").toLowerCase(),
          cls: typeof t.el.className === "string" ? t.el.className : "",
          prop,
          value: val
        });
      }
    }
    return findings;
  }

  /** 审计结论文案，例：样式被宿主页改写：depth3 div.rs-pollute transform=rotate(180deg) */
  function auditSummary(findings) {
    return "样式被宿主页改写：" + findings.map((f) => {
      const cls = f.cls ? "." + f.cls.trim().split(/\s+/).join(".") : "";
      return "depth" + f.depth + " " + f.tag + cls + " " + f.prop + "=" + f.value;
    }).join("；");
  }

  /** 宿主 title = 审计结论（如有）+ 原 tooltip，两条信息都不丢 */
  function withAuditNote(host, tip) {
    if (!host) return tip;
    const note = host.dataset.rsAudit || "";
    return note ? note + "\n" + tip : tip;
  }

  /**
   * 污染自愈：把宿主从被污染的祖先链里摘出来，挂到 document.body 上
   * （浮层挂在 body 上三年不出问题，正是这条路径可靠性的实证），
   * 改为绝对定位贴住标题上沿。paintChip / tooltip / data-marker 等后续
   * 操作都只碰 shadow 内部的 chip，与宿主挂在哪里无关。
   */
  function promoteToOverlay(handle) {
    const host = handle && handle.host;
    if (!host || !host.isConnected || host.classList.contains(OVERLAY_CLASS)) return;
    host.classList.add(OVERLAY_CLASS);
    host.style.position = "absolute";
    host.style.zIndex = OVERLAY_Z;
    document.body.appendChild(host);
    positionOverlay(handle);
  }

  /** 用标题元素的视口矩形 + 页面滚动量换算文档坐标，把宿主钉在标题上沿往上 2px */
  function positionOverlay(handle) {
    const host = handle && handle.host;
    const titleEl = handle && handle.titleEl;
    if (!host || !titleEl || !host.isConnected || !titleEl.isConnected) return;
    if (!host.classList.contains(OVERLAY_CLASS)) return;
    try {
      const rect = titleEl.getBoundingClientRect();
      const scrollX = window.scrollX || window.pageXOffset || 0;
      const scrollY = window.scrollY || window.pageYOffset || 0;
      host.style.left = Math.round(rect.left + scrollX) + "px";
      host.style.top = Math.round(rect.top + scrollY - 2) + "px";
    } catch (e) {}
  }

  /** 结果重排 / 窗口尺寸变化会让 overlay 漂移，对已存在的 overlay 重新测量 */
  function repositionOverlays() {
    S.chips.forEach((handles) => {
      for (const h of handles) positionOverlay(h);
    });
  }

  /**
   * 徽章挂载后延迟一帧审计：沿祖先链（≤16 层）读计算样式，发现任何偏离默认值的
   * transform 族 / 排版属性，就把结论写进宿主 title（悬停即可看到，不需要会
   * DevTools）并 console.warn 完整清单，同时把该徽章切到 overlay 模式
   * （物理脱离被污染的祖先链）。未检测到污染的徽章维持文档流现状，零回归。
   */
  function diagnoseHost(handle) {
    const host = handle && handle.host;
    const chip = handle && handle.chip;
    setTimeout(() => {
      try {
        const findings = auditHostStyles(host, chip);
        if (!findings.length) return;
        const summary = auditSummary(findings);
        host.dataset.rsAudit = summary;
        host.title = withAuditNote(host, host.title || "");
        console.warn("[Read or Skip] " + summary + "，该徽章已自动切换为 overlay 模式", findings.slice());
        promoteToOverlay(handle);
      } catch (e) {}
    }, 0);
  }

  /** paintChip 只碰 shadow 内部的 chip；提示同时写在 chip 与宿主上（悬停宿主也能看到），审计结论保留在前 */
  function paintChip(handle, result) {
    const chip = handle && handle.chip ? handle.chip : handle;
    const host = handle && handle.host ? handle.host : null;
    if (!chip) return;
    const v = RS.VERDICT[result.verdict] || RS.VERDICT.unknown;
    const known = ["read", "skim", "skip", "pending"].indexOf(result.verdict) !== -1;
    const theme = themeFor(known ? result.verdict : "pending");
    const cred = typeof result.credibility === "number" ? " · " + result.credibility + "%" : "";
    chip.textContent = v.label + cred;
    chip.dataset.v = known ? result.verdict : "pending";
    chip.dataset.marker = theme.marker;
    const tip = [];
    tip.push(v.label);
    if (typeof result.relevance === "number") tip.push("与查询意图相关度 " + result.relevance + "%");
    if (typeof result.credibility === "number") tip.push("信息可信度 " + result.credibility + "%");
    if (result.warning === "intent") tip.push("⚠️ 可能名不副实 / 商业页");
    chip.title = tip.join("\n");
    if (host) host.title = withAuditNote(host, tip.join("\n"));
    chip.dataset.state = "done";
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
      for (const handle of S.chips.get(item.url) || []) paintChip(handle, r);
    }
    if (!resp.ok && resp.error && !Object.keys(results).length) {
      for (const item of items) {
        for (const handle of S.chips.get(item.url) || []) {
          const chip = handle.chip || handle;
          const host = handle.host || null;
          chip.textContent = "未评估";
          chip.title = resp.error.message || "";
          if (host) host.title = withAuditNote(host, resp.error.message || "");
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
    // 窗口尺寸变化会让 overlay 漂移，重测一次（passive：不阻塞滚动合成）
    if (!S.resizeBound) {
      S.resizeBound = true;
      window.addEventListener("resize", repositionOverlays, { passive: true });
    }
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
          // 徽章本体在 shadow root 里，light DOM 只清宿主元素即可整体移除
          document.querySelectorAll("." + HOST_CLASS).forEach((n) => n.remove());
          document.querySelectorAll("[data-rs-done]").forEach((n) => n.removeAttribute("data-rs-done"));
        }
        scan();
        // 结果重排会让 overlay 漂移，对已存在的 overlay 重新测量一次
        repositionOverlays();
      }, 400);
    });
    mo.observe(root, { childList: true, subtree: true });
    S.seenUrl = location.href;
  }
})(globalThis.RS);
