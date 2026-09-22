/**
 * 本地启发式打分（heuristics.js）。
 * 这层是"模型没回来之前用户看到的第一个结论"，错判会直接误导，必须逐分支钉死。
 */
import { describe, it } from "../harness/registry.mjs";
import * as a from "../harness/assert.mjs";
import { createEnv, loadLibs } from "../harness/env.mjs";

function boot(url = "https://example.com/a", html) {
  const env = createEnv({ url, html });
  loadLibs(env, ["heuristics.js"]);
  return env;
}

const BASE_SETTINGS = {
  topics: ["浏览器扩展开发", "AI Agent 编排"],
  minTextLength: 400,
  siteBlocklist: ["localhost", "mail.google.com", "/login"]
};

function page(over = {}) {
  const text = over.text != null ? over.text : "x".repeat(1000);
  const p = Object.assign(
    {
      url: "https://example.com/post/hello",
      title: "一篇普通文章",
      domain: "example.com",
      text,
      charCount: text.length,
      paragraphCount: 5,
      headings: 1,
      codeBlocks: 0,
      images: 0,
      linkDensity: 0,
      cjkRatio: 0
    },
    over
  );
  p.charCount = over.charCount != null ? over.charCount : p.text.length;
  return p;
}

describe("heuristics / 域名工具", () => {
  it("导出面完整（含 isSearchResultsPage）", () => {
    const env = boot();
    const h = env.win.RS.heuristics;
    for (const name of [
      "isBlocked",
      "isReadablePage",
      "isSearchResultsPage",
      "scorePage",
      "domainOf",
      "trustOfDomain",
      "cjkRatio",
      "readingMinutes",
      "topicOverlap",
      "pathSignals",
      "clamp",
      "formatBytes"
    ]) {
      a.isFunction(h[name], "RS.heuristics." + name + " 应该是函数");
    }
  });

  it("domainOf 去掉 www 前缀，非法输入返回空串", () => {
    const env = boot();
    const d = env.win.RS.heuristics.domainOf;
    a.equal(d("https://www.github.com/a/b?c=1"), "github.com");
    a.equal(d("http://sub.example.com/x"), "sub.example.com");
    a.equal(d("not a url"), "");
    a.equal(d(""), "");
    a.equal(d(null), "");
  });

  it("trustOfDomain 分层：高可信 / 低可信 / 教育政府 / 子域名", () => {
    const env = boot();
    const t = env.win.RS.heuristics.trustOfDomain;
    a.equal(t("developer.chrome.com"), 88, "白名单域名应给 88");
    a.equal(t("docs.python.org"), 88);
    a.equal(t("baijiahao.baidu.com"), 34, "内容农场域名应给 34");
    a.equal(t("blog.csdn.net"), 34);
    a.equal(t("www.tsinghua.edu.cn"), 88, "名单里显式列了 edu.cn，优先于通用教育域规则");
    a.equal(t("mit.edu"), 85, "纯 .edu 走通用教育域规则");
    a.equal(t("www.whitehouse.gov"), 85, "gov 应识别为政府域名");
    a.equal(t("blog.example.com"), 66, "blog 子域名给 66");
    a.equal(t("random-site.xyz"), 55, "未知域名给中性 55");
    a.equal(t(""), 50, "空域名给 50");
  });

  it("可信度名单里不应混入非 URL 片段的字符串", () => {
    const env = boot();
    const RS = env.win.RS;
    const lists = [
      ["TRUST_HIGH", RS.TRUST_HIGH],
      ["TRUST_LOW", RS.TRUST_LOW]
    ];
    for (const [name, list] of lists) {
      a.isArray(list, name + " 应是数组");
      a.gt(list.length, 0);
      for (const entry of list) {
        // 名单项要么是域名，要么是 "host/path" 形式；中文词之类混进来一定是写错了
        a.match(entry, /^[\x21-\x7e]+$/, name + " 里有非 ASCII 项：" + entry);
        a.equal(entry, entry.toLowerCase(), name + " 的项应全小写：" + entry);
        a.notIncludes(entry, " ", name + " 的项不应含空格：" + entry);
      }
    }
  });

  it("pathSignals 识别文档 / 博客 / 视频 / PDF / 功能页", () => {
    const env = boot();
    const p = env.win.RS.heuristics.pathSignals;
    a.deepEqual(
      [p("https://x.com/docs/api/foo").doc, p("https://x.com/blog/post").blog, p("https://x.com/a.pdf").pdf],
      [true, true, true]
    );
    a.equal(p("https://www.youtube.com/watch?v=abc").video, true);
    a.equal(p("https://www.bilibili.com/video/BV1xx").video, true);
    for (const u of [
      "https://x.com/login",
      "https://x.com/signin",
      "https://x.com/tag/ai",
      "https://x.com/category/dev",
      "https://x.com/author/zhang",
      "https://x.com/page/3",
      "https://x.com/archive"
    ]) {
      a.equal(p(u).nonArticle, true, u + " 应被判为非正文页");
    }
    a.equal(p("https://x.com/posts/2026/09/hello").blog, true);
    a.equal(p("https://x.com/a/b/c").nonArticle, false);
  });
});

