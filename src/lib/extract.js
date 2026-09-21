/**
 * Read or Skip —— 正文抽取。
 * 目标：在 DOMContentLoaded 后极短时间内拿到"够用"的正文，
 * 不追求 Readability 级别的完美，追求稳定 + 快 + 不污染页面。
 */
(function (RS) {
  const STRIP_TAGS = ["script", "style", "noscript", "template", "svg", "canvas", "iframe", "form", "nav", "header", "footer", "aside", "dialog"];
  const CANDIDATE_SELECTORS = [
    "article",
    "[role='main']",
    "main",
    ".markdown-body",
    ".post-content",
    ".article-content",
    ".entry-content",
    ".rich_media_content",      // 微信公众号
    "#js_content",              // 微信公众号
    ".article__content",
    ".post-body",
    "#content",
    ".content",
    "body"
  ];

  function meta(name) {
    const el =
      document.querySelector('meta[name="' + name + '"]') ||
      document.querySelector('meta[property="' + name + '"]');
    return el ? (el.getAttribute("content") || "").trim() : "";
  }

  function cleanText(node) {
    if (!node) return "";
    const clone = node.cloneNode(true);
    STRIP_TAGS.forEach((t) => {
      clone.querySelectorAll(t).forEach((n) => n.remove());
    });
    let text = clone.innerText || clone.textContent || "";
    text = text
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return text;
  }

  function linkDensity(node) {
    if (!node) return 0;
    const total = (node.innerText || node.textContent || "").length || 1;
    let linkLen = 0;
    node.querySelectorAll("a").forEach((a) => {
      linkLen += (a.innerText || a.textContent || "").length;
    });
    return Math.min(1, linkLen / total);
  }

  function scoreCandidate(node) {
    if (!node) return -1;
    const text = (node.innerText || node.textContent || "").trim();
    const len = text.length;
    if (len < 120) return -1;
    const ld = linkDensity(node);
    const paragraphs = node.querySelectorAll("p").length;
    const headings = node.querySelectorAll("h1,h2,h3").length;
    const code = node.querySelectorAll("pre,code").length;
    return len * (1 - ld * 1.2) + paragraphs * 40 + headings * 25 + Math.min(code, 60) * 8;
  }

  function pickMainNode() {
    let best = null;
    let bestScore = -1;
    for (const sel of CANDIDATE_SELECTORS) {
      let nodes;
      try {
        nodes = document.querySelectorAll(sel);
      } catch (e) {
        continue;
      }
      for (const n of nodes) {
        const s = scoreCandidate(n);
        if (s > bestScore) {
          bestScore = s;
          best = n;
        }
        // 命中高优先级选择器且得分不低 → 直接采用
        if (s > 0 && sel !== "body" && bestScore > 0 && CANDIDATE_SELECTORS.indexOf(sel) < 6) {
          return n;
        }
      }
    }
    return best || document.body;
  }

  function page() {
    const url = location.href;
    const title =
      (meta("og:title") || meta("twitter:title") || document.title || "").trim();
    const description = meta("description") || meta("og:description") || meta("twitter:description") || "";

    let node = null;
    let text = "";
    try {
      node = pickMainNode();
      text = cleanText(node);
    } catch (e) {
      text = (document.body && document.body.innerText) || "";
    }

    const paragraphs = node ? node.querySelectorAll("p").length : 0;
    const headings = node ? node.querySelectorAll("h1,h2,h3,h4").length : 0;
    const codeBlocks = node ? node.querySelectorAll("pre").length : 0;
    const images = node ? node.querySelectorAll("img").length : 0;

    return {
      url,
      title,
      description,
      domain: RS.heuristics.domainOf(url),
      lang: document.documentElement.getAttribute("lang") || "",
      text,
      charCount: text.length,
      paragraphCount: paragraphs,
      headings,
      codeBlocks,
      images,
      linkDensity: node ? linkDensity(node) : 0,
      cjkRatio: RS.heuristics.cjkRatio(text),
      hasPasswordField: document.querySelectorAll('input[type="password"]').length > 0,
      capturedAt: Date.now()
    };
  }

  /** 构造发给 Jev 的 state（受隐私模式与长度上限约束） */
  function buildState(pageData, settings) {
    const privacy = (settings && settings.privacyMode) || "full";
    const excerptChars = (settings && settings.excerptChars) || 6000;
    const state = {
      url: pageData.url,
      domain: pageData.domain,
      title: pageData.title,
      metaDescription: pageData.description || undefined,
      focusTopics: (settings && settings.topics) || []
    };
    if (privacy === "titles") {
      state.note = "仅在标题与摘要模式下评估（用户未允许发送正文）。";
      return state;
    }
    state.stats = {
      charCount: pageData.charCount,
      paragraphs: pageData.paragraphCount,
      headings: pageData.headings,
      codeBlocks: pageData.codeBlocks,
      images: pageData.images,
      linkDensity: Math.round(pageData.linkDensity * 100) / 100
    };
    state.content = pageData.text.slice(0, excerptChars);
    if (pageData.text.length > excerptChars) {
      state.truncated = true;
    }
    return state;
  }

  RS.extract = { page, buildState, cleanText, pickMainNode };
})(globalThis.RS);
