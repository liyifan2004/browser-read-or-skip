/**
 * 转义契约（XSS 防线）。
 *
 * 背景：本扩展把浮层与徽章注入到**用户访问的页面**里（内容脚本的 shadow root
 * 仍然活在页面 DOM 树中，页面的任何脚本都能观察到它）。因此凡是拼进
 * innerHTML 的字符串，只要它可能来自网络（模型返回的 model 字段、页面标题、
 * 错误消息），就必须先转义 —— 否则就是一条真实的 XSS 通道。
 *
 * 本轮修的具体缺陷：hud.js 的 srcLabel() 把远端返回的 `r.model` 原样拼进
 * `S.card.innerHTML`，而 hud.js 里其余所有插值都走了 esc()。这是唯一漏网的一处。
 *
 * 判据：**不是**"字符串里有没有尖括号"，而是
 *   「拼进 innerHTML 的每个可变位置，是否都经过了 esc()」。
 * 所以本文件用「结构断言」而不是纯文本断言：检查解析后的 DOM 里有没有
 * 本不该存在的元素节点（<img> / <script> 等）。
 */
import { describe, it } from "../harness/registry.mjs";
import * as a from "../harness/assert.mjs";
import { createEnv, loadContentScript, waitFor } from "../harness/env.mjs";

const LONG_CN = "这是一段用于测试的正文内容，长度足够让启发式打分认为它是一篇真实文章。".repeat(20);

function articleHtml(title = "浏览器扩展开发实战：Service Worker 生命周期") {
  return (
    "<!doctype html><html lang='zh-CN'><head><title>" +
    title +
    "</title></head><body><article><h1>" +
    title +
    "</h1><p>" +
    LONG_CN +
    "</p></article></body></html>"
  );
}

function modelResult(over = {}) {
  return Object.assign(
    {
      kind: "page",
      verdict: "read",
      relevance: 94,
      novelty: 78,
      credibility: 88,
      timelessness: 62,
      value: "high",
      valueKey: "high",
      contentType: "tutorial",
      contentTypeKey: "tutorial",
      redundancy: 0.12,
      confidence: 0.82,
      lowConfidence: false,
      warning: null,
      source: "jev",
      model: "jev-1.13.0",
      usage: { input_tokens: 900, output_tokens: 200 },
      reason: "内容新且来源可信。",
      elapsedMs: 380,
      at: Date.now()
    },
    over
  );
}

function bootHud(url, html, chromeOpts = {}) {
  const env = createEnv({
    url,
    html,
    chromeOpts: Object.assign(
      { onRuntimeSendMessage: () => Promise.resolve({ ok: true, result: modelResult() }) },
      chromeOpts
    )
  });
  loadContentScript(env, 0);
  return env;
}

function shadow(env) {
  const host = env.doc.getElementById("read-or-skip-host");
  return host ? host.shadowRoot : null;
}

/**
 * 等模型结论落地。
 *
 * 不能只等 `.src` 出现 —— 初判态的卡片里已经有 `.src`（内容是「初判」），
 * 而初判态与模型态渲染出的结构不同（初判没有「阅读价值 / 内容类型」两枚 chip）。
 * 用它当就绪信号会让基线与载荷截到**不同阶段**，基线对比法随即失效。
 * 判据改成 `.plabel` 变成「值得读」—— 那是模型结论落地的标志。
 */
async function waitModel(env) {
  await waitFor(
    () => {
      const root = shadow(env);
      return root && root.querySelector(".plabel") && root.querySelector(".plabel").textContent === "值得读";
    },
    { label: "模型结论落地" }
  );
}

/** 注入载荷：模型名里带一个会加载外部资源的 <img> */
const IMG_PAYLOAD = 'x<img src="https://evil.example/pwn.png">';
/** 注入载荷：模型名里带一个可执行标签 */
const SCRIPT_PAYLOAD = 'x<script>window.__pwned = 1;<\/script>';

describe("转义契约 / 模型名（远端返回）不得成为注入点", () => {
  it("模型名里的 <img> 不会变成真实元素节点", async () => {
    const env = bootHud("https://example.com/post/xss-img", articleHtml(), {
      onRuntimeSendMessage: () =>
        Promise.resolve({ ok: true, result: modelResult({ model: IMG_PAYLOAD }) })
    });
    await waitModel(env);

    const root = shadow(env);
    a.equal(root.querySelectorAll("img").length, 0, "模型名里的 <img> 不得成为元素节点");
    a.equal(root.querySelectorAll("script").length, 0, "不得产生 <script> 节点");
    a.includes(root.querySelector(".src").textContent, "<img", "载荷应作为纯文本显示");
  });

  it("模型名里的 <script> 不会成为真实元素节点，也不会执行", async () => {
    const env = bootHud("https://example.com/post/xss-script", articleHtml(), {
      onRuntimeSendMessage: () =>
        Promise.resolve({ ok: true, result: modelResult({ model: SCRIPT_PAYLOAD }) })
    });
    await waitModel(env);

    const root = shadow(env);
    a.equal(root.querySelectorAll("script").length, 0, "不得产生 <script> 节点");
    a.equal(env.win.__pwned, undefined, "注入的脚本不得执行");
    a.includes(root.querySelector(".src").textContent, "<script>", "载荷应作为纯文本显示");
  });

  it("正常模型名不受影响（转义不能把显示搞坏）", async () => {
    const env = bootHud("https://example.com/post/ok", articleHtml(), {
      onRuntimeSendMessage: () =>
        Promise.resolve({ ok: true, result: modelResult({ model: "jev-1.13.0" }) })
    });
    await waitModel(env);
    a.equal(shadow(env).querySelector(".src").textContent, "jev 1.13.0", "正常模型名应照常显示");
  });
});

