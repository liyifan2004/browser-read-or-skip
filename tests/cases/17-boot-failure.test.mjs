/**
 * 浮层启动失败时必须有可查的原因。
 *
 * 以前是 `init().catch(() => {})` 加一个没有 try 的异步回调：extract 或
 * scorePage 抛一次错就等于 promise 静默 rejection —— 页面上什么都不出现，
 * 控制台没有一行日志，弹窗只会说「页面还没就绪」。这是最难查的一类失败：
 * 主流程看起来完全正常，只是功能不工作。
 */
import { describe, it } from "../harness/registry.mjs";
import * as a from "../harness/assert.mjs";
import { createEnv, evalRel, loadContentScript, loadLibs, readFile, waitFor, sleep } from "../harness/env.mjs";
import { dispatch } from "../harness/chrome-mock.mjs";

const LONG_CN = "这是一段用于测试的正文内容，长度足够让启发式打分认为它是一篇真实文章。".repeat(20);

function articleHtml() {
  return "<!doctype html><html lang='zh-CN'><head><title>一篇足够长的文章</title></head><body><article><p>" + LONG_CN + "</p></article></body></html>";
}

function shadow(env) {
  const host = env.doc.getElementById("read-or-skip-host");
  return host ? host.shadowRoot : null;
}

function askState(env) {
  return dispatch(env.chrome.__listeners.message, { type: "RS_GET_HUD_STATE" }, {});
}

function popupHtml() {
  return readFile("src/popup/popup.html").replace(/<script[^>]*><\/script>/g, "");
}

describe("hud / 启动失败", () => {
  it("抽取正文抛错：页面上留下带原因的卡片，而不是一片安静", async () => {
    const env = createEnv({
      url: "https://example.com/post/broken",
      html: articleHtml(),
      chromeOpts: { onRuntimeSendMessage: () => Promise.resolve({ ok: true, result: null }) }
    });
    loadContentScript(env, 0);
    // whenReady 还没到，先让抽取必然失败
    env.win.RS.extract.page = () => {
      throw new Error("抽取炸了");
    };

    await waitFor(() => shadow(env) && shadow(env).querySelector(".card"), { label: "错误卡片" });

    const root = shadow(env);
    a.equal(root.querySelector(".plabel").textContent, "出错", "角标要自报状态");
    a.includes(root.querySelector(".card").innerHTML, "浮层没能启动");
    a.includes(root.querySelector(".card").innerHTML, "抽取炸了", "卡片里要带原因");
    a.equal(root.querySelector(".pscore").textContent, "", "失败时不该显示分数（空页面算出来的是假数字）");
    a.equal(env.chrome.__log.runtimeSendMessage.length, 0, "没有正文就不该发评估请求，省 token");

    const st = await askState(env);
    a.equal(st.skipped, "error", "弹窗要能知道是启动失败");
    a.includes(st.error, "抽取炸了");
    a.equal(env.pageErrors.length, 0, "不该再有未捕获的 promise rejection");
  });

  it("读设置阶段抛错：不挂浮层（还不知道用户要不要），但状态里留下原因", async () => {
    const env = createEnv({ url: "https://example.com/post/x", html: articleHtml() });
    loadLibs(env, ["storage.js", "heuristics.js", "extract.js"]);
    env.win.RS.storage.getSettings = () => Promise.reject(new Error("存储读不了"));
    evalRel(env.win, "src/content/hud.js");

    await sleep(200);
    a.equal(env.doc.getElementById("read-or-skip-host"), null, "不知道自己该不该出现时不要出现");

    const st = await askState(env);
    a.equal(st.ok, true);
    a.equal(st.skipped, "error");
    a.includes(st.error, "存储读不了");
    a.equal(env.pageErrors.length, 0);
  });
});

describe("popup / 启动失败的说明", () => {
  it("把后台报来的原因显示出来，而不是只说「页面还没就绪」", async () => {
    const env = createEnv({
      url: "chrome-extension://readorskip/popup.html",
      html: popupHtml(),
      chromeOpts: {
        tabs: [{ id: 1, active: true, url: "https://example.com/post/broken" }],
        onTabsSendMessage: () => Promise.resolve({ ok: true, skipped: "error", error: "抽取炸了" })
      }
    });
    loadLibs(env, ["storage.js", "heuristics.js"]);
    evalRel(env.win, "src/popup/popup.js");

    await waitFor(() => !env.doc.getElementById("unsupported").hidden, { label: "说明区出现" });
    a.includes(env.doc.getElementById("utitle").textContent, "浮层没能启动");
    a.includes(env.doc.getElementById("udesc").textContent, "抽取炸了", "要给出具体原因");
    a.includes(env.doc.getElementById("udesc").textContent, "刷新", "要给出下一步动作");
    a.ok(env.doc.getElementById("card").hidden, "不该同时显示一份判定结果");
  });
});
