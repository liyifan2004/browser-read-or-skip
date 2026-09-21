/* Read or Skip —— 弹窗逻辑 */
(function (RS) {
  const $ = (id) => document.getElementById(id);
  let tabId = null;
  let state = null;

  init().catch(() => {});

  async function init() {
    const settings = await RS.storage.getSettings();
    $("tg-hud").checked = settings.showHud !== false;
    $("tg-serp").checked = settings.annotateSerp !== false;

    bindToggles(settings);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab && tab.id;

    if (!tabId) {
      showUnsupported("无法获取当前标签页。");
      return;
    }

    let res = null;
    try {
      res = await chrome.tabs.sendMessage(tabId, { type: "RS_GET_HUD_STATE" });
    } catch (e) {
      res = null;
    }

    if (!res || !res.ok) {
      showUnsupported(
        tab && tab.url && /^(chrome|edge|about|chrome-extension|devtools):/i.test(tab.url)
          ? "浏览器内部页面不允许扩展注入脚本。"
          : "此页面可能仍在加载，或扩展刚安装还未生效。刷新页面后重试。"
      );
    } else if (res.skipped === "serp") {
      showUnsupported("这是搜索结果页。等级与可信度已经直接标在每条结果上，不再弹浮层。");
    } else if (res.skipped === "off") {
      showUnsupported("浮层已在设置里关闭。打开上方「页面浮层」开关即可恢复。");
    } else if (res.skipped === "blocked") {
      showUnsupported("这个站点在「跳过评估」名单里。可以在设置里删掉对应规则。");
    } else if (res.skipped === "not-readable") {
      showUnsupported("这不是一个可读的正文页（可能是应用页、登录页或非 HTML 内容）。");
    } else if (!res.result) {
      showUnsupported("页面已就绪，但还没有产生判定结果。点下方「重新评估」试试。");
    } else {
      renderResult(res.result, res.page);
    }

    renderStats();
  }

  function bindToggles(settings) {
    $("tg-hud").addEventListener("change", (e) => RS.storage.saveSettings({ showHud: e.target.checked }));
    $("tg-serp").addEventListener("change", (e) => RS.storage.saveSettings({ annotateSerp: e.target.checked }));

    $("gear").addEventListener("click", openOptions);
    $("openOptions").addEventListener("click", openOptions);
    $("reeval").addEventListener("click", async () => {
      const btn = $("reeval");
      btn.disabled = true;
      btn.textContent = "评估中…";
      try {
        await chrome.tabs.sendMessage(tabId, { type: "RS_FORCE_REFRESH" });
      } catch (e) {}
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = "重新评估";
        window.close();
      }, 900);
    });
  }

  function openOptions() {
    chrome.runtime.openOptionsPage();
    window.close();
  }

  function showUnsupported(msg) {
    $("loading").hidden = true;
    $("card").hidden = true;
    $("unsupported").hidden = false;
    $("udesc").textContent = msg;
  }

  function renderResult(r, page) {
    $("loading").hidden = true;
    $("card").hidden = false;

    const v = RS.VERDICT[r.verdict] || RS.VERDICT.unknown;
    const score = composite(r);
    const accent = r.source === "heuristic" ? "#60a5fa" : v.color;

    $("verdictwrap").hidden = false;
    $("ring").innerHTML = ring(score, accent) +
      '<div class="num" style="color:' + accent + '">' + (score == null ? "–" : score) + "<small>%</small></div>";
    $("vlabel").textContent = v.label + (r.source === "heuristic" ? "（本地估算）" : "");
    $("vlabel").style.color = accent;
    $("vreason").textContent = r.reason || "";

    const rows = [
      ["相关度", r.relevance],
      ["新信息程度", r.novelty],
      ["可信度", r.credibility],
      ["时效性", r.timelessness]
    ].filter((x) => typeof x[1] === "number");

    if (rows.length) {
      $("metrics").hidden = false;
      $("metrics").innerHTML = rows
        .map(
          ([label, val]) =>
            '<div class="metric"><span class="mlabel">' + label + "</span>" +
            '<span class="track"><span class="fill" style="width:' + Math.max(2, val) + "%;background:" + accent + '"></span></span>' +
            '<span class="mval">' + val + "%</span></div>"
        )
        .join("");
    }

    const chips = [];
    if (r.warning === "redundant") chips.push(['<span class="chip warn">⚠️ 可能没有太多新信息</span>', true]);
    if (r.valueKey || r.value) {
      const k = r.valueKey || r.value;
      const tone = k === "high" ? "hi" : k === "medium" ? "mid" : "lo";
      chips.push(['<span class="chip ' + tone + '">阅读价值 <b>' + (RS.VALUE_LABEL[k] || "–") + "</b></span>", true]);
    }
    if (r.contentType) chips.push(['<span class="chip">' + (RS.CONTENT_TYPE_LABEL[r.contentType] || r.contentType) + "</span>", true]);
    if (r.readingMinutes) chips.push(['<span class="chip">约 <b>' + r.readingMinutes + "</b> 分钟</span>", true]);
    if (r.lowConfidence) chips.push(['<span class="chip warn">置信度偏低 ' + Math.round(r.confidence * 100) + "%</span>", true]);
    if (chips.length) {
      $("chips").hidden = false;
      $("chips").innerHTML = chips.map((c) => c[0]).join("");
    }

    const meta = [];
    const src = RS.SOURCE_LABEL[r.source] || r.source;
    if (src) meta.push(src);
    if (r.model) meta.push(String(r.model).replace(/^jev-/, "jev "));
    if (r.elapsedMs) meta.push("耗时 " + r.elapsedMs + "ms");
    if (page && page.charCount) meta.push(page.charCount.toLocaleString("zh-CN") + " 字");
    if (page && page.domain) meta.push(page.domain);
    $("metaline").hidden = false;
    $("metaline").innerHTML = meta.map(esc).join('<span class="sep">·</span>');
  }

  async function renderStats() {
    const s = await RS.storage.getStats();
    const cache = await RS.storage.cacheStats();
    $("stats").innerHTML =
      "<span>已评估 <b>" + (s.pages || 0) + "</b> 页 · 建议跳过 <b>" +
      ((s.verdicts && s.verdicts.skip) || 0) + "</b> 页</span>" +
      "<span>缓存 <b>" + cache.count + "</b> 条</span>";
  }

  function composite(r) {
    if (typeof r.relevance === "number" && typeof r.novelty !== "number") {
      return Math.round(r.relevance * 0.65 + (r.credibility || 50) * 0.35);
    }
    const parts = [];
    if (typeof r.relevance === "number") parts.push([r.relevance, 0.45]);
    if (typeof r.novelty === "number") parts.push([r.novelty, 0.3]);
    if (typeof r.credibility === "number") parts.push([r.credibility, 0.25]);
    if (!parts.length) return null;
    const total = parts.reduce((a, p) => a + p[1], 0);
    return Math.round(parts.reduce((a, p) => a + p[0] * p[1], 0) / total);
  }

  function ring(score, color) {
    const r = 25;
    const circ = 2 * Math.PI * r;
    const pct = score == null ? 0 : Math.max(0, Math.min(100, score));
    const dash = (pct / 100) * circ;
    return (
      '<svg width="56" height="56" viewBox="0 0 56 56">' +
      "<circle cx='28' cy='28' r='" + r + "' fill='none' stroke='rgba(255,255,255,.09)' stroke-width='4.5'/>" +
      "<circle cx='28' cy='28' r='" + r + "' fill='none' stroke='" + color + "' stroke-width='4.5' stroke-linecap='round' " +
      "stroke-dasharray='" + dash.toFixed(2) + " " + circ.toFixed(2) + "'/>" +
      "</svg>"
    );
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }
})(globalThis.RS);
