/**
 * Read or Skip —— 本地启发式打分。
 *
 * 作用：在模型返回之前（通常 0~80ms 内）先基于 URL / DOM 结构 / 关键词重合度
 * 给出一个"粗判"，让界面立刻有东西可看。模型结果到达后覆盖它。
 * 界面必须明确标注这是"本地估算"，不能冒充模型结论。
 */
(function (RS) {
  /* ---------------- 域名可信度 ---------------- */

  function domainOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch (e) {
      return "";
    }
  }

  function trustOfDomain(domain) {
    const d = String(domain || "").toLowerCase();
    if (!d) return 50;
    for (const h of RS.TRUST_HIGH) if (d === h || d.endsWith("." + h) || d.includes(h)) return 88;
    for (const h of RS.TRUST_LOW) if (d.includes(h)) return 34;
    // 教育 / 政府域名
    if (/\.(edu|ac\.[a-z]{2}|gov)(\.[a-z]{2})?$/.test(d)) return 85;
    // 常见组织 / 博客平台
    if (/^(blog|news|dev|docs|engineering|research)\./.test(d)) return 66;
    return 55;
  }

  /* ---------------- 页面类型判断 ---------------- */

  const NON_ARTICLE_PATTERNS = [
    /\/login\b/i, /\/signin\b/i, /\/signup\b/i, /\/register\b/i, /\/password\b/i,
    /\/account\b/i, /\/settings\b/i, /\/admin\b/i, /\/cart\b/i, /\/checkout\b/i,
    /\/tag\//i, /\/tags\//i, /\/category\//i, /\/categories\//i, /\/archive\b/i,
    /\/author\//i, /\/page\/\d+/i, /\/search\b/i, /\/feed\b/i, /\/rss\b/i
  ];

  const NON_ARTICLE_TITLE = [
    "登录", "注册", "登录页", "404", "页面不存在", "首页", "全部商品", "购物车",
    "Sign in", "Log in", "Sign up", "404 Not Found", "Access Denied"
  ];

  function urlLooksLikeHomepage(url) {
    try {
      const u = new URL(url);
      const p = u.pathname.replace(/\/+$/, "");
      return p === "" || p === "/index.html" || p === "/index.php";
    } catch (e) {
      return false;
    }
  }

  function pathSignals(url) {
    const out = { doc: false, blog: false, video: false, pdf: false, nonArticle: false };
    let path = url;
    try {
      path = new URL(url).pathname;
    } catch (e) {}
    out.pdf = /\.pdf$/i.test(path);
    out.doc = /\/(docs?|documentation|api|reference|manual|guide|handbook|wiki)\b/i.test(path);
    out.blog = /\/(blog|posts?|articles?|p|notes?|\d{4}\/\d{2})\b/i.test(path);
    out.video = /(youtube\.com\/watch|youtu\.be\/|bilibili\.com\/video|vimeo\.com\/\d)/i.test(url);
    out.nonArticle = NON_ARTICLE_PATTERNS.some((re) => re.test(path));
    return out;
  }

  /* ---------------- 主题关键词重合 ---------------- */

  function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /** 把「AI / 大模型」这类主题拆成可比的词；连字符保留（gpt-4 是一个词） */
  function termsOf(topic) {
    const parts = String(topic || "")
      .toLowerCase()
      .split(/[\/\s,、|·—]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    const keep = parts.filter((p) => p.length >= 2);
    if (keep.length) return keep;
    return parts.length ? parts : [];
  }

  /**
   * 纯 ASCII 词要卡词边界：否则 "ai" 会命中 "email"、"maintain"。
   * 中文没有词边界，直接子串匹配。
   * @param {string} term
   * @param {boolean} global 需要计数时用 true；需要 .test() 时用 false（避免 lastIndex 状态残留）
   */
  function termRegex(term, global = true) {
    const esc = escapeRe(term);
    const asciiWord = /^[a-z0-9][a-z0-9\-_.+#]*$/i.test(term);
    const flags = global ? "gi" : "i";
    return asciiWord ? new RegExp("(?<![a-z0-9])" + esc + "(?![a-z0-9])", flags) : new RegExp(esc, flags);
  }

  function countTerm(haystack, term) {
    const m = haystack.match(termRegex(term, true));
    return m ? m.length : 0;
  }

  function hasTerm(haystack, term) {
    return termRegex(term, false).test(haystack);
  }

  /**
   * 主题关键词重合度 → 0~1。
   *
   * 关键设计：看「最匹配的那个主题」而不是所有主题的平均。
   * 用户通常挂着 3~10 个主题，一篇文章只可能命中其中一两个；
   * 用平均值会让一篇正中靶心的文章只得 35 分，反而被判成"快速扫"。
   * 命中主题数作为小幅加权（breadth），保证"多个主题都沾边"能略高一点。
   */
  function topicOverlap(title, text, topics) {
    if (!topics || !topics.length) return null;
    const titleHay = String(title || "").toLowerCase();
    const bodyHay = String(text || "").toLowerCase();
    if (!titleHay.trim() && !bodyHay.trim()) return null;
    const hay = titleHay + "\n" + bodyHay;

    let best = 0;
    let matched = 0;
    let usedTopics = 0;

    for (const raw of topics) {
      const terms = termsOf(raw);
      if (!terms.length) continue;
      usedTopics++;

      let hits = 0;
      let titleHits = 0;
      for (const term of terms) {
        hits += Math.min(countTerm(hay, term), 4);
        if (hasTerm(titleHay, term)) titleHits++;
      }

      const coverage = Math.min(1, hits / (terms.length * 3));
      const titleBonus = titleHits / terms.length;
      if (coverage > 0.2) matched++;

      const score = coverage * 0.85 + titleBonus * 0.15;
      if (score > best) best = score;
    }

    if (!usedTopics) return null;
    // 命中越多个主题，越不容易被"只是撞上其中一个"误导，做小幅加权
    const breadth = matched / usedTopics;
    return clamp(best * (0.88 + 0.12 * breadth), 0, 1);
  }

  /* ---------------- 阅读时长 ---------------- */

  function cjkRatio(text) {
    const s = (text || "").slice(0, 4000);
    if (!s) return 0;
    const cjk = (s.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/g) || []).length;
    return cjk / s.length;
  }

  function readingMinutes(charCount, ratio) {
    const speed = ratio > 0.25 ? 480 : 1100; // 汉字 480 字/分，英文约 220 词/分
    return Math.max(1, Math.round(charCount / speed));
  }

  /* ---------------- 主打分函数 ---------------- */

  function isBlocked(url, settings) {
    if (!url) return true;
    const list = (settings && settings.siteBlocklist) || [];
    const lower = String(url).toLowerCase();
    return list.some((p) => p && lower.includes(String(p).toLowerCase()));
  }

  /** 取元素可见文本长度。不用 innerText 单腿走路：部分文档类型 / 测试环境里它不存在。 */
  function textLength(el) {
    if (!el) return 0;
    const t = el.innerText != null ? el.innerText : el.textContent;
    return (t || "").length;
  }

  function isReadablePage() {
    try {
      if (!/^https?:$/.test(location.protocol)) return false;
    } catch (e) {
      return false;
    }
    if (document.contentType && !/text\/html|application\/xhtml/i.test(document.contentType)) {
      return false;
    }
    // 大量表单 + 密码框 → 应用页，不是文章
    const pw = document.querySelectorAll('input[type="password"]').length;
    if (pw > 0 && textLength(document.body) < 1200) return false;
    return true;
  }

  /**
   * 是否是搜索引擎结果页。
   * 必须与 manifest.content_scripts[1].matches 保持一致 —— 那边负责注入标注脚本，
   * 这边负责让浮层让位。两边不一致就会出现"既不标注也不弹浮层"的空窗。
   */
  const SEARCH_ENGINE_PATTERNS = [
    { host: /(^|\.)www\.google\.(com|com\.hk|com\.tw)$/, path: /^\/search/ },
    { host: /(^|\.)www\.bing\.com$/, path: /^\/search/ },
    { host: /(^|\.)cn\.bing\.com$/, path: /^\/search/ },
    { host: /(^|\.)www\.baidu\.com$/, path: /^\/(s|from)/ },
    { host: /(^|\.)www\.sogou\.com$/, path: /^\/web/ },
    { host: /(^|\.)duckduckgo\.com$/, path: /^\// },
    { host: /(^|\.)search\.brave\.com$/, path: /^\/search/ }
  ];

  function isSearchResultsPage(url) {
    if (!url) return false;
    try {
      const u = new URL(url);
      const host = u.hostname.toLowerCase();
      const path = u.pathname;
      return SEARCH_ENGINE_PATTERNS.some((p) => p.host.test(host) && p.path.test(path));
    } catch (e) {
      return false;
    }
  }

  /**
   * @param {object} page RS.extract.page() 的产物
   * @param {object} settings
   * @returns {object} 与 RS.questions.normalizePage 同构的结果对象
   */
  function scorePage(page, settings) {
    const url = (page && page.url) || location.href;
    const title = (page && page.title) || document.title || "";
    const text = (page && page.text) || "";
    const domain = (page && page.domain) || domainOf(url);
    const charCount = (page && page.charCount) || text.length;
    const linkDensity = (page && page.linkDensity) || 0;
    const codeBlocks = (page && page.codeBlocks) || 0;
    const ratio = cjkRatio(text);

    const signals = pathSignals(url);
    const reasons = [];
    let verdict = "skim";
    let relevance = 50;
    let novelty = 50;
    let credibility = trustOfDomain(domain);
    let value = "medium";
    let contentType = "other";
    let timelessness = 50;

    const overlap = topicOverlap(title, text, settings && settings.topics);
    if (overlap != null) relevance = Math.round(overlap * 100);

    /* --- 硬性排除 --- */
    if (NON_ARTICLE_TITLE.some((t) => title.includes(t))) {
      return hardSkip("可以跳过：这是一个导航 / 登录 / 错误页，没有正文可读。", {
        contentType: "other"
      });
    }
    if (signals.nonArticle) {
      return hardSkip("可以跳过：列表页 / 归档页 / 功能页，不是可读正文。", { contentType: "other" });
    }
    if (urlLooksLikeHomepage(url) && charCount < 1500) {
      return hardSkip("可以跳过：站点首页，信息分散，缺少完整论述。", { contentType: "other" });
    }

    /* --- 内容形态 --- */
    if (signals.doc) {
      contentType = "reference";
      credibility = Math.max(credibility, 78);
      timelessness = Math.max(timelessness, 72);
      novelty = Math.max(novelty, 45);
    } else if (signals.video) {
      contentType = "other";
      verdict = "skim";
      novelty = 40;
    } else if (signals.pdf) {
      contentType = "analysis";
      credibility = Math.max(credibility, 70);
    } else if (signals.blog) {
      contentType = "tutorial";
    }

    /* --- 文本结构 --- */
    if (charCount < (settings && settings.minTextLength ? settings.minTextLength : 400)) {
      if (charCount < 200) {
        return hardSkip("可以跳过：正文过短（约 " + charCount + " 字），不构成可读内容。", { contentType });
      }
      verdict = "skim";
      novelty -= 10;
    }
    if (linkDensity > 0.45) {
      verdict = "skip";
      reasons.push("链接密度过高（" + Math.round(linkDensity * 100) + "%）");
      novelty -= 20;
    }
    if (charCount > 3000) novelty += 8;
    if (charCount > 8000) novelty += 6;
    if (codeBlocks > 0) {
      novelty += 8;
      timelessness += 6;
      if (contentType === "other") contentType = "tutorial";
    }
    if ((page && page.paragraphCount || 0) >= 12) novelty += 4;

    /* --- 域名 / 路径 --- */
    // 名单里既有纯域名，也有 "medium.com/@"、"sohu.com/a/" 这种路径前缀，
    // 所以匹配范围是「主机名 + 路径」，不含协议与查询串（避免 ?ref=apple.com 这类误命中）。
    let scope = domain.toLowerCase();
    try {
      const u = new URL(url);
      scope = (u.hostname.replace(/^www\./, "") + u.pathname).toLowerCase();
    } catch (e) {
      /* url 非法时退化成只用域名匹配 */
    }
    if (RS.TRUST_LOW.some((h) => scope.includes(h))) {
      novelty -= 25;
      credibility = Math.min(credibility, 34);
      value = "low";
    }
    if (RS.TRUST_HIGH.some((h) => scope.includes(h))) {
      credibility = Math.max(credibility, 86);
    }

    novelty = clamp(novelty, 0, 100);
    credibility = clamp(credibility, 0, 100);
    timelessness = clamp(timelessness, 0, 100);
    relevance = clamp(relevance, 0, 100);

    /* --- 综合判定 --- */
    const score = relevance * 0.45 + novelty * 0.3 + credibility * 0.25;
    if (score >= 66 && relevance >= 55) verdict = "read";
    else if (score >= 44) verdict = "skim";
    else verdict = "skip";

    if (verdict === "read") value = novelty >= 60 && credibility >= 60 ? "high" : "medium";
    else if (verdict === "skim") value = "medium";
    else value = "low";

    return {
      kind: "page",
      verdict,
      relevance,
      novelty,
      credibility,
      timelessness,
      value,
      valueKey: value,
      contentType,
      contentTypeKey: contentType,
      redundancy: null,
      confidence: null,
      lowConfidence: false,
      warning: null,
      source: "heuristic",
      model: null,
      usage: null,
      reason: "本地快速估算（模型结果加载中）：相关度约 " + relevance + "%，可信度约 " + credibility + "%" +
        (reasons.length ? "；" + reasons.join("；") : "") + "。",
      approximate: true,
      readingMinutes: readingMinutes(charCount, ratio),
      at: Date.now()
    };
  }

  function hardSkip(reason, extra) {
    const out = Object.assign(
      {
        kind: "page",
        verdict: "skip",
        relevance: 5,
        novelty: 5,
        credibility: 50,
        timelessness: 50,
        value: "low",
        valueKey: "low",
        contentType: "other",
        contentTypeKey: "other",
        redundancy: null,
        confidence: null,
        lowConfidence: false,
        warning: null,
        source: "heuristic",
        model: null,
        usage: null,
        reason,
        approximate: true,
        readingMinutes: 1,
        at: Date.now()
      },
      extra || {}
    );
    // 调用方常只覆盖 contentType，这里保证 *Key 跟着走，避免两套字段不同步
    out.valueKey = out.value;
    out.contentTypeKey = out.contentType;
    return out;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function formatBytes(n) {
    if (!n) return "0 B";
    const u = ["B", "KB", "MB"];
    let i = 0;
    let x = n;
    while (x >= 1024 && i < u.length - 1) {
      x /= 1024;
      i++;
    }
    return (i === 0 ? x : x.toFixed(1)) + " " + u[i];
  }

  RS.heuristics = {
    isBlocked,
    isReadablePage,
    isSearchResultsPage,
    scorePage,
    domainOf,
    trustOfDomain,
    cjkRatio,
    readingMinutes,
    topicOverlap,
    pathSignals,
    clamp,
    formatBytes
  };
})(globalThis.RS);