describe("转义契约 / DOM 基线对比：外部字段不得改变渲染出的元素结构", () => {
  /**
   * 判据从「某一行有没有 esc()」换成「渲染前后的 DOM 结构是否一致」。
   *
   * 为什么不用静态扫描：静态扫描只能看到**直接**拼接，
   * 而本轮修的缺陷恰恰是**间接**的 —— `srcLabel(r)` 先把 model 拼成字符串，
   * 再由 render() 拼进 innerHTML。扫描 srcLabel 的定义行看不到任何 innerHTML，
   * 于是漏判（反证时已实测：改回旧代码，静态用例仍「通过」，而 DOM 断言挂掉）。
   *
   * 为什么用「基线对比」而不是「标签白名单」：
   *   本扩展自己的图标就是内联 SVG（ICON.chev / ICON.collapse / ICON.warn），
   *   白名单要么放行 SVG（放行了就漏掉注入的 <svg onload>），
   *   要么误伤自己的图标（实测 jsdom 里 SVG 标签名还是 authored case 小写）。
   *   基线对比把「自家结构」当作已知量，只需断言**载荷没有改变结构**。
   */

  /** 统计渲染结果里每个标签出现的次数 */
  function tagCounts(root) {
    const counts = new Map();
    for (const el of root.querySelectorAll("*")) {
      const t = el.tagName.toUpperCase();
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    return counts;
  }

  /** 找出所有内联事件处理属性（on*=） */
  function inlineHandlers(root) {
    const out = [];
    for (const el of root.querySelectorAll("*")) {
      for (const attr of Array.from(el.attributes || [])) {
        if (/^on/i.test(attr.name)) out.push(el.tagName.toUpperCase() + "@" + attr.name);
      }
    }
    return out;
  }

  it("把载荷塞进模型返回的每个字段后，DOM 结构与干净渲染完全一致", async () => {
    const PAYLOAD = 'x<img src="https://evil.example/p.png"><svg onload="window.__pwned=1"></svg>';

    // 基线：同样的页面与同样形状的结果，只是字段里没有载荷
    const base = bootHud("https://example.com/post/base", articleHtml(), {
      onRuntimeSendMessage: () => Promise.resolve({ ok: true, result: modelResult() })
    });
    await waitModel(base);

    const env = bootHud("https://example.com/post/xss-all", articleHtml(), {
      onRuntimeSendMessage: () =>
        Promise.resolve({
          ok: true,
          result: modelResult({
            model: PAYLOAD,
            reason: PAYLOAD,
            contentType: PAYLOAD,
            contentTypeKey: PAYLOAD,
            valueKey: PAYLOAD,
            value: PAYLOAD
          })
        })
    });
    await waitModel(env);

    const baseCounts = tagCounts(shadow(base));
    const envCounts = tagCounts(shadow(env));

    const diff = [];
    for (const t of new Set([...baseCounts.keys(), ...envCounts.keys()])) {
      const b = baseCounts.get(t) || 0;
      const e = envCounts.get(t) || 0;
      if (b !== e) diff.push(t + ": 基线 " + b + " → 载荷 " + e);
    }
    a.deepEqual(diff, [], "载荷改变了 DOM 结构（说明有内容被当成了 HTML 解析）");
    a.equal(env.win.__pwned, undefined, "注入的脚本不得执行");
    a.deepEqual(inlineHandlers(shadow(env)), [], "不得出现内联事件处理属性");
  });

  it("载荷落在错误消息里时同样不改变 DOM 结构", async () => {
    const PAYLOAD = '<img src="https://evil.example/p.png">';
    const env = bootHud("https://example.com/post/xss-err", articleHtml(), {
      onRuntimeSendMessage: () =>
        Promise.resolve({ ok: false, error: { code: "ERROR", message: PAYLOAD } })
    });
    await waitFor(() => shadow(env) && shadow(env).querySelector(".warn.err"), { label: "错误条出现" });

    const root = shadow(env);
    a.equal(root.querySelectorAll("img").length, 0, "错误条里不得出现 <img>");
    a.deepEqual(inlineHandlers(root), [], "不得出现内联事件处理属性");
  });
});
