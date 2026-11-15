/**
 * 渲染契约（suite 19）。
 *
 * 上一轮反证实验查出的三处盲区，根因各不相同，但都指向同一个问题：
 * **断言的对象必须是「用户能感知的东西」，而不是「某个中间结构的记录」。**
 *
 * 1. 转义契约的载荷清单是**手写的 6 个字段**，漏了 `readingMinutes` ——
 *    它被直接拼进 innerHTML，值里带 < 的内容会变成真实元素节点。
 *    扩展注入到用户页面里的 shadow root 仍活在页面 DOM 树中，页面脚本可观察。
 *    这里把清单改成**从结果对象的键自动生成**，新增字段自动进入载荷范围。
 *
 * 2. 指标名此前在 popup.js 与 hud.js 各手写一份，改一处另一处不变，
 *    用户在浮层和弹窗里看到同一个指标的两个名字。现在共用
 *    RS.METRIC_LABEL，这里断言两条路径渲染出的指标名集合**完全相等**。
 *
 * 3. 设置页的加载失败 / 保存失败路径没有任何断言，且提示文本可以被掏空
 *    成静默失败。现在 setHint 不接受空串，这里钉住「失败必须留下可读原因」。
 */
import path from "node:path";
import { describe, it } from "../harness/registry.mjs";
import * as a from "../harness/assert.mjs";
import { createEnv, readFile, evalRel, loadContentScript, waitFor } from "../harness/env.mjs";

const LONG_CN = "这是一段用于测试的正文内容，长度足够让启发式打分认为它是一篇真实文章。".repeat(20);

function articleHtml(title = "浏览器扩展开发实战：Service Worker 生命周期") {
  return (
    "<!doctype html><html lang='zh-CN'><head><title>" + title +
    "</title></head><body><article><h1>" + title +
    "</h1><p>" + LONG_CN + "</p></article></body></html>"
  );
}

/** 与生产同形状的结果对象（字段名必须与 questions.normalizePage 的输出一致）。 */
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
      readingMinutes: 9,
      at: Date.now()
    },
    over
  );
}

/** 把 HTML 文件里声明的 <script src> 按顺序注入到 jsdom */
function loadPage(relHtml, opts = {}) {
  const html = readFile(relHtml);
  const dir = path.posix.dirname(relHtml);
  const { fetch, ...chromeOpts } = opts;
  const env = createEnv({ url: "https://read-or-skip.test/" + relHtml, html, chromeOpts, fetch });
  const srcs = [...html.matchAll(/<script src="([^"]+)"\s*>/g)].map((m) => m[1]);
  for (const src of srcs) {
    if (/(^|\/)lib\/config\.js$/.test(src)) continue;
    evalRel(env.win, path.posix.normalize(path.posix.join(dir, src)));
  }
  return env;
}

function shadow(env) {
  const host = env.doc.getElementById("read-or-skip-host");
  return host && host.shadowRoot;
}

function optionsReady(env) {
  return waitFor(() => env.doc.getElementById("ver").textContent.length > 0, { label: "设置页脚本就绪" });
}

function popupReady(env) {
  return waitFor(() => env.doc.getElementById("loading").hidden, { label: "弹窗脚本就绪" });
}

function hudState(over = {}) {
  return Object.assign(
    {
      ok: true,
      mounted: true,
      expanded: true,
      skipped: null,
      page: { title: "标题", domain: "example.com", charCount: 4200 },
      result: modelResult()
    },
    over
  );
}

