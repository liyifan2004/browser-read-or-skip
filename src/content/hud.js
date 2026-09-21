/**
 * Read or Skip —— 页面浮层（HUD）。
 *
 * 交互设计：
 *  - 页面加载后先出「本地估算」（毫秒级），模型结果到达后原地升级，不闪烁、不跳位。
 *  - 命中缓存或搜索结果预判时，几乎立刻给出结论。
 *  - 默认展开一览，9 秒后自动收成角标，避免长期遮挡内容；角标可拖动、可点击展开。
 *  - 全部渲染在 Shadow DOM 内，不污染宿主页样式，也不被宿主页样式污染。
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
    bootAt: performance.now()
  };

  /* ================= 样式 ================= */

  const CSS = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; padding: 0; }
.wrap {
  position: fixed; z-index: 2147483646;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
               "Microsoft YaHei", "Helvetica Neue", Arial, sans-serif;
  font-size: 13px; line-height: 1.5; color: #E8EAF0;
  -webkit-font-smoothing: antialiased;
  transition: opacity .18s ease, transform .18s ease;
}
.wrap.dragging { transition: none; cursor: grabbing; }
.wrap.hidden { opacity: 0; pointer-events: none; transform: translateY(8px) scale(.98); }

/* ---------- 角标 ---------- */
.pill {
  display: flex; align-items: center; gap: 8px;
  height: 40px; padding: 0 14px 0 12px;
  border-radius: 999px; cursor: pointer; user-select: none;
  background: rgba(18,20,26,.90);
  border: 1px solid rgba(255,255,255,.10);
  box-shadow: 0 6px 24px rgba(0,0,0,.42), inset 0 1px 0 rgba(255,255,255,.06);
  backdrop-filter: blur(14px) saturate(160%);
  -webkit-backdrop-filter: blur(14px) saturate(160%);
  transition: transform .16s cubic-bezier(.2,.8,.3,1), box-shadow .16s ease, border-color .16s ease;
}
.pill:hover { transform: translateY(-2px); box-shadow: 0 12px 32px rgba(0,0,0,.5), inset 0 1px 0 rgba(255,255,255,.08); }
.pill .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; box-shadow: 0 0 0 3px var(--glow); }
.pill .plabel { font-weight: 600; letter-spacing: .2px; white-space: nowrap; }
.pill .pscore { font-variant-numeric: tabular-nums; color: #9AA1AE; font-size: 12px; }
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
  width: 348px; border-radius: 18px; overflow: hidden;
  background: linear-gradient(180deg, rgba(24,27,34,.96), rgba(16,18,23,.97));
  border: 1px solid rgba(255,255,255,.09);
  box-shadow: 0 18px 48px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06);
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  transform-origin: bottom right;
  animation: rs-card-in .2s cubic-bezier(.2,.9,.3,1);
}
@keyframes rs-card-in { from { transform: translateY(6px) scale(.97); opacity: 0; } to { transform: none; opacity: 1; } }
.card::before {
  content: ""; display: block; height: 2px;
  background: linear-gradient(90deg, transparent, var(--accent), transparent);
  opacity: .9;
}

