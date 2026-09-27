/**
 * 搜索结果页标注（serp.js）。
 * 这段代码跑在别人的 HTML 里，选择器一变就静默失效，所以要把"识别 + 插入 + 汇总"都测住。
 * 徽章本体渲染在每个宿主的 shadow root 里（jsdom 支持 attachShadow，参考 08-hud），
 * light DOM 里只能看到 .rs-serp-host 宿主元素——查询一律走 hostEls / chipEls 助手。
 */
import { describe, it } from "../harness/registry.mjs";
import * as a from "../harness/assert.mjs";
import { createEnv, loadContentScript, waitFor, sleep } from "../harness/env.mjs";

const CHIP = ".rs-serp-chip";
const HOST = ".rs-serp-host";

/** light DOM 里的宿主元素 */
function hostEls(env) {
  return [...env.doc.querySelectorAll(HOST)];
}

/** shadow root 里的徽章本体（light DOM 查不到，必须经 host.shadowRoot） */
function chipEls(env) {
  const out = [];
  for (const h of hostEls(env)) {
    const c = h.shadowRoot && h.shadowRoot.querySelector(CHIP);
    if (c) out.push(c);
  }
  return out;
}

const GOOGLE_HTML = `<!doctype html><html><body>
<div id="search">
  <div class="MjjYud">
    <a href="https://developer.chrome.com/docs/extensions"><h3>扩展开发官方文档：Service Worker 生命周期</h3></a>
    <div class="VwiC3b">这一条摘要的内容足够长，能通过脚本里的长度检查。</div>
  </div>
  <div class="MjjYud">
    <a href="https://baijiahao.baidu.com/s?id=1"><h3>2026 年必装的十个 AI 神器</h3></a>
    <div class="VwiC3b">另一条结果的摘要内容也足够长，能通过检查。</div>
  </div>
  <div class="MjjYud">
    <a href="https://www.google.com/preferences"><h3>搜索引擎自己的站内链接</h3></a>
    <div class="VwiC3b">站内链接不应该被标注，这条摘要够长。</div>
  </div>
</div>
</body></html>`;

const RESULT_MAP = {
  "https://developer.chrome.com/docs/extensions": { verdict: "read", relevance: 97, credibility: 95, kind: "serp" },
  "https://baijiahao.baidu.com/s?id=1": { verdict: "skip", relevance: 21, credibility: 0, kind: "serp" }
};

function bootSerp(url, html, chromeOpts = {}) {
  const env = createEnv({
    url,
    html,
    chromeOpts: Object.assign(
      { onRuntimeSendMessage: () => Promise.resolve({ ok: true, results: RESULT_MAP }) },
      chromeOpts
    )
  });
  loadContentScript(env, 1);
  return env;
}

describe("serp / 页面识别", () => {
  it("非搜索结果页不注入任何元素", async () => {
    const env = bootSerp("https://example.com/article", GOOGLE_HTML);
    await sleep(120);
    a.equal(hostEls(env).length, 0);
    a.equal(env.doc.getElementById("rs-serp-summary"), null);
    a.equal(env.chrome.__log.runtimeSendMessage.length, 0, "不该发任何评估请求");
  });

  it("关掉结果页标注后完全不动页面", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", GOOGLE_HTML, {
      store: { "rs.settings": { annotateSerp: false } }
    });
    await sleep(120);
    a.equal(hostEls(env).length, 0);
    a.equal(env.chrome.__log.runtimeSendMessage.length, 0);
  });

  it("总开关关闭时也不动页面", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", GOOGLE_HTML, {
      store: { "rs.settings": { enabled: false } }
    });
    await sleep(120);
    a.equal(hostEls(env).length, 0);
  });
});