describe("heuristics / 文本度量", () => {
  it("cjkRatio 分辨中文与英文", () => {
    const env = boot();
    const r = env.win.RS.heuristics.cjkRatio;
    a.near(r("这是一段全中文的文字内容"), 1, 0.0001);
    a.equal(r("this is pure english text"), 0);
    a.equal(r(""), 0);
    const mixed = r("abc中文");
    a.between(mixed, 0.3, 0.7, "中英混合应落在中间");
  });

  it("readingMinutes 中文比英文慢，且至少 1 分钟", () => {
    const env = boot();
    const rm = env.win.RS.heuristics.readingMinutes;
    a.equal(rm(0, 1), 1, "空正文也应给 1 分钟下限");
    a.equal(rm(50, 1), 1);
    const cn = rm(4800, 1);
    const en = rm(4800, 0);
    a.gt(cn, en, "同样字数中文应更慢");
    a.equal(en, 4);
  });

  it("clamp / formatBytes 边界", () => {
    const env = boot();
    const { clamp, formatBytes } = env.win.RS.heuristics;
    a.equal(clamp(5, 0, 10), 5);
    a.equal(clamp(-1, 0, 10), 0);
    a.equal(clamp(11, 0, 10), 10);
    a.equal(formatBytes(0), "0 B");
    a.equal(formatBytes(512), "512 B");
    a.equal(formatBytes(2048), "2.0 KB");
    a.equal(formatBytes(1024 * 1024 * 3), "3.0 MB");
  });

  it("topicOverlap：无主题 / 空语料返回 null，完全不沾边返回 0", () => {
    const env = boot();
    const ov = env.win.RS.heuristics.topicOverlap;
    a.equal(ov("t", "x", []), null);
    a.equal(ov("t", "x", null), null);
    a.equal(ov("t", "x", undefined), null);
    a.equal(ov("", "", ["浏览器扩展开发"]), null, "语料为空时返回 null");
    a.equal(ov("标题", "正文内容与主题无关", ["浏览器扩展开发"]), 0);
  });

  it("topicOverlap：同等出现次数下，标题命中比正文命中更值钱", () => {
    const env = boot();
    const ov = env.win.RS.heuristics.topicOverlap;
    const inTitle = ov("浏览器扩展开发", "", ["浏览器扩展开发"]);
    const inBody = ov("", "浏览器扩展开发", ["浏览器扩展开发"]);
    a.gt(inTitle, inBody, "各命中一次时，标题侧应更高");
    a.gt(inBody, 0, "正文命中一次也要大于 0");
  });

  it("topicOverlap：命中其中一个主题就该给高分，不被没沾边的主题稀释", () => {
    const env = boot();
    const ov = env.win.RS.heuristics.topicOverlap;
    const v = ov("一篇讲扩展的文章", "浏览器扩展开发 ".repeat(200), [
      "AI / 大模型",
      "浏览器扩展开发",
      "前端工程"
    ]);
    a.gte(v, 0.75, "正中一个主题的长文相关度不应被拉到 0.75 以下（历史回归点：曾只得 0.35）");
    a.lte(v, 1);
  });

  it("topicOverlap：ASCII 关键词卡词边界，email 不该命中主题 AI", () => {
    const env = boot();
    const ov = env.win.RS.heuristics.topicOverlap;
    a.equal(ov("Everything about email", "maintain and chair repair", ["AI"]), 0, "email / maintain / chair 里的 ai 不是关键词");
    a.gt(ov("Using AI daily", "", ["AI"]), 0, "独立出现的 AI 应该命中");
  });

  it("topicOverlap：带连字符的主题按整词匹配", () => {
    const env = boot();
    const ov = env.win.RS.heuristics.topicOverlap;
    const v = ov("", "we use gpt-4 in production", ["GPT-4"]);
    a.gt(v, 0, "包含连字符的主题应能整体命中");
  });
});