/* 顶栏 */
.head { display: flex; align-items: center; gap: 12px; padding: 14px 14px 12px; cursor: grab; }
.head:active { cursor: grabbing; }
.ring { position: relative; width: 52px; height: 52px; flex: none; }
.ring svg { display: block; transform: rotate(-90deg); }
.ring .num {
  position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
  font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; letter-spacing: -.3px;
}
.ring .num small { font-size: 9px; font-weight: 600; opacity: .6; margin-left: 1px; }
.headtext { flex: 1; min-width: 0; }
.verdict { font-size: 16px; font-weight: 700; letter-spacing: .2px; color: var(--accent); display: flex; align-items: center; gap: 6px; }
.verdict .src {
  font-size: 10px; font-weight: 600; color: #9AA1AE; border: 1px solid rgba(255,255,255,.14);
  border-radius: 5px; padding: 1px 5px; letter-spacing: 0; white-space: nowrap;
}
.reason { font-size: 11.5px; color: #A6ADBB; margin-top: 3px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.verdict .src.live { color: #93C5FD; border-color: rgba(96,165,250,.38); animation: rs-blink 1.5s ease-in-out infinite; }
@keyframes rs-blink { 0%,100% { opacity: 1 } 50% { opacity: .45 } }
.iconbtn {
  flex: none; width: 26px; height: 26px; border-radius: 8px; border: 1px solid rgba(255,255,255,.10);
  background: rgba(255,255,255,.04); color: #A6ADBB; cursor: pointer; display: grid; place-items: center;
  transition: background .14s ease, color .14s ease;
}
.iconbtn:hover { background: rgba(255,255,255,.11); color: #fff; }

/* 警告 */
.warn {
  display: flex; align-items: flex-start; gap: 8px; margin: 0 14px 10px;
  padding: 8px 10px; border-radius: 10px;
  background: rgba(251,191,36,.10); border: 1px solid rgba(251,191,36,.28);
  color: #FCD34D; font-size: 11.5px; line-height: 1.45;
}
.warn.err { background: rgba(251,113,133,.10); border-color: rgba(251,113,133,.30); color: #FDA4AF; }
.warn svg { flex: none; margin-top: 1px; }
.warn .fix { color: #FDE68A; text-decoration: underline; cursor: pointer; }
.warn.err .fix { color: #FECDD3; }

/* 指标 */
.metrics { padding: 0 14px 4px; display: flex; flex-direction: column; gap: 9px; }
.metric { display: grid; grid-template-columns: 62px 1fr 42px; align-items: center; gap: 9px; }
.mlabel { font-size: 11.5px; color: #98A0AE; white-space: nowrap; }
.track { height: 6px; border-radius: 3px; background: rgba(255,255,255,.075); overflow: hidden; position: relative; }
.fill { height: 100%; border-radius: 3px; width: 0;
  background: linear-gradient(90deg, var(--accent), var(--accent2));
  transition: width .55s cubic-bezier(.2,.8,.25,1); position: relative; }
.fill::after { content:""; position:absolute; inset:0; border-radius:3px;
  background: linear-gradient(180deg, rgba(255,255,255,.28), transparent 60%); }
.fill.skeleton { background: linear-gradient(90deg, rgba(255,255,255,.06) 25%, rgba(255,255,255,.16) 37%, rgba(255,255,255,.06) 63%);
  background-size: 400% 100%; width: 100% !important; animation: rs-shimmer 1.25s ease infinite; }
@keyframes rs-shimmer { from { background-position: 100% 0; } to { background-position: 0 0; } }
.mval { font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; color: #D6DAE3; font-weight: 600; }
.mval.dim { color: #78808E; font-weight: 500; }

/* 芯片行 */
.chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px 14px 0; }
.chip {
  font-size: 11px; padding: 3px 8px; border-radius: 7px;
  background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.08); color: #A6ADBB;
  display: inline-flex; align-items: center; gap: 5px; white-space: nowrap;
}
.chip b { color: #E8EAF0; font-weight: 600; }
.chip.hi { background: rgba(52,211,153,.10); border-color: rgba(52,211,153,.26); color: #6EE7B7; }
.chip.mid { background: rgba(251,191,36,.10); border-color: rgba(251,191,36,.26); color: #FCD34D; }
.chip.lo { background: rgba(148,163,184,.10); border-color: rgba(148,163,184,.22); color: #A9B4C4; }

/* 底栏 */
.foot { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin-top: 12px; padding: 10px 14px; border-top: 1px solid rgba(255,255,255,.07); background: rgba(0,0,0,.14); }
.footmeta { font-size: 10.5px; color: #7C8494; display: flex; align-items: center; gap: 5px; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
.footmeta .sep { opacity: .4; }
.footactions { display: flex; gap: 6px; flex: none; }
.tbtn {
  font-size: 11px; font-family: inherit; padding: 4px 9px; border-radius: 7px; cursor: pointer;
  background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.10); color: #B7BECC;
  transition: background .14s ease, color .14s ease; white-space: nowrap;
}
.tbtn:hover { background: rgba(255,255,255,.12); color: #fff; }
.tbtn.primary { background: rgba(96,165,250,.14); border-color: rgba(96,165,250,.32); color: #93C5FD; }
.tbtn.primary:hover { background: rgba(96,165,250,.24); color: #DBEAFE; }
.tbtn[disabled] { opacity: .45; cursor: default; }
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

  /* ================= 启动 ================= */

  init().catch(() => {});

  async function init() {
    S.settings = await RS.storage.getSettings();
    if (!S.settings.enabled || !S.settings.showHud) return;
    if (RS.heuristics.isBlocked(location.href, S.settings)) return;
    if (!RS.heuristics.isReadablePage()) return;

    RS.storage.onSettingsChanged((next) => {
      const wasOn = S.settings && S.settings.showHud;
      S.settings = next;
      if (!next.enabled || !next.showHud) {
        if (wasOn) hide(true);
      } else if (!S.mounted) {
        void boot();
      }
    });

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
        '<span class="plabel">评估中</span>' +
        '<span class="pscore"></span>' +
        '<span class="chev">' + ICON.chev + "</span>" +
      "</div>" +
      '<div class="card" style="display:none"></div>';

    shadow.append(style, wrap);
    (document.body || document.documentElement).appendChild(host);

    S.wrap = wrap;
    S.pill = wrap.querySelector(".pill");
    S.card = wrap.querySelector(".card");

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

  /* ---------- 渲染 ---------- */

  function render() {
    if (!S.mounted || !S.wrap) return;
    const r = S.result;
    if (!r) return;

    const v = RS.VERDICT[r.verdict] || RS.VERDICT.unknown;
    const accent = r.source === "heuristic" ? "#60A5FA" : v.color;
    const accent2 = r.source === "heuristic" ? "#818CF8" : shift(accent, 22);
    S.wrap.style.setProperty("--accent", accent);
    S.wrap.style.setProperty("--accent2", accent2);
    S.wrap.style.setProperty("--glow", v.glow);
    S.wrap.classList.toggle("pending", r.verdict === "pending");

    // 角标
    const score = composite(r);
    S.pill.querySelector(".dot").style.background = accent;
    S.pill.querySelector(".plabel").textContent = r.source === "heuristic" ? "估算中" : v.short;
    S.pill.querySelector(".plabel").style.color = accent;
    S.pill.querySelector(".pscore").textContent = score == null ? "" : score + "%";

    // 卡片
    const pct = score == null ? "–" : String(score);
    const srcTag = srcLabel(r);

    S.card.innerHTML =
      '<div class="head">' +
        '<div class="ring">' + ringSvg(score, accent, accent2) +
          '<div class="num" style="color:' + accent + '">' + pct + '<small>%</small></div>' +
        "</div>" +
        '<div class="headtext">' +
          '<div class="verdict">' +
            (r.source === "heuristic" ? "评估中…" : v.label) +
            '<span class="src">' + srcTag + "</span>" +
          "</div>" +
          '<div class="reason">' + esc(r.reason || "") + "</div>" +
        "</div>" +
        '<button class="iconbtn" data-act="collapse" title="收起">' + ICON.collapse + "</button>" +
      "</div>" +
      warnHTML(r) +
      '<div class="metrics">' +
        metric("相关度", r.relevance, r.source === "heuristic") +
        metric("新信息程度", r.novelty, r.source === "heuristic") +
        metric("可信度", r.credibility, r.source === "heuristic") +
        metric("时效性", r.timelessness, r.source === "heuristic") +
      "</div>" +
      chipsHTML(r) +
      '<div class="foot">' +
        '<div class="footmeta">' + footMeta(r) + "</div>" +
        '<div class="footactions">' +
          '<button class="tbtn primary" data-act="refresh">重新评估</button>' +
          '<button class="tbtn" data-act="options">设置</button>' +
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
        } else if (act === "options") {
          chrome.runtime.sendMessage({ type: RS.MSG.OPEN_OPTIONS });
        } else if (act === "close") {
          hide(true);
        }
      });
    });

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
      const tone = key === "high" ? "hi" : key === "medium" ? "mid" : "lo";
      out.push('<span class="chip ' + tone + '">阅读价值 <b>' + esc(RS.VALUE_LABEL[key] || "–") + "</b></span>");
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
    if (r.source === "heuristic") return "本地估算";
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

  function ringSvg(score, c1, c2) {
    const r = 23;
    const circ = 2 * Math.PI * r;
    const pct = score == null ? 0 : Math.max(0, Math.min(100, score));
    const dash = (pct / 100) * circ;
    const gid = "rsg" + Math.random().toString(36).slice(2, 7);
    return (
      '<svg width="52" height="52" viewBox="0 0 52 52">' +
        "<defs><linearGradient id='" + gid + "' x1='0' y1='0' x2='1' y2='1'>" +
          "<stop offset='0' stop-color='" + c1 + "'/><stop offset='1' stop-color='" + c2 + "'/>" +
        "</linearGradient></defs>" +
        "<circle cx='26' cy='26' r='" + r + "' fill='none' stroke='rgba(255,255,255,.09)' stroke-width='4.5'/>" +
        "<circle cx='26' cy='26' r='" + r + "' fill='none' stroke='url(#" + gid + ")' stroke-width='4.5' " +
          "stroke-linecap='round' stroke-dasharray='" + dash.toFixed(2) + " " + circ.toFixed(2) + "' " +
          "style='transition:stroke-dasharray .6s cubic-bezier(.2,.8,.25,1)'/>" +
      "</svg>"
    );
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
          if (!S.card.matches(":hover")) expand(false);
        }, ms);
      }
    }
    applyPosition();
  }

  /* ================= 位置 / 拖动 ================= */

  async function applyPosition() {
    if (!S.wrap) return;
    const saved = (await RS.storage.rawGet(POS_KEY)) || null;
    const cardW = 348;
    const w = S.expanded ? cardW : 150;
    const h = S.expanded ? 300 : 40;
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
      let moved = false;

      const onMove = (ev) => {
        const dx = ev.clientX - startX;
        const dy = ev.clientY - startY;
        if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
        moved = true;
        S.wrap.classList.add("dragging");
        const w = S.expanded ? 348 : 150;
        const h = S.expanded ? 300 : 40;
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
    if (RS.heuristics.isBlocked(location.href, S.settings)) {
      hide(true);
      return;
    }
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
        render();
        expand(true);
        evaluate(true);
      });
    }, 700);
  }

  function onKey(e) {
    if (e.altKey && e.shiftKey && (e.key === "R" || e.key === "r")) {
      e.preventDefault();
      toggle();
    }
    if (e.key === "Escape" && S.expanded) expand(false);
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

  function shift(hex, amt) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    if (!m) return hex;
    const c = [1, 2, 3].map((i) => Math.max(0, Math.min(255, parseInt(m[i], 16) + amt)));
    return "#" + c.map((x) => x.toString(16).padStart(2, "0")).join("");
  }
})(globalThis.RS);
