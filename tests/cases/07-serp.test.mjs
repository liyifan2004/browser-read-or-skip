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

  it("徽章宿主在标题 <a> 内部且紧邻 <h3>（回到行内位置，与标题同一行）", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", GOOGLE_HTML);
    await waitFor(() => chipEls(env).length >= 1, { label: "徽章出现" });
    const h3 = env.doc.querySelector("#search .MjjYud h3");
    const anchor = h3.closest("a");
    const host = h3.previousElementSibling;
    a.ok(host && host.classList.contains("rs-serp-host"), "宿主应是 <h3> 的前一个兄弟元素");
    a.equal(host.parentNode, anchor, "宿主必须在标题 <a> 内部（行内位置，徽章与标题同一行）");
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
    a.ok(pageStyle, "页面级样式节点应注入（汇总条用）");
    a.includes(pageStyle.textContent, "#rs-serp-summary");
    a.ok(!pageStyle.textContent.includes(CHIP.slice(1)), "页面级样式不得残留徽章选择器（徽章规则只在 shadow 内）");

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