describe("serp / Google 结果标注", () => {
  it("给每条自然结果插入徽章，并跳过站内链接", async () => {
    const env = bootSerp("https://www.google.com/search?q=manifest+v3", GOOGLE_HTML);
    await waitFor(() => chipEls(env).length >= 2, { label: "徽章出现" });
    await sleep(60);
    a.equal(chipEls(env).length, 2, "站内 google.com 链接不该被标注");
  });

  it("徽章必须在自己的 shadow root 里，light DOM 查不到（防回归契约）", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", GOOGLE_HTML);
    await waitFor(() => chipEls(env).length >= 1, { label: "徽章出现" });
    a.equal(env.doc.querySelectorAll(CHIP).length, 0, "light DOM 不应有 .rs-serp-chip：宿主页 CSS 能选中 light DOM 元素");
    const host = hostEls(env)[0];
    a.ok(host.shadowRoot, "宿主元素应挂着 shadow root");
    a.equal(host.shadowRoot.mode, "open", "测试与诊断需要 open 模式");
    a.ok(host.shadowRoot.querySelector(CHIP), "徽章本体应在 shadow root 里");
  });

  it("徽章宿主是标题元素的第一个子节点（嵌入流，与标题文字同一行）", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", GOOGLE_HTML);
    await waitFor(() => chipEls(env).length >= 1, { label: "徽章出现" });
    const h3 = env.doc.querySelector("#search .MjjYud h3");
    const host = h3.firstElementChild;
    a.ok(host && host.classList.contains("rs-serp-host"), "宿主应是标题元素的第一个子节点");
    a.equal(h3.firstChild, host, "宿主必须是第一个子节点（徽章紧跟标题文字行内渲染）");
    const anchor = h3.closest("a");
    a.ok(anchor && anchor.contains(host), "宿主必须仍在标题 <a> 内部");
    a.includes(h3.textContent, "扩展开发官方文档", "标题本身不能被改动");
  });

  it("结果回来后徽章显示等级与可信度，宿主上也带同样的提示", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", GOOGLE_HTML);
    await waitFor(() => {
      const chips = chipEls(env);
      return chips.length >= 2 && chips.every((c) => c.dataset.state === "done");
    }, { label: "徽章填上结果" });

    const chips = chipEls(env);
    a.includes(chips[0].textContent, "值得认真读");
    a.includes(chips[0].textContent, "95%");
    a.includes(chips[1].textContent, "可以跳过");
    a.includes(chips[1].textContent, "0%");
    a.includes(chips[0].title, "相关度 97%");
    a.equal(chips[0].dataset.state, "done");
    a.equal(chips[0].title, hostEls(env)[0].title, "宿主元素上应有一份相同的 title（悬停宿主也能看到提示）");
  });

  it("请求体只带标题 / URL / 摘要，且标明引擎与查询词", async () => {
    const env = bootSerp("https://www.google.com/search?q=manifest+v3", GOOGLE_HTML);
    await waitFor(() => env.chrome.__log.runtimeSendMessage.length >= 1, { label: "发出请求" });
    const msg = env.chrome.__log.runtimeSendMessage[0];
    a.equal(msg.type, env.win.RS.MSG.EVALUATE_SERP);
    a.equal(msg.payload.engine, "google");
    a.equal(msg.payload.query, "manifest v3");
    a.equal(msg.payload.items.length, 2);
    for (const item of msg.payload.items) {
      a.isString(item.url);
      a.isString(item.title);
      a.isString(item.snippet);
      a.notIncludes(JSON.stringify(item), "undefined");
    }
  });

  it("顶部汇总条统计各等级数量", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", GOOGLE_HTML);
    await waitFor(() => {
      const bar = env.doc.getElementById("rs-serp-summary");
      return bar && bar.textContent.includes("共 2 条");
    }, { label: "汇总条出现" });

    const bar = env.doc.getElementById("rs-serp-summary");
    a.includes(bar.textContent, "值得读 1");
    a.includes(bar.textContent, "可跳过 1");
    a.includes(bar.textContent, "可扫 0");
    a.ok(env.doc.querySelector("#search").firstElementChild === bar, "汇总条应插在结果列表最前面");
  });

  it("评估失败时徽章标注『未评估』并带上原因", async () => {
    let release;
    const pending = new Promise((r) => {
      release = r;
    });
    const env = bootSerp("https://www.google.com/search?q=x", GOOGLE_HTML, {
      onRuntimeSendMessage: () => pending
    });
    await waitFor(() => chipEls(env).length >= 2, { label: "徽章出现" });

    const first = chipEls(env)[0];
    a.equal(first.textContent, "…", "结果回来之前先占位，不要空着");
    a.equal(first.dataset.state, "pending");

    release({ ok: false, error: { code: "NO_KEY", message: "尚未配置 TypeSafe API Key。" } });
    await waitFor(() => chipEls(env)[0].dataset.state === "error", { label: "标记失败" });
    a.equal(chipEls(env)[0].textContent, "未评估");
    a.includes(chipEls(env)[0].title, "API Key");
  });

  it("扩展后台彻底联系不上时不抛未捕获异常", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", GOOGLE_HTML, {
      onRuntimeSendMessage: () => Promise.reject(new Error("Receiving end does not exist"))
    });
    await waitFor(() => chipEls(env).length >= 2, { label: "徽章出现" });
    await sleep(80);
    a.equal(chipEls(env)[0].dataset.state, "pending", "连不上后台时徽章停在占位态，不能崩");
  });
});

