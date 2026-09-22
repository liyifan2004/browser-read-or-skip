/**
 * popup 的「解除屏蔽」可逆入口。
 * 用户误点 HUD 的「屏蔽此站」必须有退路：黑名单里有当前站点时，
 * 弹窗显示一行「此站点已跳过评估」+ 解除按钮，点击后从黑名单移除并给出反馈。
 */
import { describe, it } from "../harness/registry.mjs";
import * as a from "../harness/assert.mjs";
import { createEnv, evalRel, loadLibs, readFile, waitFor, sleep } from "../harness/env.mjs";

function popupHtml() {
  // 去掉 <script> 标签：jsdom outside-only 模式不会执行它们，留着反而污染文档
  return readFile("src/popup/popup.html").replace(/<script[^>]*><\/script>/g, "");
}

function bootPopup(opts = {}) {
  const env = createEnv({
    url: "chrome-extension://readorskip/popup.html",
    html: popupHtml(),
    chromeOpts: {
      tabs: opts.tabs || [{ id: 1, active: true, url: "https://example.com/article" }],
      store: opts.store || {},
      onTabsSendMessage:
        opts.onTabsSendMessage ||
        (() =>
          Promise.resolve({
            ok: true,
            skipped: null,
            result: { verdict: "read", relevance: 90, novelty: 70, credibility: 80, source: "jev", reason: "ok" }
          }))
    }
  });
  loadLibs(env, ["storage.js"]);
  evalRel(env.win, "src/popup/popup.js");
  return env;
}

describe("popup / 解除屏蔽", () => {
  it("当前站点在黑名单里：显示解除入口，点击后移除条目并给出反馈", async () => {
    const env = bootPopup({
      tabs: [{ id: 1, active: true, url: "https://s.weibo.com/weibo?q=x" }],
      store: { "rs.settings": { siteBlocklist: ["weibo.com"] } },
      onTabsSendMessage: () => Promise.resolve({ ok: true, skipped: "blocked" })
    });
    await waitFor(() => !env.doc.getElementById("unblockRow").hidden, { label: "解除屏蔽行出现" });
    a.equal(env.doc.getElementById("unblockHost").textContent, "s.weibo.com", "应显示具体主机名（含子域命中）");
    a.includes(env.doc.getElementById("udesc").textContent, "解除屏蔽", "不支持页的文案也要指路解除入口");

    env.doc
      .getElementById("unblockBtn")
      .dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
    await waitFor(() => {
      const s = env.chrome.__store["rs.settings"];
      return s && s.siteBlocklist && s.siteBlocklist.indexOf("weibo.com") === -1;
    }, { label: "黑名单移除 weibo.com" });
    a.includes(env.doc.getElementById("unblockLabel").textContent, "已解除屏蔽", "必须给出可感知的反馈");
    a.equal(env.doc.getElementById("unblockBtn").hidden, true, "解除后按钮应收起，避免重复点击");
  });

  it("不在黑名单时不显示解除入口", async () => {
    const env = bootPopup({});
    await sleep(60);
    a.equal(env.doc.getElementById("unblockRow").hidden, true, "未屏蔽站点不该出现解除行");
    const s = env.chrome.__store["rs.settings"];
    a.ok(!s || !s.siteBlocklist, "不应悄悄改写黑名单");
  });

  /* ---- QA 复核固化的三个边界：空名单 / 重复条目 / 子域命中 ---- */

  it("边界：黑名单为空时不显示解除入口，也不崩、不改写名单", async () => {
    const env = bootPopup({
      tabs: [{ id: 1, active: true, url: "https://example.com/article" }],
      store: { "rs.settings": { siteBlocklist: [] } }
    });
    await sleep(60);
    a.equal(env.doc.getElementById("unblockRow").hidden, true, "空名单不该出现解除行");
    a.deepEqual(env.chrome.__store["rs.settings"].siteBlocklist, [], "空名单不应被悄悄改写");
  });

  it("边界：黑名单有重复条目时解除一次移除全部命中", async () => {
    const env = bootPopup({
      tabs: [{ id: 1, active: true, url: "https://example.com/article" }],
      store: { "rs.settings": { siteBlocklist: ["example.com", "example.com"] } }
    });
    await waitFor(() => !env.doc.getElementById("unblockRow").hidden, { label: "解除屏蔽行出现" });
    env.doc
      .getElementById("unblockBtn")
      .dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
    await waitFor(() => {
      const bl = env.chrome.__store["rs.settings"].siteBlocklist;
      return Array.isArray(bl) && bl.length === 0;
    }, { label: "重复条目全部移除" });
    a.deepEqual(env.chrome.__store["rs.settings"].siteBlocklist, []);
  });

  it("边界：子域命中解除时移除的是名单里的原条目，而不是算出来的子域", async () => {
    const env = bootPopup({
      tabs: [{ id: 1, active: true, url: "https://www.example.com/post" }],
      store: { "rs.settings": { siteBlocklist: ["example.com", "other.com"] } }
    });
    await waitFor(() => !env.doc.getElementById("unblockRow").hidden, { label: "解除屏蔽行出现" });
    a.equal(env.doc.getElementById("unblockHost").textContent, "www.example.com", "应显示实际主机名");
    env.doc
      .getElementById("unblockBtn")
      .dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
    await waitFor(() => {
      const bl = env.chrome.__store["rs.settings"].siteBlocklist;
      return Array.isArray(bl) && bl.length === 1;
    }, { label: "只移除命中的原条目" });
    a.deepEqual(
      env.chrome.__store["rs.settings"].siteBlocklist,
      ["other.com"],
      "应移除名单里的 example.com（原条目），保留无关条目"
    );
  });
});
