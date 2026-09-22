/* Read or Skip —— 弹窗逻辑 */
(function (RS) {
  const $ = (id) => document.getElementById(id);
  let tabId = null;
  let state = null;
  let currentHost = "";

  init().catch(() => {});

  async function init() {
    const settings = await RS.storage.getSettings();
    $("tg-hud").checked = settings.showHud !== false;
    $("tg-serp").checked = settings.annotateSerp !== false;

    bindToggles(settings);

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab && tab.id;

    if (!tabId) {
      showUnsupported("页面还没就绪", "无法获取当前标签页。");
      return;
    }

    // 误点「屏蔽此站」必须有退路：当前站点在黑名单里时给出解除入口
    currentHost = hostnameOf(tab && tab.url);
    renderUnblockRow(settings);
    renderPauseRow(settings, tab && tab.url);

    let res = null;
    try {
      res = await chrome.tabs.sendMessage(tabId, { type: "RS_GET_HUD_STATE" });
    } catch (e) {
      res = null;
    }

    if (!res || !res.ok) {
      // 两句结构：先说状态，再给可执行动作
      const internal =
        tab && tab.url && /^(chrome|edge|about|chrome-extension|devtools):/i.test(tab.url);
      showUnsupported(
        internal ? "浏览器内部页面" : "页面还没就绪",
        internal ? "内部页面不允许扩展注入脚本。" : "刷新后重试。"
      );
    } else if (res.skipped === "serp") {
      showUnsupported("搜索结果页", "等级与可信度已经直接标在每条结果上，不再弹浮层。");
    } else if (res.skipped === "off") {
      showUnsupported("浮层已关闭", "浮层已在设置里关闭。打开上方「页面浮层」开关即可恢复。");
    } else if (res.skipped === "blocked") {
      showUnsupported("站点已跳过评估", "此站点已跳过评估，浮层不再出现。下方「恢复评估 / 解除屏蔽」可随时恢复。");
    } else if (res.skipped === "not-readable") {
      showUnsupported("不是可读页面", "这不是一个可读的正文页（可能是应用页、登录页或非 HTML 内容）。");
    } else if (!res.result) {
      showUnsupported("页面还没就绪", "页面已就绪，但还没有产生判定结果。点下方「重新评估」试试。");
    } else {
      renderResult(res.result, res.page);
    }

    renderStats();
  }

  function bindToggles(settings) {
    $("tg-hud").addEventListener("change", (e) => RS.storage.saveSettings({ showHud: e.target.checked }));
    $("tg-serp").addEventListener("change", (e) => RS.storage.saveSettings({ annotateSerp: e.target.checked }));

    $("gear").addEventListener("click", openOptions);
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

  function showUnsupported(title, desc) {
    $("loading").hidden = true;
    $("card").hidden = true;
    $("unsupported").hidden = false;
    $("utitle").textContent = title;
    $("udesc").textContent = desc;
  }

  function renderResult(r, page) {
    $("loading").hidden = true;
    $("card").hidden = false;

    const v = RS.VERDICT[r.verdict] || RS.VERDICT.unknown;
    const score = composite(r);
    // 判定色只用于结论；数值条统一用 accent 色相
    const verdictColor = r.source === "heuristic" ? "var(--rs-accent)" : v.color;

    $("verdictwrap").hidden = false;
    $("vlabel").textContent = v.label + (r.source === "heuristic" ? "（初判）" : "");
    $("vlabel").style.color = verdictColor;
    $("score").textContent = score == null ? "–" : score + "%";
    $("vreason").textContent = r.reason || "";

    const rows = [
      ["相关度", r.relevance],
      ["新信息", r.novelty],
      ["可信度", r.credibility],
      ["时效性", r.timelessness]
    ].filter((x) => typeof x[1] === "number");

    if (rows.length) {
      $("metrics").hidden = false;
      $("metrics").innerHTML = rows
        .map(
          ([label, val]) =>
            '<div class="metric"><span class="mlabel">' + label + "</span>" +
            '<span class="track"><span class="fill" style="width:' + Math.max(2, val) + '%"></span></span>' +
            '<span class="mval">' + val + "%</span></div>"
        )
        .join("");
    }

    const chips = [];
    if (r.warning === "redundant") chips.push('<span class="chip warn">⚠️ 可能没有太多新信息</span>');
    if (r.valueKey || r.value) {
      const k = r.valueKey || r.value;
      chips.push('<span class="chip">阅读价值 <b>' + (RS.VALUE_LABEL[k] || "–") + "</b></span>");
    }
    if (r.contentType) chips.push('<span class="chip">' + (RS.CONTENT_TYPE_LABEL[r.contentType] || r.contentType) + "</span>");
    if (r.readingMinutes) chips.push('<span class="chip">约 <b>' + r.readingMinutes + "</b> 分钟</span>");
    if (r.lowConfidence) chips.push('<span class="chip warn">置信度偏低 ' + Math.round(r.confidence * 100) + "%</span>");
    if (chips.length) {
      $("chips").hidden = false;
      $("chips").innerHTML = chips.join("");
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

  /** 主机名是否被黑名单条目拦下：与 heuristics.isBlocked 的域名条目规则一致 */
  function hostMatchesBlocklist(host, list) {
    if (!host) return false;
    return (list || []).some((entry) => {
      const e = String(entry || "").toLowerCase();
      if (!e) return false;
      if (!e.includes("/") && e.includes(".") && !e.startsWith(".") && !e.endsWith(".")) {
        return host === e || host.endsWith("." + e);
      }
      return false;
    });
  }

  function hostnameOf(url) {
    try {
      return new URL(url).hostname.toLowerCase();
    } catch (e) {
      return "";
    }
  }

  /** 当前站点已被屏蔽时显示解除入口；点击后从黑名单移除并给出反馈 */
  function renderUnblockRow(settings) {
    if (!currentHost) return;
    if (!hostMatchesBlocklist(currentHost, (settings && settings.siteBlocklist) || [])) return;
    $("unblockHost").textContent = currentHost;
    $("unblockRow").hidden = false;
    $("unblockBtn").addEventListener("click", async () => {
      const cur = ((await RS.storage.getSettings()).siteBlocklist) || [];
      const next = cur.filter((entry) => !hostMatchesBlocklist(currentHost, [entry]));
      await RS.storage.saveSettings({ siteBlocklist: next });
      $("unblockLabel").innerHTML = "已解除屏蔽<small>刷新页面后浮层会重新出现</small>";
      $("unblockBtn").hidden = true;
    });
  }

  /** 当前站点处于分站点暂停期时显示恢复入口；与 heuristics.pauseStateOf 同一套判定 */
  function renderPauseRow(settings, url) {
    const until = RS.heuristics.pauseStateOf(url, settings);
    if (!until || !currentHost) return;
    const d = new Date(until);
    const hhmm =
      String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    // 重写时必须保留 <small id="pauseHost">，否则外部按 id 取主机名会拿到 null
    $("pauseLabel").innerHTML =
      "此站点已暂停至 " + esc(hhmm) + "<small id=\"pauseHost\">" + esc(currentHost) + "</small>";
    $("pauseRow").hidden = false;
    $("pauseBtn").addEventListener("click", async () => {
      const cur = ((await RS.storage.getSettings()).pausedSites) || {};
      delete cur[currentHost];
      await RS.storage.saveSettings({ pausedSites: cur });
      $("pauseLabel").innerHTML = "已恢复评估<small>刷新页面后浮层会重新出现</small>";
      $("pauseBtn").hidden = true;
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }
})(globalThis.RS);
