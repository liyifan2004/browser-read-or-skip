/**
 * Read or Skip —— 页面浮层（HUD）。
 *
 * 交互设计：
 *  - 页面加载后先出「初判」（毫秒级），模型结果到达后原地升级，不闪烁、不跳位。
 *  - 命中缓存或搜索结果预判时，几乎立刻给出结论。
 *  - 默认展开一览，超时后自动收成角标；焦点或指针在卡片上时不收起；角标可拖动、可点击展开。
 *  - 全部渲染在 Shadow DOM 内，不污染宿主页样式，也不被宿主页样式污染。
 *  - 快捷键由 chrome.commands 统一路由（经 RS_TOGGLE_PANEL 消息），本脚本不抢页面按键。
 */
(function (RS) {
  if (window !== window.top) return;
  if (window.__RS_HUD_LOADED__) return;
  window.__RS_HUD_LOADED__ = true;

  const HOST_ID = "read-or-skip-host";
  const POS_KEY = "rs.hud.pos";

  const S = {
    settings: null,
    page: null,
    result: null,
    host: null,
    shadow: null,
    wrap: null,
    pill: null,
    card: null,
    expanded: false,
    hidden: false,
    mounted: false,
    collapseTimer: 0,
    currentUrl: location.href,
    navGuard: 0,
    busy: false,
    localElapsed: 0,
    skipped: null,
    hover: false,
    bootAt: performance.now()
  };

  /* ================= 样式 ================= */
  /* 令牌与 popup / options 共用同一套 --rs-*；Shadow DOM 里 :root 不可达，落在 :host 上。 */

  const CSS = `
:host {
  all: initial;
  --rs-canvas: #0C0E13; --rs-surface: #15181E; --rs-surface-2: #1E222A; --rs-field: #0A0C10;
  --rs-border: #262B34; --rs-border-ctl: #5E6675; --rs-text: #EDEFF4; --rs-text-2: #9CA4B3;
  --rs-accent: #3B82F6; --rs-focus: #7FB0FF; --rs-read: #4ADE9E; --rs-skim: #F2C14E;
  --rs-skip: #A7B0BE; --rs-warn: #FBBF24; --rs-danger: #FD8A9B;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
[hidden] { display: none !important; }
:focus-visible { outline: 2px solid var(--rs-focus); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
.wrap {
  position: fixed; z-index: 2147483646;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
               "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
  font-size: 13px; line-height: 1.5; color: var(--rs-text);
  -webkit-font-smoothing: antialiased;
  transition: opacity .18s ease, transform .18s ease;
}
.wrap.dragging { transition: none; cursor: grabbing; }
.wrap.hidden { opacity: 0; pointer-events: none; transform: translateY(8px) scale(.98); }

/* ---------- 角标 ---------- */
.pill {
  display: flex; align-items: center; gap: 8px;
  height: 40px; padding: 0 16px 0 12px;
  border-radius: 999px; cursor: pointer; user-select: none;
  background: rgba(18,20,26,.90);
  border: 1px solid var(--rs-border-ctl);
  box-shadow: 0 6px 24px rgba(0,0,0,.42);
  backdrop-filter: blur(14px) saturate(160%);
  -webkit-backdrop-filter: blur(14px) saturate(160%);
  transition: transform .16s cubic-bezier(.2,.8,.3,1), box-shadow .16s ease;
}
.pill:hover { transform: translateY(-2px); box-shadow: 0 12px 32px rgba(0,0,0,.5); }
.pill .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; box-shadow: 0 0 0 3px var(--glow); }
.pill .plabel { font-weight: 600; letter-spacing: .2px; white-space: nowrap; }
.pill .pscore { font-variant-numeric: tabular-nums; color: var(--rs-text-2); font-size: 12px; }
.pill .chev { opacity: .5; flex: none; }
.pill.pending .dot { animation: rs-pulse 1.1s ease-in-out infinite; }
@keyframes rs-pulse {
  0%,100% { box-shadow: 0 0 0 0 var(--glow); }
  50%     { box-shadow: 0 0 0 6px rgba(96,165,250,0); }
}
.wrap.fresh .pill { animation: rs-in .34s cubic-bezier(.2,.9,.3,1.1); }
@keyframes rs-in { from { transform: translateY(10px) scale(.94); opacity: 0; } to { transform: none; opacity: 1; } }

/* ---------- 卡片 ---------- */
.card {
  width: 348px; border-radius: 12px; overflow: hidden;
  background: rgba(21,24,30,.97);
  border: 1px solid var(--rs-border);
  box-shadow: 0 18px 48px rgba(0,0,0,.55);
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  transform-origin: bottom right;
  animation: rs-card-in .2s cubic-bezier(.2,.9,.3,1);
}
@keyframes rs-card-in { from { transform: translateY(6px) scale(.97); opacity: 0; } to { transform: none; opacity: 1; } }

/* 顶栏：判定词 20px 是唯一第一视觉，综合分是右端的等宽数字 */
.head { display: flex; align-items: flex-start; gap: 12px; padding: 16px 16px 12px; cursor: grab; }
.head:active { cursor: grabbing; }
.headtext { flex: 1; min-width: 0; }
.verdict { font-size: 20px; font-weight: 600; letter-spacing: .2px; color: var(--accent); display: flex; align-items: center; gap: 8px; line-height: 1.25; }
.verdict .src {
  font-size: 11.5px; font-weight: 600; color: var(--rs-text-2); border: 1px solid var(--rs-border-ctl);
  border-radius: 4px; padding: 1px 6px; letter-spacing: 0; white-space: nowrap;
}
.verdict .src.live { color: var(--rs-focus); border-color: var(--rs-accent); animation: rs-blink 1.5s ease-in-out infinite; }
@keyframes rs-blink { 0%,100% { opacity: 1 } 50% { opacity: .45 } }
.reason { font-size: 12.5px; color: var(--rs-text-2); margin-top: 4px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.score {
  flex: none; font-size: 13px; font-weight: 600; color: var(--rs-text-2);
  font-variant-numeric: tabular-nums; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  padding-top: 4px;
}
.iconbtn {
  position: relative; flex: none; width: 28px; height: 28px; border-radius: 8px; border: 1px solid var(--rs-border-ctl);
  background: transparent; color: var(--rs-text-2); cursor: pointer; display: grid; place-items: center;
  transition: background .14s ease, color .14s ease;
}
.iconbtn::after { content: ""; position: absolute; inset: -8px; }
.iconbtn:hover { background: var(--rs-surface-2); color: var(--rs-text); }

/* 综合分刻度：同一像素位，真实数据替代装饰光条 */
.scale { height: 2px; background: var(--rs-border); }
.scalefill { display: block; height: 100%; width: 0; background: var(--accent);
  transition: width .55s cubic-bezier(.2,.8,.25,1); }

/* 警告 */
.warn {
  display: flex; align-items: flex-start; gap: 8px; margin: 12px 16px 0;
  padding: 8px 12px; border-radius: 8px;
  background: rgba(251,191,36,.10); border: 1px solid var(--rs-warn);
  color: var(--rs-warn); font-size: 12px; line-height: 1.45;
}
.warn.err { background: rgba(253,138,155,.10); border-color: var(--rs-danger); color: var(--rs-danger); }
.warn svg { flex: none; margin-top: 1px; }
.warn .fix { color: var(--rs-warn); text-decoration: underline; cursor: pointer; }
.warn.err .fix { color: var(--rs-danger); }

/* 指标：数值条一律 accent 色相，不按高低换色 */
.metrics { padding: 12px 16px 4px; display: flex; flex-direction: column; gap: 8px; }
.metric { display: grid; grid-template-columns: 72px 1fr 44px; align-items: center; gap: 8px; }
.mlabel { font-size: 12px; color: var(--rs-text-2); white-space: nowrap; }
.track { height: 2px; border-radius: 999px; background: var(--rs-border); overflow: hidden; }
.fill { height: 100%; border-radius: 999px; width: 0; background: var(--rs-accent);
  transition: width .55s cubic-bezier(.2,.8,.25,1); }
.fill.skeleton { background: var(--rs-border); width: 100% !important; }
.mval { font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; color: var(--rs-text); font-weight: 600; }
.mval.dim { color: var(--rs-text-2); font-weight: 500; }

/* 芯片行：全部中性（次要文字色 + 细描边），只有警告类允许琥珀 */
.chips { display: flex; flex-wrap: wrap; gap: 8px; padding: 12px 16px 0; }
.chip {
  font-size: 12px; padding: 3px 8px; border-radius: 8px;
  background: transparent; border: 1px solid var(--rs-border-ctl); color: var(--rs-text-2);
  display: inline-flex; align-items: center; gap: 4px; white-space: nowrap;
}
.chip b { color: var(--rs-text); font-weight: 600; }

/* 底栏：只留一个主按钮「重新评估」和一个关闭 */
.foot { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin-top: 12px; padding: 8px 16px 12px; border-top: 1px solid var(--rs-border); }
.footmeta { font-size: 12px; color: var(--rs-text-2); display: flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.footmeta .sep { opacity: .4; }
.footactions { display: flex; gap: 8px; flex: none; }
.tbtn {
  font-size: 12px; font-family: inherit; padding: 6px 12px; border-radius: 8px; cursor: pointer;
  background: transparent; border: 1px solid var(--rs-border-ctl); color: var(--rs-text-2);
  transition: background .14s ease, color .14s ease; white-space: nowrap;
}
.tbtn:hover { background: var(--rs-surface-2); color: var(--rs-text); }
.tbtn.primary { background: var(--rs-accent); border-color: transparent; color: #fff; font-weight: 600; }
.tbtn.primary:hover { filter: brightness(1.12); }
.tbtn[disabled] { opacity: .45; cursor: default; }

/* ---------- 暂停菜单：承诺感从轻到重 ---------- */
.pausemenu {
  display: flex; flex-direction: column; gap: 2px;
  margin: 10px 16px 0; padding: 6px;
  border-radius: 8px; border: 1px solid var(--rs-border);
  background: var(--rs-surface-2);
}
.pausemenu .pitem {
  font: 500 12px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  text-align: left; padding: 7px 9px; border: none; border-radius: 4px;
  background: none; color: var(--rs-text-2); cursor: pointer; min-height: 32px;
}
.pausemenu .pitem:hover { background: var(--rs-surface); color: var(--rs-text); }
.pausemenu .pitem:focus-visible { outline: 2px solid var(--rs-focus); outline-offset: 1px; }
.pausemenu .pitem.danger { color: var(--rs-danger); }
.pausemenu .pdiv { height: 1px; background: var(--rs-border); margin: 3px 4px; }
`;

  /* ================= 图标 ================= */

  const ICON = {
    book: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h6a3 3 0 0 1 3 3v13a2.5 2.5 0 0 0-2.5-2.5H2z"/><path d="M22 4h-6a3 3 0 0 0-3 3v13a2.5 2.5 0 0 1 2.5-2.5H22z"/></svg>',
    scan: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V5a1 1 0 0 1 1-1h2M20 7V5a1 1 0 0 0-1-1h-2M4 17v2a1 1 0 0 0 1 1h2M20 17v2a1 1 0 0 1-1 1h-2"/><path d="M3 12h18"/></svg>',
    skip: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4l10 8-10 8z"/><path d="M19 4v16"/></svg>',
    alert: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
    chev: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>',
    collapse: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M5 12h14"/></svg>',
    close: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
    warn: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/></svg>'
  };

  /**
   * 结果页交给 serp.js 打等级，浮层让位，避免同一屏两套标注打架。
   * 但标注功能关掉时必须自己顶上，否则用户两边都得不到结论。
   */
  function looksLikeSearchResultsPage() {
    if (!S.settings || !S.settings.annotateSerp) return false;
    return RS.heuristics.isSearchResultsPage(location.href);
  }

  /* ================= 启动 ================= */

  init().catch(() => {});

  async function init() {
    S.settings = await RS.storage.getSettings();
    // 每种"不出浮层"的原因都要留下记号：弹出面板用 skipped 告诉用户为什么没动静，
    // 否则用户只会看到"什么都没发生"。
    if (!S.settings.enabled || !S.settings.showHud) {
      S.skipped = "off";
      return;
    }
    if (RS.heuristics.isBlocked(location.href, S.settings)) {
      S.skipped = "blocked";
      return;
    }
    if (looksLikeSearchResultsPage()) {
      S.skipped = "serp";
      return;
    }
    if (!RS.heuristics.isReadablePage()) {
      S.skipped = "not-readable";
      return;
    }

    RS.storage.onSettingsChanged((next) => {
      const wasOn = S.settings && S.settings.showHud;
      S.settings = next;
      if (!next.enabled || !next.showHud) {
        if (wasOn) hide(true);
      } else if (!S.mounted) {
        void boot();
      }
    });

    // 只保留 Escape 处理，且仅在焦点 / 指针位于浮层上时响应（见 onKey）。
    // Alt+Shift+R 由 chrome.commands 统一路由，经 RS_TOGGLE_PANEL 消息进来。
    document.addEventListener("keydown", onKey, true);
    watchNavigation();
    await boot();
  }

  async function boot() {
    // ① 命中缓存 / 搜索结果预判：近乎零延迟出结论
    const cached = await RS.storage.getCacheEntry(location.href, S.settings);
    if (cached && cached.result) {
      S.result = Object.assign({}, cached.result, {
        source: cached.partial ? "partial" : "cache"
      });
      mount(false);
    }

    whenReady(async () => {
      const t0 = performance.now();
      S.page = RS.extract.page();
      S.localElapsed = Math.round(performance.now() - t0);

      if (!S.mounted) {
        const h = RS.heuristics.scorePage(S.page, S.settings);
        S.result = h;
        mount(true);
      } else if (!S.result || S.result.source === "partial") {
        // 已有预判，先保留，等模型结果
      }

      await evaluate();
    });
  }

  /* ================= 评估 ================= */

  async function evaluate(force) {
    if (S.busy) return;
    S.busy = true;
    setBusyUI(true);
    const t0 = performance.now();

    try {
      const page = S.page || RS.extract.page();
      const state = RS.extract.buildState(page, S.settings);
      const resp = await chrome.runtime.sendMessage({
        type: RS.MSG.EVALUATE,
        payload: { page, state, force: !!force }
      });

      if (resp && resp.ok && resp.result) {
        const r = Object.assign({}, resp.result);
        if (r.source !== "cache") r.elapsedMs = Math.round(performance.now() - t0);
        r.readingMinutes = r.readingMinutes || RS.heuristics.readingMinutes(page.charCount, page.cjkRatio);
        S.result = r;
        render();
        expand(true);
      } else if (resp && resp.error) {
        renderError(resp.error);
      } else {
        renderError({ code: "EMPTY", message: "未收到结果。" });
      }
    } catch (e) {
      renderError({ code: "IPC", message: "无法连接到扩展后台：" + (e && e.message ? e.message : e) });
    } finally {
      S.busy = false;
      setBusyUI(false);
    }
  }

  /* ================= 挂载 / 渲染 ================= */

  function mount(isFresh) {
    if (S.mounted) return;
    S.mounted = true;

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.all = "initial";
    host.style.position = "fixed";
    host.style.zIndex = "2147483646";
    host.style.top = "0";
    host.style.left = "0";
    host.style.width = "0";
    host.style.height = "0";
    S.host = host;

    const shadow = host.attachShadow({ mode: "open" });
    S.shadow = shadow;

    const style = document.createElement("style");
    style.textContent = CSS;

    const wrap = document.createElement("div");
    wrap.className = "wrap" + (isFresh ? " fresh" : "");
    wrap.innerHTML =
      '<div class="pill" role="button" tabindex="0" aria-label="Read or Skip 判定">' +
        '<span class="dot"></span>' +
        '<span class="plabel">初判</span>' +
        '<span class="pscore"></span>' +
        '<span class="chev">' + ICON.chev + "</span>" +
      "</div>" +
      '<div class="card" style="display:none"></div>';

    shadow.append(style, wrap);
    (document.body || document.documentElement).appendChild(host);

    S.wrap = wrap;
    S.pill = wrap.querySelector(".pill");
    S.card = wrap.querySelector(".card");

    // 指针是否悬停在浮层上：Escape 响应与自动收起都要看它
    wrap.addEventListener("mouseenter", () => { S.hover = true; });
    wrap.addEventListener("mouseleave", () => { S.hover = false; });

    applyPosition();
    bindDrag();

    S.pill.addEventListener("click", () => {
      if (S.wrap.classList.contains("dragging")) return;
      expand(!S.expanded);
    });
    S.pill.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        expand(!S.expanded);
      }
    });

    render();
    if (isFresh) setTimeout(() => S.wrap.classList.remove("fresh"), 500);
  }

  function hide(permanent) {
    if (S.wrap) S.wrap.classList.add("hidden");
    if (permanent) S.hidden = true;
  }

  function show() {
    if (S.wrap) S.wrap.classList.remove("hidden");
    S.hidden = false;
  }

  /**
   * 暂停菜单：承诺感从轻到重，最后一项收编了原来的「屏蔽此站」。
   * 放在卡片内部随内容展开，不用浮层定位，避免被 overflow 裁切。
   */
  function pauseMenuHTML() {
    return (
      '<div class="pausemenu" data-pausemenu hidden>' +
        '<button class="pitem" data-pause="3600000">暂停 1 小时</button>' +
        '<button class="pitem" data-pause="today">暂停到今天结束</button>' +
        '<button class="pitem" data-pause="604800000">暂停 7 天</button>' +
        '<span class="pdiv"></span>' +
        '<button class="pitem danger" data-pause="forever" title="这个站点不再弹浮层，可在弹窗里解除">永久屏蔽此站</button>' +
      "</div>"
    );
  }

  /**
   * 「暂停 / 永久屏蔽」：
   * - 暂停写进 settings.pausedSites = { 主机名: 到期时间戳 }，只对记下的主机名生效，到期自动恢复；
   * - forever 走黑名单（siteBlocklist），撤销入口在弹窗的「解除屏蔽」。
   * 分站点而不是全局：在 X 上暂停 1 小时，不应该影响同时开着的 GitHub 文档页。
   */
  async function pauseOrBlock(mode) {
    let host = "";
    try {
      host = location.hostname;
    } catch (e) {}
    if (!host) return;

    if (mode === "forever") {
      const cur = ((await RS.storage.getSettings()).siteBlocklist) || [];
      if (cur.indexOf(host) === -1) {
        await RS.storage.saveSettings({ siteBlocklist: cur.concat([host]) });
      }
    } else if (mode === "today") {
      const d = new Date();
      d.setHours(24, 0, 0, 0);
      const cur = ((await RS.storage.getSettings()).pausedSites) || {};
      cur[host] = d.getTime();
      await RS.storage.saveSettings({ pausedSites: cur });
    } else {
      const ms = Number(mode);
      const until = Date.now() + (isFinite(ms) && ms > 0 ? ms : 3600000);
      const cur = ((await RS.storage.getSettings()).pausedSites) || {};
      cur[host] = until;
      await RS.storage.saveSettings({ pausedSites: cur });
    }
    S.skipped = "blocked";
    hide(true);
  }

  /* ---------- 渲染 ---------- */

  function render() {
    if (!S.mounted || !S.wrap) return;
    const r = S.result;
    if (!r) return;

    const v = RS.VERDICT[r.verdict] || RS.VERDICT.unknown;
    const accent = r.source === "heuristic" ? "var(--rs-accent)" : v.color;
    S.wrap.style.setProperty("--accent", accent);
    S.wrap.style.setProperty("--glow", v.glow);
    S.wrap.classList.toggle("pending", r.verdict === "pending");

    // 角标
    const score = composite(r);
    S.pill.querySelector(".dot").style.background = accent;
    S.pill.querySelector(".plabel").textContent = r.source === "heuristic" ? "初判" : v.short;
    S.pill.querySelector(".plabel").style.color = accent;
    S.pill.querySelector(".pscore").textContent = score == null ? "" : score + "%";

    // 卡片
    const pctText = score == null ? "–" : String(score);
    const pctNum = score == null ? 0 : Math.max(0, Math.min(100, score));
    const srcTag = srcLabel(r);

    S.card.innerHTML =
      '<div class="head">' +
        '<div class="headtext">' +
          '<div class="verdict">' +
            (r.source === "heuristic" ? "初判" : v.label) +
            '<span class="src">' + srcTag + "</span>" +
          "</div>" +
          '<div class="reason">' + esc(r.reason || "") + "</div>" +
        "</div>" +
        '<span class="score">' + pctText + "%</span>" +
        '<button class="iconbtn" data-act="collapse" title="收起">' + ICON.collapse + "</button>" +
      "</div>" +
      '<div class="scale"><span class="scalefill" style="width:' + pctNum.toFixed(1) + '%"></span></div>' +
      warnHTML(r) +
      '<div class="metrics">' +
        metric("相关度", r.relevance, r.source === "heuristic") +
        metric("新信息", r.novelty, r.source === "heuristic") +
        metric("可信度", r.credibility, r.source === "heuristic") +
        metric("时效性", r.timelessness, r.source === "heuristic") +
      "</div>" +
      chipsHTML(r) +
      pauseMenuHTML() +
      '<div class="foot">' +
        '<div class="footmeta">' + footMeta(r) + "</div>" +
        '<div class="footactions">' +
          '<button class="tbtn primary" data-act="refresh">重新评估</button>' +
          '<button class="tbtn" data-act="pause" title="这段时间内这个站点不再弹浮层">暂停 ▾</button>' +
          '<button class="tbtn" data-act="close" title="本次不再显示">×</button>' +
        "</div>" +
      "</div>";

    S.card.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const act = btn.getAttribute("data-act");
        if (act === "collapse") expand(false);
        else if (act === "refresh") {
          btn.disabled = true;
          btn.textContent = "评估中…";
          evaluate(true).then(() => {
            btn.disabled = false;
            btn.textContent = "重新评估";
          });
        } else if (act === "block") {
          blockSite(btn);
        } else if (act === "pause") {
          const menu = S.card.querySelector("[data-pausemenu]");
          if (menu) menu.hidden = !menu.hidden;
        } else if (act === "close") {
          hide(true);
        }
      });
    });

    S.card.querySelectorAll("[data-pause]").forEach((item) => {
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        void pauseOrBlock(item.getAttribute("data-pause"));
      });
    });

    // 内容变化会改变卡片高度：渲染完再定位一次
    requestAnimationFrame(() => applyPosition());

    // 拖动把手只认头部空白区域
    bindHeadDrag();
  }

  function renderError(err) {
    if (!S.mounted) return;
    const r = S.result || RS.heuristics.scorePage(S.page || { url: location.href, text: "" }, S.settings);
    S.result = r;
    render();
    if (!S.expanded) expand(true);
    const head = S.card.querySelector(".head");
    if (!head) return;
    const box = document.createElement("div");
    box.className = "warn err";
    const needKey = err.code === "NO_KEY";
    box.innerHTML =
      ICON.warn +
      "<span>" + esc(err.message || "评估失败") +
      (needKey ? ' <span class="fix" data-act="options">前往设置填写 API Key →</span>' : "") +
      "</span>";
    head.insertAdjacentElement("afterend", box);
    box.querySelectorAll("[data-act='options']").forEach((el) =>
      el.addEventListener("click", () => chrome.runtime.sendMessage({ type: RS.MSG.OPEN_OPTIONS }))
    );
    const tag = S.card.querySelector(".src");
    if (tag) tag.textContent = "失败";
  }

  function warnHTML(r) {
    if (r.warning === "redundant") {
      return '<div class="warn">' + ICON.warn + "<span>⚠️ 可能没有太多新信息：与你已掌握的内容高度重复。</span></div>";
    }
    if (r.warning === "intent") {
      return '<div class="warn">' + ICON.warn + "<span>标题与内容可能不符，或属于商业页 / 登录墙，谨慎投入时间。</span></div>";
    }
    if (r.lowConfidence) {
      return '<div class="warn">' + ICON.warn + "<span>模型对这个判断的置信度偏低（" +
        Math.round(r.confidence * 100) + "%），建议自行扫一眼再决定。</span></div>";
    }
    return "";
  }

  function metric(label, value, approximate) {
    const has = typeof value === "number";
    const w = has ? Math.max(2, value) : 0;
    return (
      '<div class="metric">' +
        '<span class="mlabel">' + label + "</span>" +
        '<span class="track">' +
          '<span class="fill' + (has ? "" : " skeleton") + '" style="width:' + (has ? w : 100) + '%"></span>' +
        "</span>" +
        '<span class="mval' + (approximate ? " dim" : "") + '">' + (has ? value + "%" : "…") + "</span>" +
      "</div>"
    );
  }

  function chipsHTML(r) {
    const out = [];
    if (r.value || r.valueKey) {
      const key = r.valueKey || r.value;
      out.push('<span class="chip">阅读价值 <b>' + esc(RS.VALUE_LABEL[key] || "–") + "</b></span>");
    }
    if (r.contentType) {
      out.push('<span class="chip">' + esc(RS.CONTENT_TYPE_LABEL[r.contentType] || r.contentType) + "</span>");
    }
    if (r.readingMinutes) {
      out.push('<span class="chip">约 <b>' + r.readingMinutes + "</b> 分钟</span>");
    }
    if (r.kind === "serp") {
      out.push('<span class="chip">结果页预判</span>');
    }
    return out.length ? '<div class="chips">' + out.join("") + "</div>" : "";
  }

  function footMeta(r) {
    const bits = [];
    if (r.elapsedMs) bits.push("耗时 " + r.elapsedMs + "ms");
    else if (r.source === "cache") bits.push("来自缓存");
    else if (r.source === "partial") bits.push("来自搜索结果预判");
    else if (r.source === "heuristic" && S.localElapsed) bits.push("本地 " + S.localElapsed + "ms");
    if (S.page && S.page.charCount) bits.push(S.page.charCount.toLocaleString("zh-CN") + " 字");
    const d = S.page && S.page.domain;
    if (d) bits.push(d);
    return bits.map(esc).join('<span class="sep">·</span>');
  }

  function srcLabel(r) {
    if (r.source === "heuristic") return "初判";
    if (r.source === "cache") return "缓存";
    if (r.source === "partial") return "预判";
    if (r.model) return String(r.model).replace(/^jev-/, "jev ");
    return "模型";
  }

  function composite(r) {
    const parts = [];
    if (typeof r.relevance === "number") parts.push([r.relevance, 0.45]);
    if (typeof r.novelty === "number") parts.push([r.novelty, 0.3]);
    if (typeof r.credibility === "number") parts.push([r.credibility, 0.25]);
    if (typeof r.relevance === "number" && typeof r.novelty !== "number") {
      return Math.round(r.relevance * 0.65 + (r.credibility || 50) * 0.35);
    }
    if (!parts.length) return null;
    const total = parts.reduce((a, p) => a + p[1], 0);
    return Math.round(parts.reduce((a, p) => a + p[0] * p[1], 0) / total);
  }

  function setBusyUI(on) {
    if (!S.mounted) return;
    S.wrap.classList.toggle("pending", on || (S.result && S.result.source === "heuristic"));
  }

  /* ================= 展开 / 收起 ================= */

  function expand(on) {
    if (!S.mounted) return;
    S.expanded = !!on;
    S.pill.style.display = S.expanded ? "none" : "flex";
    S.card.style.display = S.expanded ? "block" : "none";
    clearTimeout(S.collapseTimer);
    if (S.expanded) {
      const ms = (S.settings && S.settings.hudAutoCollapseMs) || 9000;
      if (ms > 0) {
        S.collapseTimer = setTimeout(() => {
          // 键盘用户把焦点移进卡片、或指针悬停在卡片上时，不打断阅读
          const ae = (S.shadow && S.shadow.activeElement) || null;
          const focusInside = !!(ae && S.card.contains(ae));
          if (!focusInside && !S.hover && !S.card.matches(":hover")) expand(false);
        }, ms);
      }
    }
    applyPosition();
  }

  /* ================= 位置 / 拖动 ================= */

  async function applyPosition() {
    if (!S.wrap) return;
    const saved = (await RS.storage.rawGet(POS_KEY)) || null;
    // 实测尺寸，替代硬编码估计值（卡片高度随警告条与芯片数量变化）
    const rect = S.wrap.getBoundingClientRect();
    const w = rect.width || (S.expanded ? 348 : 150);
    const h = rect.height || (S.expanded ? 300 : 40);
    let left;
    let top;
    if (saved && typeof saved.left === "number") {
      left = Math.min(Math.max(6, saved.left), Math.max(6, window.innerWidth - w - 6));
      top = Math.min(Math.max(6, saved.top), Math.max(6, window.innerHeight - h - 6));
    } else {
      left = Math.max(12, window.innerWidth - w - 18);
      top = Math.max(12, window.innerHeight - h - 18);
    }
    S.wrap.style.left = left + "px";
    S.wrap.style.top = top + "px";
    S.wrap.style.right = "auto";
    S.wrap.style.bottom = "auto";
  }

  function bindDrag() {
    window.addEventListener("resize", () => applyPosition(), { passive: true });
  }

  function bindHeadDrag() {
    const head = S.card.querySelector(".head");
    if (!head) return;
    head.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest("button")) return;
      const startX = e.clientX;
      const startY = e.clientY;
      const rect = S.wrap.getBoundingClientRect();
      const ox = rect.left;
      const oy = rect.top;
      const w = rect.width || (S.expanded ? 348 : 150);
      const h = rect.height || (S.expanded ? 300 : 40);
      let moved = false;

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        moved = true;
        S.wrap.classList.add("dragging");
        S.wrap.style.left = Math.min(Math.max(4, ox + dx), window.innerWidth - w - 4) + "px";
        S.wrap.style.top = Math.min(Math.max(4, oy + dy), window.innerHeight - h - 4) + "px";
      };
      const onUp = () => {
        document.removeEventListener("pointermove", onMove, true);
        document.removeEventListener("pointerup", onUp, true);
        S.wrap.classList.remove("dragging");
        if (moved) {
          const rect2 = S.wrap.getBoundingClientRect();
          RS.storage.rawSet(POS_KEY, { left: Math.round(rect2.left), top: Math.round(rect2.top) });
        }
      };
      document.addEventListener("pointermove", onMove, true);
      document.addEventListener("pointerup", onUp, true);
      e.preventDefault();
    });
  }

  /* ================= 导航 / 快捷键 / 消息 ================= */

  function whenReady(cb) {
    const run = () => {
      // 让出两帧，等首屏布局稳定后再抽取正文，避免拿到骨架屏文本
      requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(cb, 0)));
    };
    if (document.readyState === "complete") run();
    else if (document.readyState === "interactive") run();
    else document.addEventListener("DOMContentLoaded", run, { once: true });
  }

  function watchNavigation() {
    setInterval(() => {
      if (location.href === S.currentUrl) return;
      S.currentUrl = location.href;
      onNavigate();
    }, 1200);
  }

  async function onNavigate() {
    if (looksLikeSearchResultsPage()) {
      S.skipped = "serp";
      hide(true);
      return;
    }
    if (RS.heuristics.isBlocked(location.href, S.settings)) {
      S.skipped = "blocked";
      hide(true);
      return;
    }
    S.skipped = null;
    S.page = null;
    S.result = null;
    clearTimeout(S.navGuard);
    S.navGuard = setTimeout(async () => {
      const cached = await RS.storage.getCacheEntry(location.href, S.settings);
      if (cached && cached.result) {
        S.result = Object.assign({}, cached.result, { source: cached.partial ? "partial" : "cache" });
      }
      whenReady(() => {
        S.page = RS.extract.page();
        if (!S.result || (S.result.kind === "serp")) {
          S.result = RS.heuristics.scorePage(S.page, S.settings);
        }
        show();
        render();
        expand(true);
        evaluate(true);
      });
    }, 700);
  }

  /**
   * 只处理 Escape，且有条件响应：焦点在卡片内、或指针悬停在浮层上时才收起，
   * 并阻断传播，避免吃掉宿主页自己的 Esc 行为（反向：也不让宿主页抢走收起动作）。
   */
  function onKey(e) {
    if (e.key !== "Escape" || !S.expanded) return;
    const ae = (S.shadow && S.shadow.activeElement) || null;
    const focusInside = !!(ae && S.card.contains(ae));
    if (!focusInside && !S.hover) return;
    e.stopPropagation();
    e.preventDefault();
    expand(false);
  }

  function toggle() {
    if (!S.mounted) {
      void boot();
      return;
    }
    if (S.expanded) expand(false);
    else {
      show();
      expand(true);
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    if (msg.type === "RS_TOGGLE_PANEL") {
      toggle();
      sendResponse({ ok: true, expanded: S.expanded });
      return false;
    }
    if (msg.type === "RS_FORCE_REFRESH") {
      show();
      expand(true);
      evaluate(true);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === "RS_GET_HUD_STATE") {
      sendResponse({
        ok: true,
        mounted: S.mounted,
        expanded: S.expanded,
        skipped: S.skipped || null,
        result: S.result,
        page: S.page ? { title: S.page.title, domain: S.page.domain, charCount: S.page.charCount } : null
      });
      return false;
    }
    return false;
  });

  /* ================= 小工具 ================= */

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }
})(globalThis.RS);