describe("serp / 其他引擎", () => {
  it("必应：li.b_algo + h2 a", async () => {
    const html = `<!doctype html><html><body><div id="b_results">
      <li class="b_algo"><h2><a href="https://developer.chrome.com/docs/extensions">扩展开发官方文档</a></h2>
        <div class="b_caption"><p>这一段摘要足够长，能通过脚本的长度检查。</p></div></li>
    </div></body></html>`;
    const env = bootSerp("https://www.bing.com/search?q=x", html);
    await waitFor(() => chipEls(env).length >= 1, { label: "必应徽章出现" });
    a.includes(chipEls(env)[0].textContent, "值得认真读");
  });

  it("DuckDuckGo：article[data-testid=result]", async () => {
    const html = `<!doctype html><html><body><div id="links">
      <article data-testid="result">
        <a data-testid="result-title-a" href="https://developer.chrome.com/docs/extensions">扩展开发官方文档</a>
        <div data-result="snippet">这一段摘要足够长，能通过脚本的长度检查。</div>
      </article>
    </div></body></html>`;
    const env = bootSerp("https://duckduckgo.com/?q=x", html);
    await waitFor(() => chipEls(env).length >= 1, { label: "DDG 徽章出现" });
    a.includes(chipEls(env)[0].textContent, "值得认真读");
  });

  it("结果容器里一条结果都没有时安静退出，不插汇总条", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", "<!doctype html><html><body><div id='search'></div></body></html>");
    await sleep(400);
    a.equal(hostEls(env).length, 0);
    a.equal(env.doc.getElementById("rs-serp-summary"), null);
    env.win.close();
  });

  it("徽章样式跑在 shadow 里，页面级样式只留汇总条、不残留徽章选择器", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", GOOGLE_HTML);
    await waitFor(() => chipEls(env).length >= 1, { label: "徽章出现" });

    const pageStyle = env.doc.getElementById("rs-serp-style");
    a.ok(pageStyle, "页面级样式节点应注入（汇总条 + 宿主防御块用）");
    a.includes(pageStyle.textContent, "#rs-serp-summary");
    a.ok(!pageStyle.textContent.includes(CHIP.slice(1)), "页面级样式不得残留徽章选择器（徽章规则只在 shadow 内）");

    // 第五轮：宿主回嵌入流。双类选择器提高特异性，压过 a > span 这类元素选择器；
    // 这类规则操作 light DOM 里的宿主本身，只能放在页面级样式里。
    a.includes(pageStyle.textContent, ".rs-serp-host.rs-serp-host",
      "页面级样式必须含 .rs-serp-host 双类防御块（宿主元素本身在 light DOM）");
    for (const decl of ["display: contents !important", "transform: none !important",
      "scale: none !important", "rotate: none !important", "translate: none !important",
      "filter: none !important"]) {
      a.includes(pageStyle.textContent, decl, "页面级宿主防御块缺少 " + decl);
    }

    const shadowStyle = hostEls(env)[0].shadowRoot.querySelector("style");
    a.ok(shadowStyle, "徽章样式应内联在 shadow root 里");
    const css = shadowStyle.textContent;
    a.includes(css, ":host");
    a.includes(css, "all: initial", ":host 必须 all: initial 起手（hud.js 同款）");
    a.includes(css, "inline-flex");
    a.includes(css, "border-radius");
    a.includes(css, "background");
    a.gt(css.length, 200, "样式应写全，不能靠宿主页补");

    const chip = chipEls(env)[0];
    a.includes(chip.className, "rs-serp-chip");
    a.includes(chip.className, "rs-lt", "jsdom 拿不到背景色，应落到浅色主题（且类名带 rs- 前缀）");
    a.includes(css, ".rs-serp-chip.rs-lt", "主题类改成 rs- 前缀，避免撞上宿主页短类名");
  });

  it("注入的徽章样式含 transform 族独立属性与 filter 的防御（上一轮翻转修复的盲区）", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", GOOGLE_HTML);
    await waitFor(() => chipEls(env).length >= 1, { label: "徽章出现" });
    const css = hostEls(env)[0].shadowRoot.querySelector("style").textContent;
    // scale / rotate / translate 是 CSS Transforms Level 2 的独立属性，
    // transform: none 压不住它们——正是 Google 深色页翻转的根因，必须显式否定
    a.includes(css, "transform: none !important");
    a.includes(css, "scale: none !important");
    a.includes(css, "rotate: none !important");
    a.includes(css, "translate: none !important");
    a.includes(css, "filter: none !important", "invert 类滤镜同样会翻转视觉，一并防御");
    a.includes(css, "unicode-bidi: isolate !important");
    a.includes(css, "writing-mode: horizontal-tb !important");
    // :host 与 .rs-serp-chip 两处都要有防御（宿主自身也可能被 a > span 规则命中）
    const hostBlock = css.slice(0, css.indexOf("}") + 1);
    for (const prop of ["transform", "scale", "rotate", "translate", "filter"]) {
      a.includes(hostBlock, prop + ": none !important", ":host 块里缺少 " + prop + " 防御");
    }
    a.includes(hostBlock, "display: contents !important",
      ":host 必须 display: contents（宿主不生成盒子，外部 transform 类规则无从作用）");
    a.ok(!css.includes("inline-block") || !css.split(":host")[1].split("}")[0].includes("inline-block"),
      ":host 不得再生成盒子（display: inline-block 已废弃）");
  });

  it("评估结果带等级属性与非颜色线索", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", GOOGLE_HTML);
    await waitFor(() => {
      const chips = chipEls(env);
      return chips.length >= 2 && chips.every((c) => c.dataset.state === "done");
    }, { label: "徽章填上结果" });
    const chips = chipEls(env);
    a.equal(chips[0].dataset.v, "read");
    a.equal(chips[0].dataset.marker, "dot-solid", "值得读档的线索应是实心点");
    a.equal(chips[1].dataset.v, "skip");
    a.equal(chips[1].dataset.marker, "dash", "可跳过档的线索应是短横");
  });
});