describe("转义契约 / 载荷清单自动生成", () => {
  it("结果对象里的每一个字段塞进载荷后，都不得改变渲染出的元素结构", async () => {
    const PAYLOAD = 'x<img src="https://evil.example/p.png"><svg onload="window.__pwned=1"></svg>';

    const base = createEnv({
      url: "https://example.com/post/base",
      html: articleHtml(),
      chromeOpts: { onRuntimeSendMessage: () => Promise.resolve({ ok: true, result: modelResult() }) }
    });
    loadContentScript(base, 0);
    await waitFor(() => shadow(base) && shadow(base).querySelector(".plabel"), { label: "浮层挂载" });

    // 载荷清单从结果对象的键自动生成 —— 不再手写。手写清单的覆盖缺口
    // 与测试盲区一一对应：readingMinutes 此前就是这样漏掉的。
    const payloadResult = modelResult();
    for (const key of Object.keys(payloadResult)) payloadResult[key] = PAYLOAD;

    const env = createEnv({
      url: "https://example.com/post/xss",
      html: articleHtml(),
      chromeOpts: { onRuntimeSendMessage: () => Promise.resolve({ ok: true, result: payloadResult }) }
    });
    loadContentScript(env, 0);
    await waitFor(() => shadow(env) && shadow(env).querySelector(".plabel"), { label: "浮层挂载" });

    const root = shadow(env);
    a.equal(root.querySelectorAll("img").length, 0, "载荷不得产生 img 元素节点");
    a.equal(root.querySelectorAll("svg[onload]").length, 0, "载荷不得产生带 onload 的 svg");
    for (const el of root.querySelectorAll("*")) {
      for (const attr of Array.from(el.attributes || [])) {
        a.notOk(/^on/i.test(attr.name), "载荷不得产生内联事件属性：" + el.tagName + "@" + attr.name);
      }
    }
  });

  it("readingMinutes 是数字时正常显示；不是数字时不得变成元素节点", async () => {
    const env = createEnv({
      url: "https://example.com/post/rm",
      html: articleHtml(),
      chromeOpts: {
        onRuntimeSendMessage: () =>
          Promise.resolve({ ok: true, result: modelResult({ readingMinutes: '9<img src="https://evil.example/p.png">' }) })
      }
    });
    loadContentScript(env, 0);
    await waitFor(() => shadow(env) && shadow(env).querySelector(".plabel"), { label: "浮层挂载" });

    const root = shadow(env);
    a.equal(root.querySelectorAll("img").length, 0, "readingMinutes 的载荷不得成为元素节点");
    const chips = root.querySelector(".chips");
    if (chips) a.includes(chips.textContent, "9", "readingMinutes 的数值仍要显示出来");
  });

  it("缓存里的旧结果同样不得注入元素节点", async () => {
    // 真正走缓存读取路径，而不是把 source 改成 "cache" 就算数 ——
    // 后者根本没碰 getCacheEntry，测不到「缓存层是否校验字段」。
    // 这里直接调存储层的 getCacheEntry，喂一份脏数据。
    const env = createEnv({
      url: "https://example.com/post/cache",
      html: articleHtml(),
      chromeOpts: {
        store: {
          "rs.cache": {
            "https://example.com/post/cache": {
              at: Date.now(),
              title: "缓存的标题",
              partial: false,
              result: {
                kind: "page",
                verdict: "read",
                relevance: 94,
                readingMinutes: '9<img src="https://evil.example/p.png">',
                reason: "缓存里的理由",
                source: "jev",
                unknownStringField: '9<img src="https://evil.example/p.png">',
              },
            },
          },
        },
      },
    });
    loadContentScript(env, 0);
    await waitFor(() => shadow(env) && shadow(env).querySelector(".plabel"), { label: "浮层挂载" });

    // 存储层读取时必须把非法 readingMinutes 归一化掉：白名单里它是数字型，
    // 非数字一律置 null（渲染层见 null 就不画这条 chip）
    const entry = await env.win.RS.storage.getCacheEntry("https://example.com/post/cache", {});
    a.ok(entry, "缓存条目应该被读到");
    a.equal(entry.result.readingMinutes, null, "非数字的 readingMinutes 必须置 null");
    // 白名单之外的字段一律丢弃 —— 旧缓存里可能有任意结构
    a.equal(entry.result.unknownStringField, undefined, "白名单外的字段必须丢弃");
    // 而且渲染层拿到的东西也不该是元素节点
    a.equal(shadow(env).querySelectorAll("img").length, 0, "缓存路径也不得注入元素节点");
  });

  it("popup 侧的 readingMinutes 同样不得注入元素节点", async () => {
    const env = loadPage("src/popup/popup.html", {
      onTabsSendMessage: () =>
        Promise.resolve(
          hudState({ result: modelResult({ readingMinutes: '9<img src="https://evil.example/p.png">' }) })
        )
    });
    await popupReady(env);
    a.equal(env.doc.querySelectorAll("img").length, 0, "popup 不得注入 img 元素节点");
  });
});

