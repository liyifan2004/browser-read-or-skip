/**
 * Read or Skip —— 全局常量、枚举、默认设置。
 */
(function (RS) {
  /* ---------- API ---------- */
  RS.API_URL = "https://api.typesafe.ai/v1/systemone";
  RS.DEFAULT_MODEL = "jev-latest";

  /* ---------- 判定枚举 ---------- */
  // rank 越大越"值得读"，用于排序 / 比较 / 徽章配色
  // 判定三色只用于结论（判定词 / 综合分刻度 / 角标圆点），数值条一律用 accent 色相
  RS.VERDICT = {
    read: { key: "read", label: "值得认真读", short: "值得读", color: "#4ADE9E", glow: "rgba(74,222,158,.45)", rank: 2, icon: "book" },
    skim: { key: "skim", label: "快速扫", short: "快速扫", color: "#F2C14E", glow: "rgba(242,193,78,.42)", rank: 1, icon: "scan" },
    skip: { key: "skip", label: "可以跳过", short: "可跳过", color: "#A7B0BE", glow: "rgba(167,176,190,.35)", rank: 0, icon: "skip" },
    pending: { key: "pending", label: "评估中…", short: "…", color: "#60A5FA", glow: "rgba(96,165,250,.40)", rank: -1, icon: "spinner" },
    unknown: { key: "unknown", label: "未评估", short: "—", color: "#64748B", glow: "rgba(100,116,139,.30)", rank: -1, icon: "none" },
    error: { key: "error", label: "评估失败", short: "失败", color: "#FD8A9B", glow: "rgba(253,138,155,.38)", rank: -1, icon: "alert" }
  };
  RS.VERDICT_ORDER = ["read", "skim", "skip"];

  /**
   * 搜索结果徽章配色：浅色 / 深色宿主页各一套，「浅底深字」编码。
   * 每一对前景 / 背景都用 WCAG 相对亮度公式验证 ≥ 4.5:1（tests/11-ui-regression 会复算）。
   * marker 字段是每档的非颜色线索：实心点 / 空心底 / 短横。
   */
  RS.SERP_THEME = {
    light: {
      read:    { fg: "#065F46", bg: "#D1FAE5", marker: "dot-solid" },
      skim:    { fg: "#78350F", bg: "#FEF3C7", marker: "dot-hollow" },
      skip:    { fg: "#334155", bg: "#E2E8F0", marker: "dash" },
      pending: { fg: "#475569", bg: "#EEF1F5", marker: "none" }
    },
    dark: {
      read:    { fg: "#6EE7B7", bg: "#12362A", marker: "dot-solid" },
      skim:    { fg: "#FCD34D", bg: "#3B2E0B", marker: "dot-hollow" },
      skip:    { fg: "#D6DEF0", bg: "#232B38", marker: "dash" },
      pending: { fg: "#A9C8FC", bg: "#1B2A44", marker: "none" }
    },
    summary: {
      light: { fg: "#27425F", bg: "#E9F0FA", brand: "#1D4ED8" },
      dark:  { fg: "#D6DEF0", bg: "#1C2431", brand: "#93C5FD" }
    }
  };

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
    heuristic: "初判",
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

    // 跳过评估的站点：纯域名条目按主机名精确匹配（子域也算），
    // 其余条目（路径片段、"login." 这类前缀）按子串匹配。
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
      "/signin",
      // 社交流：无限滚动 + 强时效内容，认真读判定没有意义。
      // 只预置最吵的三个（微博 / X / 抖音）；其余站点交给浮层上的「暂停 / 永久屏蔽」由用户自己决定，
      // 显式控制比隐式名单更可发现 —— 用户至少知道浮层为什么不出现。
      "weibo.com",
      "weibo.cn",
      "x.com",
      "twitter.com",
      "douyin.com"
    ],

    // 分站点暂停：{ 主机名: 到期时间戳 }。到期自动失效，不需要清理任务；与黑名单分开存（临时 vs 永久）
    pausedSites: {},

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
    "gov.cn", "edu.cn"
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
