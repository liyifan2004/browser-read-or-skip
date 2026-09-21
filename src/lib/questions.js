/**
 * Read or Skip —— Jev 问题定义 & 结果归一化。
 *
 * 设计要点：
 * 1. 一次 API 调用并发问完全部问题（Jev 的特性：同一 state 上的多问题并行求值）。
 * 2. 问题用英文 instructions（模型训练语言，判定更稳），criteria 用中文（直接作为 UI 图例展示）。
 * 3. 模型不产出文字，所以"为什么"由本地从各分量拼装，不编造。
 */
(function (RS) {
  const TOPIC_JOIN = (topics) => (topics && topics.length ? topics.join(" / ") : "（未设置，请按一般技术从业者的兴趣判断）");

  /* ================= 网页正文评估 ================= */

  const RELEVANCE_CRITERIA = [
    "完全无关：与关注主题没有交集",
    "几乎无关：只是顺带提及",
    "部分相关：小部分内容落在关注范围内",
    "较为相关：主体内容与关注点明显重叠",
    "高度相关：正是当前关注方向的直接内容"
  ];

  const NOVELTY_CRITERIA = [
    "零新信息：全部是已知常识或简单复述",
    "新信息很少：只有零星细节是新的",
    "中等：大约一半内容是新信息",
    "较新：大部分细节、数据或视角此前未见",
    "全新：带来大量此前未接触的信息或观点"
  ];

  const CREDIBILITY_CRITERIA = [
    "不可信：明显营销稿、标题党、或无任何出处",
    "偏低：来源不明、缺少引用与署名",
    "一般：个人博客或匿名作者，观点可信但未验证",
    "较高：有署名与出处，来自专业媒体或工程团队",
    "高：一手来源，有数据 / 引文 / 可复现细节支撑"
  ];

  const TIMELESSNESS_CRITERIA = [
    "已过时：内容依赖的结论或数据已被推翻",
    "易过时：依赖最新版本号、价格或短期事件",
    "中性：一段时间内仍然有效",
    "较耐用：方法或原理不易随版本变化",
    "长青：底层原理，长期有效"
  ];

  function pageQuestions(settings) {
    const topics = TOPIC_JOIN(settings.topics);
    return {
      verdict: {
        type: "choice",
        instructions:
          "The reader's focus topics: " + topics + ". " +
          "Given the page state, decide what the reader should do with this page right now.",
        criteria: {
          read: "值得认真读：相关、含新信息、可信度高，值得逐段读",
          skim: "快速扫：部分有用，但冗余较多、铺垫过长或深度不足",
          skip: "可以跳过：无关、无新信息、或属于营销 / 导航 / 低质量内容"
        }
      },
      relevance: {
        type: "score",
        instructions:
          "How relevant is the page content to the reader's focus topics (" + topics + ")? " +
          "Judge topical overlap only, ignoring writing quality.",
        criteria: RELEVANCE_CRITERIA
      },
      novelty: {
        type: "score",
        instructions:
          "How much NEW information does this page give to a reader who already follows the focus topics? " +
          "Ignore whether the writing is pleasant; judge only the amount of new substance.",
        criteria: NOVELTY_CRITERIA
      },
      value: {
        type: "choice",
        instructions:
          "Estimated reading value for this reader: what would they actually gain by reading it?",
        criteria: {
          high: "高：读完能改变判断、补齐关键认知，或可直接拿去用",
          medium: "中：有收获，但需要挑着看、跳过大量铺垫",
          low: "低：读完大概率没有实际收益"
        }
      },
      credibility: {
        type: "score",
        instructions:
          "How trustworthy is this page as a source? Consider author attribution, citations, " +
          "primary vs secondary source, presence of verifiable data, and signs of content farming.",
        criteria: CREDIBILITY_CRITERIA
      },
      redundancy: {
        type: "noul",
        instructions:
          "The page largely repeats what a reader who follows these topics (" + topics + ") already knows."
      },
      contentType: {
        type: "choice",
        instructions: "What kind of page is this, primarily?",
        criteria: {
          news: "资讯 / 新闻",
          tutorial: "教程 / 实操指南",
          reference: "文档 / 参考资料",
          analysis: "深度分析 / 研究报告",
          opinion: "观点 / 评论",
          marketing: "营销 / 广告 / 推广页",
          discussion: "论坛帖 / 问答讨论",
          other: "其他"
        }
      },
      timelessness: {
        type: "score",
        instructions:
          "How long will the substance of this page stay valid before going stale?",
        criteria: TIMELESSNESS_CRITERIA
      }
    };
  }

  /* ================= 搜索结果条目评估 ================= */

  function serpQuestions(settings) {
    const topics = TOPIC_JOIN(settings.topics);
    return {
      verdict: {
        type: "choice",
        instructions:
          "The reader searched a search engine and is looking at this single result " +
          "(title, url, snippet only). Focus topics: " + topics + ". " +
          "Decide whether this result is worth clicking and reading.",
        criteria: {
          read: "值得点开细读",
          skim: "可点开扫一眼",
          skip: "跳过这条结果"
        }
      },
      relevance: {
        type: "score",
        instructions:
          "How relevant is this search result to the reader's focus topics (" + topics + ")?",
        criteria: RELEVANCE_CRITERIA
      },
      credibility: {
        type: "score",
        instructions:
          "Judging by the domain, title and snippet only: how trustworthy is this source? " +
          "Domain-reputation heuristics count; content-farm and pure-SEO patterns should score low.",
        criteria: CREDIBILITY_CRITERIA
      },
      intentMatch: {
        type: "noul",
        instructions:
          "The result appears to answer the query with substantive content rather than being " +
          "a commercial page, a login wall, a listicle of unrelated items, or an ad."
      }
    };
  }

  /* ================= 归一化 ================= */

  function composeReason(r) {
    const bits = [];
    if (r.redundancy != null && r.redundancy >= 0.6) {
      return "⚠️ 可能没有太多新信息：与你已掌握的内容高度重复。";
    }
    if (r.verdict === "read") {
      if (r.novelty >= 60 && r.credibility >= 60) bits.push("内容新且来源可信");
      else if (r.novelty >= 60) bits.push("含较多新信息");
      else bits.push("与你的关注点高度重合");
    } else if (r.verdict === "skim") {
      if (r.relevance >= 55) bits.push("主题相关，但信息密度中等");
      else bits.push("有一定信息量，但需要挑着看");
      if (r.credibility < 45) bits.push("来源可信度偏低");
    } else {
      if (r.relevance != null && r.relevance < 30) bits.push("与当前关注方向关系不大");
      else if (r.novelty != null && r.novelty < 30) bits.push("几乎没有新信息");
      else if (r.credibility != null && r.credibility < 30) bits.push("来源可信度低");
      else bits.push("综合判断收益不足");
    }
    return bits.join("；") + "。";
  }

  function normalizePage(answers, meta) {
    const a = answers || {};
    const verdictKey = RS.jev.choiceValue(a.verdict);
    const verdict = RS.VERDICT[verdictKey] ? verdictKey : "skim";

    const relevance = RS.jev.scoreToPct(a.relevance, RELEVANCE_CRITERIA.length);
    const novelty = RS.jev.scoreToPct(a.novelty, NOVELTY_CRITERIA.length);
    const credibility = RS.jev.scoreToPct(a.credibility, CREDIBILITY_CRITERIA.length);
    const timelessness = RS.jev.scoreToPct(a.timelessness, TIMELESSNESS_CRITERIA.length);

    const valueKey = RS.jev.choiceValue(a.value);
    const value = RS.VALUE_LABEL[valueKey] ? valueKey : null;

    const typeKey = RS.jev.choiceValue(a.contentType);
    const contentType = RS.CONTENT_TYPE_LABEL[typeKey] ? typeKey : "other";

    const redundancy = RS.jev.noulValue(a.redundancy);
    const confidence = a.verdict && typeof a.verdict.confidence === "number"
      ? Math.round(a.verdict.confidence * 100) / 100
      : null;

    const out = {
      kind: "page",
      verdict,
      relevance,
      novelty,
      credibility,
      timelessness,
      value,
      valueKey: valueKey || null,
      contentType,
      contentTypeKey: typeKey || "other",
      redundancy,
      confidence,
      warning: redundancy != null && redundancy >= 0.6 ? "redundant" : null,
      lowConfidence: confidence != null && confidence < 0.45,
      source: "jev",
      model: (meta && meta.model) || null,
      usage: (meta && meta.usage) || null,
      at: Date.now()
    };
    out.reason = composeReason(out);
    return out;
  }

  function normalizeSerp(answers, meta) {
    const a = answers || {};
    const verdictKey = RS.jev.choiceValue(a.verdict);
    const verdict = RS.VERDICT[verdictKey] ? verdictKey : "skim";
    const out = {
      kind: "serp",
      verdict,
      relevance: RS.jev.scoreToPct(a.relevance, RELEVANCE_CRITERIA.length),
      credibility: RS.jev.scoreToPct(a.credibility, CREDIBILITY_CRITERIA.length),
      intentMatch: RS.jev.noulValue(a.intentMatch),
      novelty: null,
      confidence: a.verdict && typeof a.verdict.confidence === "number"
        ? Math.round(a.verdict.confidence * 100) / 100
        : null,
      partial: true,
      source: "jev",
      model: (meta && meta.model) || null,
      usage: (meta && meta.usage) || null,
      at: Date.now()
    };
    out.warning = out.intentMatch != null && out.intentMatch < 0.35 ? "intent" : null;
    return out;
  }

  RS.questions = {
    pageQuestions,
    serpQuestions,
    normalizePage,
    normalizeSerp,
    CRITERIA: {
      relevance: RELEVANCE_CRITERIA,
      novelty: NOVELTY_CRITERIA,
      credibility: CREDIBILITY_CRITERIA,
      timelessness: TIMELESSNESS_CRITERIA
    }
  };
})(globalThis.RS);