describe("指标文案 / 浮层与弹窗必须一致", () => {
  it("浮层与弹窗渲染出的指标名集合完全相等", async () => {
    const env = createEnv({
      url: "https://example.com/post/labels",
      html: articleHtml(),
      chromeOpts: { onRuntimeSendMessage: () => Promise.resolve({ ok: true, result: modelResult() }) }
    });
    loadContentScript(env, 0);
    await waitFor(() => shadow(env) && shadow(env).querySelector(".plabel"), { label: "浮层挂载" });

    const hudLabels = [...shadow(env).querySelectorAll(".metrics .mlabel")].map((el) => el.textContent);

    const popupEnv = loadPage("src/popup/popup.html", {
      onTabsSendMessage: () => Promise.resolve(hudState())
    });
    await popupReady(popupEnv);
    const popupLabels = [...popupEnv.doc.querySelectorAll("#metrics .mlabel")].map((el) => el.textContent);

    a.deepEqual(popupLabels, hudLabels, "浮层与弹窗的指标名必须一致");
    a.deepEqual(hudLabels, ["相关度", "新信息", "可信度", "时效性"]);
  });

  it("指标名来自共享常量，不是两份手写字面量", async () => {
    const env = loadPage("src/popup/popup.html", { onTabsSendMessage: () => Promise.resolve(hudState()) });
    await popupReady(env);
    const RS = env.win.RS;
    a.ok(RS.METRIC_LABEL, "RS.METRIC_LABEL 必须存在");
    a.deepEqual(Object.keys(RS.METRIC_LABEL), RS.METRIC_KEYS);
    // 每条源码里不得再出现手写的指标名
    for (const rel of ["src/popup/popup.js", "src/content/hud.js"]) {
      const src = readFile(rel);
      for (const label of Object.values(RS.METRIC_LABEL)) {
        a.notIncludes(src, '"' + label + '"', rel + " 不得再手写指标名 " + label);
      }
    }
  });

  it("四个指标名都被实际渲染出来", async () => {
    const env = loadPage("src/popup/popup.html", { onTabsSendMessage: () => Promise.resolve(hudState()) });
    await popupReady(env);
    const labels = [...env.doc.querySelectorAll("#metrics .mlabel")].map((el) => el.textContent);
    a.deepEqual(labels, ["相关度", "新信息", "可信度", "时效性"]);
  });
});

describe("设置页 / 失败必须有可读原因", () => {
  it("读设置失败时提示里写明失败与原因，而不是一片空白", async () => {
    const env = loadPage("src/options/options.html", {
      storageGetError: new Error("存储被拒绝")
    });
    // 不能等「提示非空」：静态 HTML 里的占位文案「修改后会自动保存」
    // 一开始就非空，条件立刻成立，等于没等。必须等出错文案本身。
    await waitFor(() => env.doc.getElementById("saveHint").textContent.includes("加载设置失败"), {
      label: "加载失败提示"
    });
    const hint = env.doc.getElementById("saveHint");
    a.includes(hint.textContent, "加载设置失败", "提示必须说明是加载失败");
    a.includes(hint.textContent, "存储被拒绝", "提示必须带上原始原因");
    a.ok(hint.className.includes("error"), "失败提示要有 error 样式");
  });

  it("保存失败时提示里写明失败与原因，且保存按钮恢复可点", async () => {
    const env = loadPage("src/options/options.html", {
      storageSetError: new Error("配额已满")
    });
    await optionsReady(env);
    env.doc.getElementById("save").dispatchEvent(new env.win.MouseEvent("click", { bubbles: true }));
    await waitFor(() => env.doc.getElementById("saveHint").textContent.includes("保存失败"), { label: "保存失败提示" });

    const hint = env.doc.getElementById("saveHint");
    a.includes(hint.textContent, "保存失败");
    a.includes(hint.textContent, "配额已满", "提示必须带上原始原因");
    a.notOk(env.doc.getElementById("save").disabled, "保存按钮必须恢复可点，否则用户再也没法重试");
  });

  it("提示区永远不接受空字符串", async () => {
    // setHint 被掏空 = 静默失败。这里钉住这条不变量：
    // 即使某处调用方传了空文本，界面上也必须有一句可读的话。
    //
    // 注意：不能只「把提示清空再点个按钮看它有没有回来」——
    // 那样测的是别的路径碰巧写了提示，不是这条不变量本身。
    // 必须直接调用写入函数。
    const env = loadPage("src/options/options.html", {});
    await optionsReady(env);
    const RS = env.win.RS;
    a.ok(typeof RS.__setHint === "function", "setHint 必须可被直接调用以便断言");

    const hint = env.doc.getElementById("saveHint");
    RS.__setHint("", "error");
    a.ok(hint.textContent.trim().length > 0, "空提示必须被替换成可读文本");
    a.notEqual(hint.textContent.trim(), "", "提示不得为空");
    a.ok(hint.className.includes("error"), "className 仍应被正确设置");

    RS.__setHint(null, "error");
    a.ok(hint.textContent.trim().length > 0, "null 提示也必须被替换成可读文本");

    RS.__setHint("   ", "error");
    a.ok(hint.textContent.trim().length > 0, "纯空白提示也必须被替换成可读文本");

    RS.__setHint("正常提示", "saved");
    a.equal(hint.textContent, "正常提示", "正常提示必须原样显示");
  });
});
