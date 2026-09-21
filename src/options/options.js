/* Read or Skip —— 设置页逻辑 */
(function (RS) {
  const $ = (id) => document.getElementById(id);
  const DAY = 24 * 60 * 60 * 1000;

  let settings = null;
  let topics = [];
  let dirty = false;

  init().catch((e) => {
    setHint("加载设置失败：" + (e && e.message ? e.message : e), "error");
  });

  async function init() {
    settings = await RS.storage.getSettings();
    $("ver").textContent = "v" + RS.version + " · Jev " + String(settings.model || "jev-latest").replace(/^jev-/, "");

    $("apiKey").value = settings.apiKey || "";
    $("model").value = settings.model || RS.DEFAULT_MODEL;
    $("showHud").checked = settings.showHud !== false;
    $("enabled").checked = settings.enabled !== false;
    $("annotateSerp").checked = settings.annotateSerp !== false;
    $("privacyMode").value = settings.privacyMode || "full";
    $("autoCollapse").value = settings.hudAutoCollapseMs;
    $("excerptChars").value = settings.excerptChars;
    $("serpMaxResults").value = settings.serpMaxResults;
    $("minTextLength").value = settings.minTextLength;
    $("timeout").value = settings.timeoutMs;
    $("cacheTtl").value = Math.round(settings.cacheTtlMs / DAY);
    $("cacheLimit").value = settings.cacheLimit;
    $("siteBlocklist").value = (settings.siteBlocklist || []).join("\n");

    topics = (settings.topics || []).slice(0, 12);
    renderTopics();

    bind();
    await renderStats();
  }

  function bind() {
    $("toggleKey").addEventListener("click", () => {
      const el = $("apiKey");
      const show = el.type === "password";
      el.type = show ? "text" : "password";
      $("toggleKey").textContent = show ? "隐藏" : "显示";
    });

    $("topicInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "," || e.key === "，") {
        e.preventDefault();
        addTopic($("topicInput").value);
      } else if (e.key === "Backspace" && !$("topicInput").value && topics.length) {
        topics.pop();
        renderTopics();
        markDirty();
      }
    });
    $("topicInput").addEventListener("blur", () => {
      if ($("topicInput").value.trim()) addTopic($("topicInput").value);
    });
    $("topicBox").addEventListener("click", (e) => {
      if (e.target === $("topicBox")) $("topicInput").focus();
    });

    ["apiKey", "model", "privacyMode", "autoCollapse", "excerptChars", "serpMaxResults",
     "minTextLength", "timeout", "cacheTtl", "cacheLimit", "siteBlocklist"].forEach((id) => {
      const el = $(id);
      el.addEventListener("input", markDirty);
      el.addEventListener("change", markDirty);
    });
    ["showHud", "enabled", "annotateSerp"].forEach((id) =>
      $(id).addEventListener("change", markDirty)
    );

    $("save").addEventListener("click", save);
    $("testBtn").addEventListener("click", testConnection);
    $("clearCache").addEventListener("click", async () => {
      await RS.storage.clearCache();
      await renderStats();
      setHint("缓存已清空。", "saved");
    });
    $("resetSettings").addEventListener("click", async () => {
      await RS.storage.saveSettings(RS.DEFAULT_SETTINGS);
      await init();
      markDirty();
      setHint("已恢复默认设置，记得保存。", "saved");
    });

    window.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        save();
      }
    });

    document.querySelectorAll("#apiKey,#model,#privacyMode").forEach((el) =>
      el.addEventListener("change", () => {
        $("testResult").hidden = true;
      })
    );
  }

  /* ---------- 主题标签 ---------- */

  function addTopic(raw) {
    const t = String(raw || "").trim().replace(/[,，]$/, "");
    if (!t) return;
    if (topics.length >= 12) {
      setHint("主题最多 12 个，先删掉一个再添加。", "error");
      return;
    }
    if (topics.some((x) => x.toLowerCase() === t.toLowerCase())) {
      $("topicInput").value = "";
      return;
    }
    topics.push(t);
    $("topicInput").value = "";
    renderTopics();
    markDirty();
  }

  function renderTopics() {
    $("topicTags").innerHTML = topics
      .map(
        (t, i) =>
          '<span class="tag">' + esc(t) + '<button type="button" data-i="' + i + '" title="移除">×</button></span>'
      )
      .join("");
    $("topicTags").querySelectorAll("button[data-i]").forEach((b) =>
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        topics.splice(Number(b.dataset.i), 1);
        renderTopics();
        markDirty();
      })
    );
  }

  /* ---------- 保存 ---------- */

  function collect() {
    const patch = {
      apiKey: $("apiKey").value.trim(),
      model: $("model").value.trim() || RS.DEFAULT_MODEL,
      showHud: $("showHud").checked,
      enabled: $("enabled").checked,
      annotateSerp: $("annotateSerp").checked,
      privacyMode: $("privacyMode").value,
      hudAutoCollapseMs: num("autoCollapse", 0, 60000, 9000),
      excerptChars: num("excerptChars", 500, 30000, 6000),
      serpMaxResults: num("serpMaxResults", 1, 20, 8),
      minTextLength: num("minTextLength", 100, 5000, 400),
      timeoutMs: num("timeout", 1000, 30000, 8000),
      cacheTtlMs: num("cacheTtl", 1, 90, 7) * DAY,
      cacheLimit: num("cacheLimit", 50, 2000, 300),
      topics,
      siteBlocklist: $("siteBlocklist")
        .value.split("\n")
        .map((s) => s.trim())
        .filter(Boolean)
    };
    return patch;
  }

  function num(id, lo, hi, fallback) {
    const v = Number($(id).value);
    if (!isFinite(v)) return fallback;
    return Math.max(lo, Math.min(hi, v));
  }

  async function save() {
    const btn = $("save");
    btn.disabled = true;
    btn.textContent = "保存中…";
    try {
      settings = await RS.storage.saveSettings(collect());
      dirty = false;
      setHint("已保存并应用。", "saved");
      // 回写被夹紧过的数值
      $("autoCollapse").value = settings.hudAutoCollapseMs;
      $("excerptChars").value = settings.excerptChars;
      $("cacheTtl").value = Math.round(settings.cacheTtlMs / DAY);
    } catch (e) {
      setHint("保存失败：" + (e && e.message ? e.message : e), "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "保存并应用";
    }
  }

  function markDirty() {
    dirty = true;
    setHint("有未保存的修改 · Ctrl/Cmd + S 快速保存");
  }

  function setHint(text, cls) {
    const el = $("saveHint");
    el.textContent = text;
    el.className = "savehint" + (cls ? " " + cls : "");
  }

  /* ---------- 测试连接 ---------- */

  async function testConnection() {
    const btn = $("testBtn");
    const box = $("testResult");
    const key = $("apiKey").value.trim();
    const model = $("model").value.trim() || RS.DEFAULT_MODEL;

    btn.disabled = true;
    btn.textContent = "测试中…";
    box.hidden = false;
    box.className = "testresult";
    box.textContent = "正在向 api.typesafe.ai 发送一次最小请求…";

    if (!key) {
      box.className = "testresult bad";
      box.textContent = "请先填写 API Key。";
      btn.disabled = false;
      btn.textContent = "测试连接";
      return;
    }

    const t0 = performance.now();
    try {
      const resp = await RS.jev.systemOne({
        apiKey: key,
        model,
        timeoutMs: 15000,
        maxRetries: 0,
        state: "Read or Skip 正在测试与 TypeSafe Jev 的连接。",
        questions: {
          alive: { type: "noul", instructions: "Is this message a connection test?" }
        }
      });
      const ms = Math.round(performance.now() - t0);
      const u = resp.usage || {};
      box.className = "testresult ok";
      box.innerHTML =
        "✅ 连接成功 · 模型返回 <b>" + esc(resp.model) + "</b> · 往返 " + ms + "ms" +
        "<small>输入 " + (u.input_tokens || 0) + " tokens / 输出 " + (u.output_tokens || 0) +
        " tokens（输出免费）。这个延迟就是浮层判定的典型耗时量级。</small>";
      setHint("连接正常，记得点保存。", "saved");
    } catch (e) {
      box.className = "testresult bad";
      box.innerHTML =
        "❌ " + esc(e && e.message ? e.message : String(e)) +
        "<small>常见原因：Key 复制时带了空格、账号还没有拿到 Jev 早期访问权限、或网络无法访问 api.typesafe.ai。</small>";
      setHint("连接失败。", "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "测试连接";
    }
  }

  /* ---------- 统计 ---------- */

  async function renderStats() {
    const s = await RS.storage.getStats();
    const c = await RS.storage.cacheStats();
    const v = s.verdicts || {};
    const tokens = (s.inputTokens || 0) + (s.outputTokens || 0);
    // 输入价 $0.042 / 1M tokens，按 7.1 汇率折算人民币
    const cost = ((s.inputTokens || 0) / 1e6) * 0.042 * 7.1;

    const items = [
      ["累计评估页数", s.pages || 0],
      ["模型调用次数", s.calls || 0],
      ["建议跳过", v.skip || 0],
      ["累计消耗 token", tokens.toLocaleString("zh-CN")],
      ["估算花费", "¥" + cost.toFixed(4)],
      ["缓存条目", c.count + " / " + (settings ? settings.cacheLimit : "-")],
      ["缓存体积", RS.heuristics ? RS.heuristics.formatBytes(c.bytes) : c.bytes + " B"],
      ["判定分布", "读 " + (v.read || 0) + " · 扫 " + (v.skim || 0) + " · 跳 " + (v.skip || 0)]
    ];

    $("statgrid").innerHTML = items
      .map(([k, val]) => '<div class="stat"><div class="k">' + esc(k) + '</div><div class="v">' + esc(String(val)) + "</div></div>")
      .join("");
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );
  }
})(globalThis.RS);