describe("serp / 宿主样式审计（取证不切换布局）", () => {
  /* 祖先带 transform 的结果块：模拟 Google 深色页上命中徽章祖先的那条翻转规则。
     jsdom 的 getComputedStyle 返回值有限，测试里对污染元素 stub 是正常做法。 */
  const POLLUTED_HTML = `<!doctype html><html><body>
<div id="search">
  <div class="rs-pollute" style="transform: rotate(180deg)">
    <div class="MjjYud">
      <a href="https://developer.chrome.com/docs/extensions"><h3>扩展开发官方文档：Service Worker 生命周期</h3></a>
      <div class="VwiC3b">这一条摘要的内容足够长，能通过脚本里的长度检查。</div>
    </div>
  </div>
</div>
</body></html>`;

  /** stub getComputedStyle：onlyEl 命中时返回 overrides（普通对象即可，脚本按属性名读取），其余走 jsdom 默认 */
  function stubComputedStyle(env, onlyEl, overrides) {
    const real = env.win.getComputedStyle.bind(env.win);
    env.win.getComputedStyle = (el, ...rest) => {
      if (el === onlyEl) return overrides;
      return real(el, ...rest);
    };
    return real;
  }

  /** 拦截 window.console.warn，供断言审计告警 */
  function trapWarn(env) {
    const warns = [];
    env.win.console.warn = (...args) => warns.push(args);
    return warns;
  }

  it("审计发现污染只取证不切换：徽章留在嵌入流，结论写进 title 与 console.warn", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", POLLUTED_HTML);
    const warns = trapWarn(env);
    const polluted = env.doc.querySelector(".rs-pollute");
    stubComputedStyle(env, polluted, { transform: "rotate(180deg)" });

    await waitFor(() => hostEls(env).length >= 1 && hostEls(env)[0].dataset.rsAudit, { label: "审计结论写入" });

    const host = hostEls(env)[0];
    const h3 = env.doc.querySelector("#search .MjjYud h3");
    a.ok(!host.classList.contains("rs-serp-overlay"), "overlay 模式已撤销：不得出现 rs-serp-overlay 类");
    a.equal(host.parentNode, h3, "发现污染也不得改变布局：宿主必须留在标题内部（嵌入流）");
    a.equal(h3.firstChild, host, "宿主必须仍是标题的第一个子节点");
    a.ok(!host.style.position && !host.style.zIndex, "不得出现绝对定位 / 高 z-index 的 overlay 痕迹");
    a.equal(env.doc.querySelectorAll("body > .rs-serp-host").length, 0,
      "宿主不得被 body 收养浮在顶层盖住页面内容");

    a.ok(warns.length >= 1, "发现污染必须 console.warn 完整清单");
    a.includes(JSON.stringify(warns), "rotate(180deg)", "告警里应带上实际污染值");

    // 审计不切换布局，评估照常写进 shadow 内的 chip
    await waitFor(() => chipEls(env).length >= 1 && chipEls(env)[0].dataset.state === "done", { label: "徽章填上结果" });
    a.includes(chipEls(env)[0].textContent, "值得认真读", "取证模式下 paintChip 必须继续生效");
  });

  it("无污染时维持文档流：宿主留在标题 <a> 内部，不告警不切 overlay", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", GOOGLE_HTML);
    const warns = trapWarn(env);
    stubComputedStyle(env, null, {}); // 全部走 jsdom 默认

    await waitFor(() => chipEls(env).length >= 2, { label: "徽章出现" });
    await sleep(60); // 给挂载后的审计 setTimeout 留一帧

    const host = hostEls(env)[0];
    const h3 = env.doc.querySelector("#search .MjjYud h3");
    a.equal(host.parentNode, h3, "无污染的徽章必须留在标题内部（零回归）");
    a.ok(!host.classList.contains("rs-serp-overlay"), "任何情况下都不得出现 overlay 类（overlay 已撤销）");
    a.equal(host.dataset.rsAudit, undefined, "无污染不应写审计结论");
    a.equal(warns.length, 0, "无污染不应 console.warn");
  });

  it("审计结论写进宿主 title，悬停可见，且评估结果回来后不被冲掉", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", POLLUTED_HTML);
    const polluted = env.doc.querySelector(".rs-pollute");
    stubComputedStyle(env, polluted, { transform: "rotate(180deg)" });

    await waitFor(() => hostEls(env).length >= 1 && hostEls(env)[0].dataset.rsAudit, { label: "审计结论写入" });
    const host = hostEls(env)[0];
    a.includes(host.title, "样式被宿主页改写", "审计结论必须写进宿主 title（悬停可见）");
    // 宿主嵌在 <h3> 内部：host→h3→a→.MjjYud→.rs-pollute，污染元素在 depth4
    a.includes(host.title, "depth4 div.rs-pollute transform=rotate(180deg)", "结论应含深度 / 标签 / 类名 / 属性 / 实际值");

    await waitFor(() => chipEls(env)[0].dataset.state === "done", { label: "徽章填上结果" });
    a.includes(host.title, "样式被宿主页改写", "paintChip 不得冲掉审计结论");
    a.includes(host.title, "相关度 97%", "评估 tooltip 也要在同一份 title 里");
  });

});

