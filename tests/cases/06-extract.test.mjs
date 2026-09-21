/**
 * 正文抽取（extract.js）。
 * 抽错正文 → 模型看到的是一堆导航词 → 判定直接失真，所以要把"选哪块"钉死。
 */
import { describe, it } from "../harness/registry.mjs";
import * as a from "../harness/assert.mjs";
import { createEnv, loadLibs } from "../harness/env.mjs";

// 正文必须超过 scoreCandidate 的 120 字门槛，否则选主节点会退回 body，
// 后面所有基于 article 的断言就都失去了意义。
const BODY_TEXT =
  "扩展开发实战的正文段落，长度需要超过阈值才能被选中为正文容器，所以这里写长一点。".repeat(6);

const ARTICLE_HTML = `<!doctype html>
<html lang="zh-CN"><head>
<title>页面标题 - 站点名</title>
<meta name="description" content="这是 meta 摘要">
<meta property="og:title" content="OG 标题">
</head><body>
<nav><a href="/a">导航条目一</a><a href="/b">导航条目二</a></nav>
<header>站点头部</header>
<article>
  <h1>正文大标题</h1>
  <p>这是第一段正文内容。${BODY_TEXT}</p>
  <p>这是第二段正文内容。${BODY_TEXT}</p>
  <pre>const a = 1;</pre>
  <img src="x.png" alt="图">
</article>
<aside>右侧推荐栏</aside>
<footer>页脚版权信息</footer>
</body></html>`;

function boot(html = ARTICLE_HTML, url = "https://example.com/post/1") {
  const env = createEnv({ url, html });
  loadLibs(env, ["heuristics.js", "extract.js"]);
  return env;
}

describe("extract / cleanText", () => {
  it("去掉脚本、样式、导航、页脚、侧栏、表单与 iframe", () => {
    const env = boot();
    const doc = env.doc;
    const div = doc.createElement("div");
    div.innerHTML =
      "<p>要保留的正文</p><script>var y=1;</script><style>.z{color:red}</style>" +
      "<nav>导航</nav><header>头部</header><footer>页脚</footer><aside>侧栏</aside>" +
      "<iframe src='a.html'></iframe><form><input></form><noscript>降级</noscript>";
    const text = env.win.RS.extract.cleanText(div);
    a.includes(text, "要保留的正文");
    for (const junk of ["var y=1", ".z{color:red}", "导航", "头部", "页脚", "侧栏", "降级"]) {
      a.notIncludes(text, junk, "不该保留：" + junk);
    }
  });

  it("压缩空白但不吞掉段落分隔", () => {
    const env = boot();
    const doc = env.doc;
    const div = doc.createElement("div");
    div.textContent = "第一段\n\n\n\n第二段    有很多空格\t制表符";
    const text = env.win.RS.extract.cleanText(div);
    a.notIncludes(text, "    ", "连续空格应被压缩");
    a.notIncludes(text, "\n\n\n", "三个以上换行应被压缩");
    a.includes(text, "第一段");
    a.includes(text, "第二段");
  });

  it("空节点返回空串", () => {
    const env = boot();
    a.equal(env.win.RS.extract.cleanText(null), "");
  });
});

describe("extract / pickMainNode 选主节点", () => {
  it("优先选 article，而不是外层的 body", () => {
    const env = boot();
    const node = env.win.RS.extract.pickMainNode();
    a.equal(node.tagName, "ARTICLE");
  });

  it("没有语义标签时回落到 body，而不是空手而归", () => {
    const env = boot(
      "<!doctype html><html><body><div>" + "<p>正文段落内容。</p>".repeat(30) + "</div></body></html>"
    );
    const node = env.win.RS.extract.pickMainNode();
    a.ok(node, "必须返回一个节点");
    a.equal(node.tagName, "BODY");
  });

  it("链接堆砌的容器不会被当成正文", () => {
    const html =
      "<!doctype html><html><body>" +
      "<div class='content'><a href='/1'>链接</a><a href='/2'>链接</a><a href='/3'>链接</a></div>" +
      "<div class='post-body'>" +
      "<p>真正的一段正文，内容足够长以便被选中。</p>".repeat(10) +
      "</div></body></html>";
    const env = boot(html);
    const node = env.win.RS.extract.pickMainNode();
    a.notEqual(node.className, "content", "链接堆砌的容器不应被选为正文");
  });
});