describe("heuristics / isBlocked", () => {
  it("子串匹配、忽略大小写、空值安全", () => {
    const env = boot();
    const f = env.win.RS.heuristics.isBlocked;
    a.equal(f("https://example.com/login", BASE_SETTINGS), true);
    a.equal(f("https://MAIL.GOOGLE.COM/x", BASE_SETTINGS), true, "大小写不敏感");
    a.equal(f("http://localhost:3000/", BASE_SETTINGS), true);
    a.equal(f("https://example.com/article", BASE_SETTINGS), false);
    a.equal(f("", BASE_SETTINGS), true, "空 URL 视为应跳过");
    a.equal(f(null, BASE_SETTINGS), true);
    a.equal(f("https://example.com/x", {}), false, "没有名单时不应拦");
  });

  it("纯域名条目按主机名精确匹配：x.com 不得误杀 netflix.com", () => {
    const env = boot();
    const f = env.win.RS.heuristics.isBlocked;
    const settings = { siteBlocklist: ["x.com", "weibo.com"] };
    a.equal(f("https://www.netflix.com/watch/123", settings), false, "netflix.com 含子串 x.com 但不是 x.com");
    a.equal(f("https://x.com/user/status/1", settings), true);
    a.equal(f("https://mobile.x.com/home", settings), true, "子域也应被拦");
    a.equal(f("https://weibo.com/u/123", settings), true);
    a.equal(f("https://s.weibo.com/weibo?q=x", settings), true, "子域 s.weibo.com 也应被拦");
    a.equal(f("https://notweibo.com/", settings), false, "只恰好含 weibo.com 子串的站点不拦");
  });

  it("路径与前缀条目维持子串匹配", () => {
    const env = boot();
    const f = env.win.RS.heuristics.isBlocked;
    const settings = { siteBlocklist: ["/login", "login.", "chrome.google.com/webstore"] };
    a.equal(f("https://example.com/login", settings), true);
    a.equal(f("https://example.com/account/login-next", settings), true);
    a.equal(f("https://a.login.example.com/page", settings), true, "login. 这类前缀条目仍是子串匹配");
    a.equal(f("https://chrome.google.com/webstore/category/extensions", settings), true);
  });

  it("默认黑名单已包含主流社交流站点", () => {
    const env = boot();
    const bl = env.win.RS.DEFAULT_SETTINGS.siteBlocklist;
    for (const d of [
      "weibo.com", "weibo.cn", "x.com", "twitter.com", "instagram.com",
      "facebook.com", "tiktok.com", "douyin.com", "reddit.com", "threads.net"
    ]) {
      a.ok(bl.includes(d), "默认黑名单应包含 " + d);
    }
    a.ok(bl.includes("linkedin.com/feed"), "linkedin 信息流条目应存在");
  });
});

