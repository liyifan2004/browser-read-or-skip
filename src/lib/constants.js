/**
 * Read or Skip —— 全局常量、枚举、默认设置。
 */
(function (RS) {
  /* ---------- API ---------- */
  RS.API_URL = "https://api.typesafe.ai/v1/systemone";
  RS.DEFAULT_MODEL = "jev-latest";

  /* ---------- 判定枚举 ---------- */
  // rank 越大越"值得读"，用于排序 / 比较 / 徽章配色
  RS.VERDICT = {
    read: { key: "read", label: "值得认真读", short: "值得读", color: "#34D399", glow: "rgba(52,211,153,.45)", rank: 2, icon: "book" },
    skim: { key: "skim", label: "快速扫", short: "快速扫", color: "#FBBF24", glow: "rgba(251,191,36,.42)", rank: 1, icon: "scan" },
    skip: { key: "skip", label: "可以跳过", short: "可跳过", color: "#94A3B8", glow: "rgba(148,163,184,.35)", rank: 0, icon: "skip" },
    pending: { key: "pending", label: "评估中…", short: "…", color: "#60A5FA", glow: "rgba(96,165,250,.40)", rank: -1, icon: "spinner" },
    unknown: { key: "unknown", label: "未评估", short: "—", color: "#64748B", glow: "rgba(100,116,139,.30)", rank: -1, icon: "none" },
    error: { key: "error", label: "评估失败", short: "失败", color: "#FB7185", glow: "rgba(251,113,133,.38)", rank: -1, icon: "alert" }
  };
  RS.VERDICT_ORDER = ["read", "skim", "skip"];

  RS.VALUE_LABEL = { high: "高", medium: "中", low: "低" };

  RS.CONTENT_TYPE_LABEL = {
    news: "资讯",
    tutorial: "教程",
    reference: "文档 / 参考",
    analysis: "深度分析",
    opinion: "观点",
    marketing: "营销 / 广告",
    discussion: "讨论 / 帖子",
    other: "其他"
  };

  /* ---------- 数据来源 ---------- */
  RS.SOURCE_LABEL = {
    jev: "模型评估",
    cache: "缓存结果",
    heuristic: "本地估算",
    partial: "搜索结果预判"
  };

  /* ---------- 默认设置 ---------- */
  RS.DEFAULT_SETTINGS = {
    apiKey: "",
    model: RS.DEFAULT_MODEL,

    // 关注主题：相关度以此为准
    topics: ["AI / 大模型", "浏览器扩展开发", "前端工程"],

    // 界面
    showHud: true,
    hudAutoCollapseMs: 9000,
    hudPosition: "bottom-right",

    // 搜索结果页标注
    annotateSerp: true,
    serpMaxResults: 8,

    // 隐私：full = 发送正文摘录；titles = 只发送标题与摘要
    privacyMode: "full",
    excerptChars: 6000,

    // 跳过评估的站点（子串匹配）
    siteBlocklist: [
      "localhost",
      "127.0.0.1",
      "mail.google.com",
      "docs.google.com",
      "outlook.live.com",
      "mail.qq.com",
      "web.whatsapp.com",
      "chrome.google.com/webstore",
      "chromewebstore.google.com",
      "login.",
      "/login",
      "/signin"
    ],

    // 正文太短的页面不评估
    minTextLength: 400,

    // 缓存
    cacheTtlMs: 7 * 24 * 60 * 60 * 1000,
    partialCacheTtlMs: 24 * 60 * 60 * 1000,
    cacheLimit: 300,

    // 网络
    timeoutMs: 8000,
    enabled: true
  };

  /* ---------- 本地可信度参考（启发式用） ---------- */
  RS.TRUST_HIGH = [
    "arxiv.org", "nature.com", "science.org", "acm.org", "ieee.org", "nih.gov", "who.int",
    "developer.mozilla.org", "docs.python.org", "developer.chrome.com", "nodejs.org", "react.dev",
    "kubernetes.io", "rust-lang.org", "go.dev", "kernel.org", "w3.org", "ietf.org",
    "github.com", "gitlab.com", "stackoverflow.com", "wikipedia.org", "wikimedia.org",
    "openai.com", "anthropic.com", "deepmind.google", "research.google", "microsoft.com",
    "apple.com", "cloudflare.com", "vercel.com", "typesafe.ai", "huggingface.co", "pytorch.org",
    "tensorflow.org", "npmjs.com", "pypi.org", "docs.rs", "spring.io", "postgresql.org",
    "统计公报", "gov.cn", "edu.cn"
  ];

  RS.TRUST_LOW = [
    "baijiahao.baidu.com", "toutiao.com", "mini.eastday.com", "kuai.media",
    "sohu.com/a/", "163.com/dy", "qq.com/cmsid", "zhidao.baidu.com",
    "answers.yahoo", "quora.com", "medium.com/@", "substack.com",
    "blog.csdn.net", "juejin.cn/post"
  ];

  /* ---------- 消息类型 ---------- */
  RS.MSG = {
    EVALUATE: "RS_EVALUATE",
    EVALUATE_SERP: "RS_EVALUATE_SERP",
    REQUEST_STATE: "RS_REQUEST_STATE",
    RESULT_UPDATE: "RS_RESULT_UPDATE",
    GET_SETTINGS: "RS_GET_SETTINGS",
    OPEN_OPTIONS: "RS_OPEN_OPTIONS"
  };

  /* ---------- 存储键 ---------- */
  RS.SK = {
    SETTINGS: "rs.settings",
    CACHE: "rs.cache",
    STATS: "rs.stats"
  };
})(globalThis.RS);