describe("extract / page 元信息", () => {
  it("标题优先用 og:title，摘要用 meta description", () => {
    const env = boot();
    const p = env.win.RS.extract.page();
    a.equal(p.title, "OG 标题");
    a.equal(p.description, "这是 meta 摘要");
    a.equal(p.lang, "zh-CN");
    a.equal(p.domain, "example.com");
    a.equal(p.url, "https://example.com/post/1");
    a.isNumber(p.capturedAt);
  });

  it("没有 og:title 时回落到 <title>", () => {
    const env = boot("<!doctype html><html><head><title>普通标题</title></head><body><p>正文</p></body></html>");
    a.equal(env.win.RS.extract.page().title, "普通标题");
  });

  it("统计段落、标题、代码块、图片", () => {
    const env = boot();
    const p = env.win.RS.extract.page();
    a.equal(p.paragraphCount, 2);
    a.gte(p.headings, 1);
    a.equal(p.codeBlocks, 1);
    a.equal(p.images, 1);
    a.equal(p.charCount, p.text.length);
    a.gt(p.charCount, 10);
  });

  it("正文不含导航 / 页脚文本", () => {
    const env = boot();
    const p = env.win.RS.extract.page();
    a.includes(p.text, "这是第一段正文内容");
    a.notIncludes(p.text, "导航条目一", "导航不该进正文");
    a.notIncludes(p.text, "页脚版权信息", "页脚不该进正文");
    a.notIncludes(p.text, "右侧推荐栏", "侧栏不该进正文");
  });

  it("正文里的链接密度会被算出来", () => {
    const html =
      "<!doctype html><html><body><article>" +
      "<p><a href='/x'>" + "链接文字".repeat(20) + "</a></p>" +
      "<p><a href='/y'>" + "链接文字".repeat(20) + "</a></p>" +
      "</article></body></html>";
    const env = boot(html);
    const p = env.win.RS.extract.page();
    a.gt(p.linkDensity, 0.9, "几乎全是链接时密度应接近 1");
  });

  it("纯正文页面链接密度为 0", () => {
    const env = boot();
    a.equal(env.win.RS.extract.page().linkDensity, 0);
  });

  it("识别出页面里有密码输入框", () => {
    const env = boot(
      "<!doctype html><html><body><form><input type='password'></form><p>正文</p></body></html>"
    );
    a.equal(env.win.RS.extract.page().hasPasswordField, true);
  });

  it("中文正文的 cjkRatio 接近 1，英文接近 0", () => {
    const cn = boot("<!doctype html><html><body><article><p>" + "这是一段中文正文内容。".repeat(20) + "</p></article></body></html>");
    a.gt(cn.win.RS.extract.page().cjkRatio, 0.8);
    const en = boot("<!doctype html><html><body><article><p>" + "This is an English article body. ".repeat(20) + "</p></article></body></html>");
    a.lt(en.win.RS.extract.page().cjkRatio, 0.05);
  });
});

describe("extract / buildState 隐私与截断", () => {
  const page = {
    url: "https://example.com/post/1",
    domain: "example.com",
    title: "标题",
    description: "摘要",
    text: "正文".repeat(500),
    charCount: 1000,
    paragraphCount: 10,
    headings: 2,
    codeBlocks: 1,
    images: 3,
    linkDensity: 0.05
  };

  it("默认发送正文摘录，并带上结构统计", () => {
    const env = boot();
    const s = env.win.RS.extract.buildState(page, { topics: ["AI"], privacyMode: "full", excerptChars: 6000 });
    a.includes(s.content, "正文");
    a.equal(s.stats.charCount, 1000);
    a.equal(s.stats.codeBlocks, 1);
    a.deepEqual(s.focusTopics, ["AI"]);
    a.equal(s.truncated, undefined, "没超上限就不该标截断");
  });

  it("超过摘录上限时截断并标记", () => {
    const env = boot();
    const s = env.win.RS.extract.buildState(page, { privacyMode: "full", excerptChars: 100 });
    a.equal(s.content.length, 100);
    a.equal(s.truncated, true);
  });

  it("titles 模式只发标题与摘要，不发正文", () => {
    const env = boot();
    const s = env.win.RS.extract.buildState(page, { privacyMode: "titles" });
    a.equal(s.content, undefined, "保守模式下不能带正文");
    a.equal(s.stats, undefined);
    a.equal(s.title, "标题");
    a.equal(s.metaDescription, "摘要");
    a.includes(s.note, "标题与摘要");
  });

  it("没有任何设置时使用默认值，不抛错", () => {
    const env = boot();
    const s = env.win.RS.extract.buildState(page, undefined);
    a.includes(s.content, "正文");
    a.deepEqual(s.focusTopics, [], "没设置主题时给空数组而不是 undefined");
  });

  it("state 可被 JSON 序列化（undefined 字段不会污染请求体）", () => {
    const env = boot();
    const s = env.win.RS.extract.buildState(page, { privacyMode: "full" });
    const round = JSON.parse(JSON.stringify(s));
    a.notIncludes(JSON.stringify(round), "undefined");
    a.equal(round.url, page.url);
  });
});