describe("heuristics / isReadablePage", () => {
  it("http 正文页可读，file: 协议不可读", () => {
    const env = createEnv({ url: "https://example.com/a", html: "<body><p>正文</p></body>" });
    loadLibs(env, ["heuristics.js"]);
    a.equal(env.win.RS.heuristics.isReadablePage(), true);
  });

  it("带密码框且正文很短的页面判为应用页", () => {
    const env = createEnv({
      url: "https://example.com/signin",
      html: "<body><form><input type='password'><input type='text'></form></body>"
    });
    loadLibs(env, ["heuristics.js"]);
    a.equal(env.win.RS.heuristics.isReadablePage(), false);
  });

  it("带密码框但正文很长的页面仍可读", () => {
    const env = createEnv({
      url: "https://example.com/a",
      html: "<body><input type='password'><p>" + "字".repeat(1300) + "</p></body>"
    });
    loadLibs(env, ["heuristics.js"]);
    a.equal(env.win.RS.heuristics.isReadablePage(), true);
  });

  it("base 是函数（SERP 识别）", () => {
    const env = boot();
    a.isFunction(env.win.RS.heuristics.isSearchResultsPage);
  });
});

describe("heuristics / scorePage 硬排除分支", () => {
  it("导航 / 登录 / 错误页标题 → 直接跳过", () => {
    const env = boot();
    const sp = env.win.RS.heuristics.scorePage;
    for (const title of ["登录", "注册", "404 Not Found", "Sign in", "页面不存在"]) {
      const r = sp(page({ title }), BASE_SETTINGS);
      a.equal(r.verdict, "skip", "标题「" + title + "」应跳过");
      a.equal(r.source, "heuristic");
      a.equal(r.approximate, true);
      a.includes(r.reason, "跳过");
    }
  });

  it("列表 / 归档 / 功能页路径 → 直接跳过", () => {
    const env = boot();
    const sp = env.win.RS.heuristics.scorePage;
    for (const url of ["https://x.com/tag/ai", "https://x.com/author/me", "https://x.com/checkout"]) {
      const r = sp(page({ url }), BASE_SETTINGS);
      a.equal(r.verdict, "skip", url + " 应跳过");
    }
  });

  it("内容极短的首页 → 跳过", () => {
    const env = boot();
    const sp = env.win.RS.heuristics.scorePage;
    const r = sp(page({ url: "https://example.com/", text: "欢迎光临", charCount: 4 }), BASE_SETTINGS);
    a.equal(r.verdict, "skip");
  });

  it("正文短于 200 字 → 跳过，短于阈值 → 降为快速扫", () => {
    const env = boot();
    const sp = env.win.RS.heuristics.scorePage;
    const tiny = sp(page({ url: "https://x.com/p/1", text: "短".repeat(150), charCount: 150 }), BASE_SETTINGS);
    a.equal(tiny.verdict, "skip");
    a.includes(tiny.reason, "过短");

    const short = sp(page({ url: "https://x.com/p/2", text: "字".repeat(300), charCount: 300 }), BASE_SETTINGS);
    a.notEqual(short.verdict, "read", "不足最短长度的页面不该判为值得读");
  });

  it("链接密度过高 → 判为跳过并给出原因", () => {
    const env = boot();
    const r = env.win.RS.heuristics.scorePage(
      page({ url: "https://x.com/p/3", linkDensity: 0.6, text: "字".repeat(800), charCount: 800 }),
      BASE_SETTINGS
    );
    a.equal(r.verdict, "skip");
    a.includes(r.reason, "链接密度");
  });
});

