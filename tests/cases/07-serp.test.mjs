/**
 * 搜索结果页标注（serp.js）。
 * 这段代码跑在别人的 HTML 里，选择器一变就静默失效，所以要把"识别 + 插入 + 汇总"都测住。
 */
import { describe, it } from "../harness/registry.mjs";
import * as a from "../harness/assert.mjs";
import { createEnv, loadContentScript, waitFor, sleep } from "../harness/env.mjs";

const CHIP = ".rs-serp-chip";

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
    a.equal(env.doc.querySelectorAll(CHIP).length, 0);
    a.equal(env.doc.getElementById("rs-serp-summary"), null);
    a.equal(env.chrome.__log.runtimeSendMessage.length, 0, "不该发任何评估请求");
  });

  it("关掉结果页标注后完全不动页面", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", GOOGLE_HTML, {
      store: { "rs.settings": { annotateSerp: false } }
    });
    await sleep(120);
    a.equal(env.doc.querySelectorAll(CHIP).length, 0);
    a.equal(env.chrome.__log.runtimeSendMessage.length, 0);
  });

  it("总开关关闭时也不动页面", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", GOOGLE_HTML, {
      store: { "rs.settings": { enabled: false } }
    });
    await sleep(120);
    a.equal(env.doc.querySelectorAll(CHIP).length, 0);
  });
});

describe("serp / Google 结果标注", () => {
  it("给每条自然结果插入徽章，并跳过站内链接", async () => {
    const env = bootSerp("https://www.google.com/search?q=manifest+v3", GOOGLE_HTML);
    await waitFor(() => env.doc.querySelectorAll(CHIP).length >= 2, { label: "徽章出现" });
    await sleep(60);
    a.equal(env.doc.querySelectorAll(CHIP).length, 2, "站内 google.com 链接不该被标注");
  });

  it("徽章插在标题前面，而不是覆盖标题", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", GOOGLE_HTML);
    await waitFor(() => env.doc.querySelectorAll(CHIP).length >= 1, { label: "徽章出现" });
    const h3 = env.doc.querySelector("#search .MjjYud h3");
    a.equal(h3.previousElementSibling.className, "rs-serp-chip", "徽章应是标题的前一个兄弟节点");
    a.includes(h3.textContent, "扩展开发官方文档", "标题本身不能被改动");
  });

  it("结果回来后徽章显示等级与可信度", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", GOOGLE_HTML);
    await waitFor(() => {
      const chips = [...env.doc.querySelectorAll(CHIP)];
      return chips.length >= 2 && chips.every((c) => c.dataset.state === "done");
    }, { label: "徽章填上结果" });

    const chips = [...env.doc.querySelectorAll(CHIP)];
    a.includes(chips[0].textContent, "值得认真读");
    a.includes(chips[0].textContent, "95%");
    a.includes(chips[1].textContent, "可以跳过");
    a.includes(chips[1].textContent, "0%");
    a.includes(chips[0].title, "相关度 97%");
    a.equal(chips[0].dataset.state, "done");
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
    await waitFor(() => env.doc.querySelectorAll(CHIP).length >= 2, { label: "徽章出现" });

    const first = env.doc.querySelector(CHIP);
    a.equal(first.textContent, "…", "结果回来之前先占位，不要空着");
    a.equal(first.dataset.state, "pending");

    release({ ok: false, error: { code: "NO_KEY", message: "尚未配置 TypeSafe API Key。" } });
    await waitFor(() => env.doc.querySelector(CHIP).dataset.state === "error", { label: "标记失败" });
    a.equal(env.doc.querySelector(CHIP).textContent, "未评估");
    a.includes(env.doc.querySelector(CHIP).title, "API Key");
  });

  it("扩展后台彻底联系不上时不抛未捕获异常", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", GOOGLE_HTML, {
      onRuntimeSendMessage: () => Promise.reject(new Error("Receiving end does not exist"))
    });
    await waitFor(() => env.doc.querySelectorAll(CHIP).length >= 2, { label: "徽章出现" });
    await sleep(80);
    a.equal(env.doc.querySelector(CHIP).dataset.state, "pending", "连不上后台时徽章停在占位态，不能崩");
  });
});

describe("serp / 其他引擎", () => {
  it("必应：li.b_algo + h2 a", async () => {
    const html = `<!doctype html><html><body><div id="b_results">
      <li class="b_algo"><h2><a href="https://developer.chrome.com/docs/extensions">扩展开发官方文档</a></h2>
        <div class="b_caption"><p>这一段摘要足够长，能通过脚本的长度检查。</p></div></li>
    </div></body></html>`;
    const env = bootSerp("https://www.bing.com/search?q=x", html);
    await waitFor(() => env.doc.querySelectorAll(CHIP).length >= 1, { label: "必应徽章出现" });
    a.includes(env.doc.querySelector(CHIP).textContent, "值得认真读");
  });

  it("DuckDuckGo：article[data-testid=result]", async () => {
    const html = `<!doctype html><html><body><div id="links">
      <article data-testid="result">
        <a data-testid="result-title-a" href="https://developer.chrome.com/docs/extensions">扩展开发官方文档</a>
        <div data-result="snippet">这一段摘要足够长，能通过脚本的长度检查。</div>
      </article>
    </div></body></html>`;
    const env = bootSerp("https://duckduckgo.com/?q=x", html);
    await waitFor(() => env.doc.querySelectorAll(CHIP).length >= 1, { label: "DDG 徽章出现" });
    a.includes(env.doc.querySelector(CHIP).textContent, "值得认真读");
  });

  it("结果容器里一条结果都没有时安静退出，不插汇总条", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", "<!doctype html><html><body><div id='search'></div></body></html>");
    await sleep(400);
    a.equal(env.doc.querySelectorAll(CHIP).length, 0);
    a.equal(env.doc.getElementById("rs-serp-summary"), null);
    env.win.close();
  });

  it("徽章样式自包含，不依赖宿主页 CSS", async () => {
    const env = bootSerp("https://www.google.com/search?q=x", GOOGLE_HTML);
    await waitFor(() => env.doc.querySelectorAll(CHIP).length >= 1, { label: "徽章出现" });
    const chip = env.doc.querySelector(CHIP);
    const css = chip.getAttribute("style");
    a.includes(css, "inline-flex");
    a.includes(css, "border-radius");
    a.includes(css, "background");
    a.gt(css.length, 200, "样式应写全，不能靠宿主页补");
  });
});