describe("serp / QA 第五轮固化契约（嵌入流与审计边界）", () => {
  /**
   * 模拟真实浏览器级联了自家防御 CSS 的计算样式：我们的 SERP_CSS 给 chip 与宿主
   * 都写了 unicode-bidi: isolate !important（serp.js 的 :host 与 .rs-serp-chip 块）。
   * jsdom 不会把 shadow 样式表算进 getComputedStyle，所以这里按类名 stub 出真实
   * 浏览器会返回的值，用来守住「自家防御值不得被审计当成宿主页污染」这条边界。
   */
  function stubOwnDefenseStyles(env) {
    const real = env.win.getComputedStyle.bind(env.win);
    env.win.getComputedStyle = (el, ...rest) => {
      const cls = el && el.classList;
      if (cls && (cls.contains("rs-serp-chip") || cls.contains("rs-serp-host"))) {
        return { "unicode-bidi": "isolate" };
      }
      return real(el, ...rest);
    };
  }

  it("契约：自家防御值（unicode-bidi: isolate）不得被审计判为污染，无污染页不得切 overlay", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", GOOGLE_HTML);
    const warns = [];
    env.win.console.warn = (...args) => warns.push(args);
    stubOwnDefenseStyles(env);

    await waitFor(() => chipEls(env).length >= 1, { label: "徽章出现" });
    await sleep(80); // 审计的 setTimeout 一帧 + 余量

    const host = hostEls(env)[0];
    a.ok(!host.classList.contains("rs-serp-overlay"),
      "自家 :host/.rs-serp-chip 里的 unicode-bidi: isolate 是防御值，不是宿主页污染——不得误报");
    a.equal(host.dataset.rsAudit, undefined, "自家防御值不得写进审计结论");
    a.equal(warns.length, 0, "自家防御值不得触发 console.warn");
    a.equal(host.parentNode, env.doc.querySelector("#search h3"), "零回归：徽章应留在标题内部（嵌入流）");
  });

  it("契约：翻页（URL 变化）后旧徽章宿主必须被清理，且新页不重复挂载", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", GOOGLE_HTML);
    await waitFor(() => hostEls(env).length >= 1, { label: "徽章出现" });
    const oldHosts = hostEls(env);
    a.ok(oldHosts.length >= 1, "前置：第一页已挂载徽章");
    for (const h of oldHosts) {
      a.equal(h.parentNode.tagName, "H3", "前置：徽章宿主挂在标题元素内部（嵌入流）");
    }

    // 模拟搜索翻页：SPA 式改 URL + 结果容器变动（触发 MutationObserver 防抖清理）
    env.win.history.pushState({}, "", "/search?q=page2");
    env.doc.querySelector("#search").appendChild(env.doc.createElement("div"));
    await sleep(700); // 400ms 防抖 + 清理 + 重扫 + 新徽章审计

    for (const h of oldHosts) {
      a.ok(!h.isConnected, "翻页后旧徽章宿主必须从文档移除（清理是全局查询）");
    }
    a.equal(hostEls(env).length, oldHosts.length,
      "翻页后只保留新页的徽章宿主，不得重复挂载");
    a.equal(env.doc.querySelectorAll("body > .rs-serp-host").length, 0,
      "overlay 模式已撤销：任何宿主都不得被 body 收养");
  });

  it("契约：审计基线必须等于自家防御 CSS 的计算值（防再脱节）", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", GOOGLE_HTML);

    // 这张表 = 我们的防御 CSS 在真实浏览器里给 chip / host 产生的计算值。
    // 它必须与 shadow 样式表逐项一致（下方静态断言），也必须与 serp.js 的审计基线一致：
    // 任何一边改了另一边不同步，这条用例就红灯。
    const OWN_COMPUTED = {
      transform: "none", scale: "none", rotate: "none", translate: "none",
      filter: "none", "backdrop-filter": "none",
      "writing-mode": "horizontal-tb", direction: "ltr",
      "text-orientation": "mixed", "unicode-bidi": "isolate"
    };
    const real = env.win.getComputedStyle.bind(env.win);
    env.win.getComputedStyle = (el, ...rest) => {
      const cls = el && el.classList;
      if (cls && (cls.contains("rs-serp-chip") || cls.contains("rs-serp-host"))) {
        return Object.assign({}, OWN_COMPUTED);
      }
      return real(el, ...rest);
    };
    const warns = [];
    env.win.console.warn = (...args) => warns.push(args);

    await waitFor(() => chipEls(env).length >= 2, { label: "徽章出现" });
    await sleep(80); // 审计的 setTimeout 一帧 + 余量

    // 静态契约：shadow 样式表的防御声明必须与上面这张表逐项一致
    // （backdrop-filter / text-orientation 未防御，chip 计算值取规范初始值，不在表内）
    const css = hostEls(env)[0].shadowRoot.querySelector("style").textContent;
    for (const [prop, val] of Object.entries(OWN_COMPUTED)) {
      if (prop === "backdrop-filter" || prop === "text-orientation") continue;
      a.includes(css, prop + ": " + val + " !important",
        "防御 CSS 应声明 " + prop + ": " + val + "（审计基线与其耦合，改一边必须同步另一边）");
    }

    const host = hostEls(env)[0];
    a.ok(!host.classList.contains("rs-serp-overlay"), "chip / host 全部命中自家防御值时不得判为污染");
    a.equal(warns.length, 0, "自家防御值不得触发告警");
    a.equal(host.dataset.rsAudit, undefined, "自家防御值不得写进审计结论");
    a.equal(host.parentNode, env.doc.querySelector("#search h3"), "零回归：徽章留在标题内部（嵌入流）");
  });

  it("契约：RTL 语言页祖先 direction=rtl 是合法排版，不得误判为污染", async () => {
    // 模拟阿拉伯语 / 希伯来语搜索页：documentElement 与结果容器 direction=rtl，
    // 无任何 transform 族污染——祖先链基线应随文档根方向自适应，不得切 overlay
    const env = bootSerp("https://www.google.com/search?q=x", GOOGLE_HTML);
    const real = env.win.getComputedStyle.bind(env.win);
    env.win.getComputedStyle = (el, ...rest) => {
      if (el === env.doc.documentElement) return { direction: "rtl" };
      if (el && el.classList && el.classList.contains("MjjYud")) return { direction: "rtl" };
      return real(el, ...rest);
    };
    const warns = [];
    env.win.console.warn = (...args) => warns.push(args);

    await waitFor(() => chipEls(env).length >= 2, { label: "徽章出现" });
    await sleep(80); // 审计一帧 + 余量

    const host = hostEls(env)[0];
    a.ok(!host.classList.contains("rs-serp-overlay"), "RTL 页祖先 direction=rtl 不得触发任何布局切换");
    a.equal(host.dataset.rsAudit, undefined, "RTL 合法排版不得写进审计结论");
    a.equal(warns.length, 0, "RTL 合法排版不得告警");
    a.equal(host.parentNode, env.doc.querySelector("#search h3"), "RTL 页徽章留在标题内部（嵌入流）");
  });

  it("契约：审计只在徽章插入时跑一次，重扫与 resize 不重复触发审计（性能边界）", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", GOOGLE_HTML);
    let gcsCalls = 0;
    const real = env.win.getComputedStyle.bind(env.win);
    env.win.getComputedStyle = (el, ...rest) => {
      gcsCalls++;
      return real(el, ...rest);
    };

    await waitFor(() => chipEls(env).length >= 2, { label: "徽章出现" });
    await sleep(80); // 等两枚徽章的审计各跑一帧
    const afterAudit = gcsCalls;
    a.ok(afterAudit > 0, "前置：插入阶段确实执行了审计");

    // 重扫（防抖回调）与 resize 都不得再跑审计（取证只在徽章插入时执行一次）
    env.doc.querySelector("#search").appendChild(env.doc.createElement("div"));
    await sleep(650);
    env.win.dispatchEvent(new env.win.Event("resize"));
    await sleep(50);

    a.equal(gcsCalls, afterAudit, "审计只发生在插入时：MutationObserver 重扫与 resize 不得反复读取祖先链计算样式");
  });
});