describe("heuristics / scorePage 正向与边界", () => {
  const longText =
    "浏览器扩展开发 的 Service Worker 生命周期。".repeat(200) +
    "\n" + "浏览器扩展开发 在 Manifest V3 里的状态持久化。".repeat(100);
  const longPage = page({
    url: "https://github.com/foo/bar/blob/main/README.md",
    title: "浏览器扩展开发实战：Service Worker 生命周期",
    domain: "github.com",
    text: longText,
    charCount: longText.length,
    paragraphCount: 30,
    headings: 8,
    codeBlocks: 12
  });

  it("高相关 + 长文 + 白名单域名 → 值得认真读", () => {
    const env = boot();
    const r = env.win.RS.heuristics.scorePage(longPage, BASE_SETTINGS);
    a.equal(r.verdict, "read");
    a.gte(r.relevance, 55, "相关度应被主题命中拉高");
    a.gte(r.credibility, 80, "github.com 应给高可信度");
    a.includes(["high", "medium"], r.value);
  });

  it("所有数值指标都落在 0~100 且类型正确", () => {
    const env = boot();
    const r = env.win.RS.heuristics.scorePage(longPage, BASE_SETTINGS);
    for (const k of ["relevance", "novelty", "credibility", "timelessness"]) {
      a.isNumber(r[k], k + " 应是数字");
      a.between(r[k], 0, 100, k + " 应在 0~100");
    }
    a.ok(["read", "skim", "skip"].includes(r.verdict), "verdict 取值非法：" + r.verdict);
    a.ok(["high", "medium", "low"].includes(r.value), "value 取值非法：" + r.value);
    a.isString(r.reason);
    a.gt(r.reason.length, 4);
    a.isNumber(r.readingMinutes);
    a.gte(r.readingMinutes, 1);
  });

  it("结果结构与模型归一化结果同构（同一套渲染代码能吃）", () => {
    const env = boot();
    const r = env.win.RS.heuristics.scorePage(longPage, BASE_SETTINGS);
    for (const k of [
      "kind",
      "verdict",
      "relevance",
      "novelty",
      "credibility",
      "timelessness",
      "value",
      "contentType",
      "redundancy",
      "confidence",
      "warning",
      "source",
      "model",
      "usage",
      "reason"
    ]) {
      a.hasKey(r, k, "启发式结果缺少字段 " + k);
    }
    a.equal(r.kind, "page");
    a.equal(r.source, "heuristic");
  });

  it("内容农场域名 → 可信度压到 34 以下且阅读价值为低", () => {
    const env = boot();
    const r = env.win.RS.heuristics.scorePage(
      page({
        url: "https://baijiahao.baidu.com/s?id=1",
        domain: "baijiahao.baidu.com",
        title: "2026 年必装的 10 个 AI 神器",
        text: "内容".repeat(600),
        charCount: 1200
      }),
      BASE_SETTINGS
    );
    a.lte(r.credibility, 34);
    a.equal(r.value, "low");
    a.equal(r.verdict, "skip");
  });

  it("文档路径 → 内容类型为 reference 且保底可信度", () => {
    const env = boot();
    const r = env.win.RS.heuristics.scorePage(
      page({ url: "https://example.com/docs/guide/start", domain: "example.com" }),
      BASE_SETTINGS
    );
    a.equal(r.contentType, "reference");
    a.gte(r.credibility, 55);
  });

  it("含代码块 → 内容类型兜底为 tutorial", () => {
    const env = boot();
    const r = env.win.RS.heuristics.scorePage(
      page({ url: "https://example.com/p/x", codeBlocks: 3 }),
      BASE_SETTINGS
    );
    a.equal(r.contentType, "tutorial");
  });

  it("没有设置关注主题时相关度回落到中性，不应崩", () => {
    const env = boot();
    const r = env.win.RS.heuristics.scorePage(longPage, { minTextLength: 400 });
    a.isNumber(r.relevance);
    a.between(r.relevance, 0, 100);
  });

  it("传入残缺 page 对象也不抛错", () => {
    const env = boot();
    const sp = env.win.RS.heuristics.scorePage;
    a.isFunction(sp);
    const r = sp({ url: "https://example.com/p/1" }, BASE_SETTINGS);
    a.ok(r && r.verdict, "残缺输入应返回一个兜底结果");
  });
});
