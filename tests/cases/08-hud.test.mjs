/**
 * 页面浮层（hud.js）。
 * 这是用户唯一直接看到的东西：挂载条件错了会"什么都不弹"，渲染错了会显示假数字。
 */
import { describe, it } from "../harness/registry.mjs";
import * as a from "../harness/assert.mjs";
import { createEnv, loadContentScript, waitFor, sleep } from "../harness/env.mjs";
import { dispatch } from "../harness/chrome-mock.mjs";

const LONG_CN = "这是一段用于测试的正文内容，长度足够让启发式打分认为它是一篇真实文章。".repeat(20);

function articleHtml(title = "浏览器扩展开发实战：Service Worker 生命周期") {
  return (
    "<!doctype html><html lang='zh-CN'><head><title>" +
    title +
    "</title><meta name='description' content='摘要'></head><body><article><h1>" +
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

function askState(env) {
  return dispatch(env.chrome.__listeners.message, { type: "RS_GET_HUD_STATE" }, {});
}

describe("hud / 挂载条件", () => {
  it("普通文章页：先出本地估算，模型结果到达后原地升级", async () => {
    // 用受控的 promise 卡住模型响应，才能稳定断言"阶段一"的界面
    let release;
    const pending = new Promise((r) => {
      release = r;
    });
    const env = bootHud("https://example.com/post/service-worker", articleHtml(), {
      onRuntimeSendMessage: () => pending
    });
    await waitFor(() => shadow(env), { label: "浮层挂载" });
    await waitFor(() => shadow(env).querySelector(".plabel").textContent === "估算中", {
      label: "进入本地估算态"
    });

    const root = shadow(env);
    a.ok(root.querySelector(".pill"), "应有角标");
    a.ok(root.querySelector(".card"), "应有卡片");
    a.includes(root.querySelector(".card").innerHTML, "本地估算", "本地估算必须自报来源，不能冒充模型结论");
    a.notIncludes(root.querySelector(".card").innerHTML, "jev", "模型还没回来就不该出现模型名");

    release({ ok: true, result: modelResult() });
    await waitFor(() => shadow(env).querySelector(".plabel").textContent === "值得读", {
      label: "升级为模型结论"
    });

    const root2 = shadow(env);
    a.notIncludes(root2.querySelector(".card").innerHTML, "本地估算", "升级后不该再显示本地估算");
    a.equal(root2.querySelector(".pscore").textContent, "88%", "综合分 = 94×.45 + 78×.3 + 88×.25");
    a.includes(root2.querySelector(".card").innerHTML, "相关度");
    a.includes(root2.querySelector(".card").innerHTML, "94%");
    a.includes(root2.querySelector(".card").innerHTML, "新信息程度");
    a.includes(root2.querySelector(".card").innerHTML, "78%");
    a.includes(root2.querySelector(".card").innerHTML, "可信度");
    a.includes(root2.querySelector(".card").innerHTML, "阅读价值");
    a.includes(root2.querySelector(".card").innerHTML, "值得认真读");
    a.equal(root2.querySelector(".warn"), null, "没有警告时不该出现警告条");
  });

  it("渲染在 Shadow DOM 里，宿主页拿不到样式、也污染不到它", async () => {
    const env = bootHud("https://example.com/post/x", articleHtml());
    await waitFor(() => shadow(env), { label: "浮层挂载" });
    const host = env.doc.getElementById("read-or-skip-host");
    a.ok(host.attachShadow === undefined || host.shadowRoot, "应使用 Shadow DOM");
    a.equal(env.doc.querySelector(".rs-pill"), null, "浮层元素不该出现在宿主文档树里");
    a.gt(shadow(env).querySelector("style").textContent.length, 1000, "样式应内联在 shadow 里");
  });

  it("搜索结果页让位给结果标注，不弹浮层", async () => {
    const env = bootHud("https://www.google.com/search?q=manifest+v3", "<!doctype html><html><body><div id='search'></div></body></html>");
    await sleep(150);
    a.equal(shadow(env), null, "结果页不该挂浮层");
    const st = await askState(env);
    a.equal(st.ok, true);
    a.equal(st.skipped, "serp", "应说明是「结果页交给标注脚本」");
    a.equal(env.chrome.__log.runtimeSendMessage.length, 0, "不该发评估请求，省 token");
  });

  it("关掉结果页标注后，结果页仍然弹浮层（否则两边都不管）", async () => {
    const env = bootHud("https://www.google.com/search?q=x", articleHtml(), {
      store: { "rs.settings": { annotateSerp: false } }
    });
    await waitFor(() => shadow(env), { label: "浮层挂载" });
    a.ok(shadow(env).querySelector(".pill"));
  });

  it("总开关关闭时完全不动", async () => {
    const env = bootHud("https://example.com/post/x", articleHtml(), {
      store: { "rs.settings": { enabled: false } }
    });
    await sleep(120);
    a.equal(shadow(env), null);
    a.equal((await askState(env)).skipped, "off");
  });

  it("浮层开关关闭时不挂载", async () => {
    const env = bootHud("https://example.com/post/x", articleHtml(), {
      store: { "rs.settings": { showHud: false } }
    });
    await sleep(120);
    a.equal(shadow(env), null);
    a.equal((await askState(env)).skipped, "off");
  });

  it("黑名单站点不挂载", async () => {
    const env = bootHud("https://mail.google.com/mail/u/0", articleHtml());
    await sleep(120);
    a.equal(shadow(env), null);
    a.equal((await askState(env)).skipped, "blocked");
  });

  it("登录页之类的非正文页不挂载", async () => {
    // 注意别用 /signin：那种路径会先命中站点黑名单，测不到"非正文页"这条分支
    const env = bootHud(
      "https://example.com/auth/step2",
      "<!doctype html><html><body><input type='password'><p>请继续验证</p></body></html>"
    );
    await sleep(150);
    a.equal(shadow(env), null);
    a.equal((await askState(env)).skipped, "not-readable");
  });
});

describe("hud / 内容与状态", () => {
  it("命中缓存时不发请求也能先给出结论", async () => {
    const url = "https://example.com/post/cached";
    const env = bootHud(url, articleHtml(), {
      store: {
        "rs.cache": {
          [url]: { at: Date.now(), partial: false, title: "缓存标题", result: modelResult({ relevance: 91 }) }
        }
      },
      onRuntimeSendMessage: () => Promise.resolve({ ok: true, result: modelResult({ relevance: 91 }), from: "cache" })
    });
    await waitFor(() => shadow(env), { label: "浮层挂载" });
    await waitFor(() => shadow(env).querySelector(".card").innerHTML.includes("91%"), { label: "渲染缓存结果" });
    a.ok(true);
  });

  it("重复度偏高时打出「可能没有太多新信息」警告", async () => {
    const env = bootHud("https://example.com/post/dup", articleHtml(), {
      onRuntimeSendMessage: () =>
        Promise.resolve({
          ok: true,
          result: modelResult({ warning: "redundant", redundancy: 0.72, reason: "⚠️ 可能没有太多新信息：与你已掌握的内容高度重复。" })
        })
    });
    await waitFor(() => shadow(env) && shadow(env).querySelector(".warn"), { label: "警告条出现" });
    a.includes(shadow(env).querySelector(".warn").textContent, "可能没有太多新信息");
  });

  it("模型置信度偏低时提示用户自己扫一眼", async () => {
    const env = bootHud("https://example.com/post/lowconf", articleHtml(), {
      onRuntimeSendMessage: () =>
        Promise.resolve({ ok: true, result: modelResult({ confidence: 0.31, lowConfidence: true }) })
    });
    await waitFor(() => shadow(env) && shadow(env).querySelector(".warn"), { label: "低置信提示出现" });
    a.includes(shadow(env).querySelector(".warn").textContent, "31%");
  });

  it("后台报错（未配置 Key）时展示原因，并给出前往设置的入口", async () => {
    const env = bootHud("https://example.com/post/nokey", articleHtml(), {
      onRuntimeSendMessage: () =>
        Promise.resolve({ ok: false, error: { code: "NO_KEY", message: "尚未配置 TypeSafe API Key。" } })
    });
    await waitFor(() => shadow(env) && shadow(env).querySelector(".warn.err"), { label: "错误条出现" });
    const box = shadow(env).querySelector(".warn.err");
    a.includes(box.textContent, "尚未配置");
    a.includes(box.textContent, "前往设置");
    box.querySelector("[data-act='options']").dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
    await waitFor(
      () => env.chrome.__log.runtimeSendMessage.some((m) => m && m.type === env.win.RS.MSG.OPEN_OPTIONS),
      { label: "发出打开设置的消息" }
    );
    a.ok(true);
  });

  it("后台彻底联系不上时降级保留本地估算，不白屏", async () => {
    const env = bootHud("https://example.com/post/ipc", articleHtml(), {
      onRuntimeSendMessage: () => Promise.reject(new Error("message port closed"))
    });
    await waitFor(() => shadow(env), { label: "浮层挂载" });
    await waitFor(() => shadow(env).querySelector(".warn.err"), { label: "错误条出现" });
    a.includes(shadow(env).querySelector(".warn.err").textContent, "无法连接");
    a.notEqual(shadow(env).querySelector(".plabel").textContent, "", "本地估算仍应可见");
  });

  it("卡片上的字段随后台返回的判定变化（跳过 → 灰蓝色系）", async () => {
    const env = bootHud("https://example.com/post/skip", articleHtml(), {
      onRuntimeSendMessage: () =>
        Promise.resolve({
          ok: true,
          result: modelResult({
            verdict: "skip",
            relevance: 12,
            novelty: 8,
            credibility: 30,
            value: "low",
            valueKey: "low",
            reason: "与当前关注方向关系不大。"
          })
        })
    });
    await waitFor(() => shadow(env).querySelector(".plabel").textContent === "可跳过", { label: "切到跳过" });
    a.includes(shadow(env).querySelector(".card").innerHTML, "可以跳过");
    a.includes(shadow(env).querySelector(".card").innerHTML, "低");
  });
});

describe("hud / 交互", () => {
  it("点角标能展开卡片，再点收起", async () => {
    // 把自动收起压到 60ms，才能在测试里稳定观察到"收起态"
    const env = bootHud("https://example.com/post/x", articleHtml(), {
      store: { "rs.settings": { hudAutoCollapseMs: 60 } }
    });
    await waitFor(() => shadow(env) && shadow(env).querySelector(".pill").style.display === "flex", {
      label: "自动收起到角标"
    });
    const root = shadow(env);
    root.querySelector(".pill").dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
    a.equal(root.querySelector(".card").style.display, "block", "点击后卡片应可见");
    root.querySelector(".pill").dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
    a.equal(root.querySelector(".card").style.display, "none", "再点应收起");
  });

  it("Alt+Shift+R 能开关浮层", async () => {
    const env = bootHud("https://example.com/post/x", articleHtml());
    await waitFor(() => shadow(env), { label: "浮层挂载" });
    const before = shadow(env).querySelector(".card").style.display;
    env.doc.dispatchEvent(new env.win.KeyboardEvent("keydown", { key: "R", altKey: true, shiftKey: true, bubbles: true }));
    await sleep(30);
    a.notEqual(shadow(env).querySelector(".card").style.display, before, "快捷键应切换展开状态");
  });

  it("收到强制刷新消息会重新走一次评估", async () => {
    let calls = 0;
    const env = bootHud("https://example.com/post/refresh", articleHtml(), {
      onRuntimeSendMessage: () => {
        calls++;
        return Promise.resolve({ ok: true, result: modelResult() });
      }
    });
    await waitFor(() => calls >= 1, { label: "首次评估" });
    const res = await dispatch(env.chrome.__listeners.message, { type: "RS_FORCE_REFRESH" }, {});
    a.equal(res.ok, true);
    await waitFor(() => calls >= 2, { label: "刷新后再次评估" });
    a.gte(calls, 2);
  });

  it("点「重新评估」会带上 force 标记", async () => {
    const seen = [];
    const env = bootHud("https://example.com/post/force", articleHtml(), {
      onRuntimeSendMessage: (msg) => {
        seen.push(msg);
        return Promise.resolve({ ok: true, result: modelResult() });
      }
    });
    await waitFor(() => shadow(env) && shadow(env).querySelector("[data-act='refresh']"), { label: "按钮出现" });
    shadow(env)
      .querySelector("[data-act='refresh']")
      .dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
    await waitFor(() => seen.some((m) => m.payload && m.payload.force), { label: "带 force 的请求" });
    a.ok(true);
  });

  it("关闭后可以通过强制刷新恢复，且自始至终只有一个浮层", async () => {
    const env = bootHud("https://example.com/post/recover", articleHtml());
    await waitFor(() => shadow(env) && shadow(env).querySelector("[data-act='close']"), { label: "关闭按钮出现" });
    shadow(env)
      .querySelector("[data-act='close']")
      .dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
    a.includes(shadow(env).querySelector(".wrap").className, "hidden");

    await dispatch(env.chrome.__listeners.message, { type: "RS_FORCE_REFRESH" }, {});
    await sleep(60);
    a.notIncludes(shadow(env).querySelector(".wrap").className, "hidden", "强制刷新应让浮层回来");
    a.equal(env.doc.querySelectorAll("#read-or-skip-host").length, 1, "任何操作都不该挂出第二个浮层");
  });

  it("关闭按钮让浮层消失", async () => {
    const env = bootHud("https://example.com/post/x", articleHtml());
    await waitFor(() => shadow(env) && shadow(env).querySelector("[data-act='close']"), { label: "关闭按钮出现" });
    shadow(env)
      .querySelector("[data-act='close']")
      .dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
    a.includes(shadow(env).querySelector(".wrap").className, "hidden");
  });

  it("发送给后台的 state 带上关注主题与正文", async () => {
    let payload = null;
    const env = bootHud("https://example.com/post/state", articleHtml(), {
      onRuntimeSendMessage: (msg) => {
        payload = msg.payload;
        return Promise.resolve({ ok: true, result: modelResult() });
      }
    });
    await waitFor(() => payload, { label: "请求发出" });
    a.equal(payload.page.url, "https://example.com/post/state");
    a.isString(payload.state.content);
    a.gt(payload.state.content.length, 100, "默认应发送正文摘录");
    a.isArray(payload.state.focusTopics);
    a.notIncludes(JSON.stringify(payload.state), "undefined");
  });
});
