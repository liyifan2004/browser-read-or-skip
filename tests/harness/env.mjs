/**
 * 测试环境：用 jsdom 造一个真实的 window，把扩展脚本按 manifest 声明原样注入。
 * 高度贴近浏览器行为：location / document / Shadow DOM / MutationObserver / rAF 都是真的。
 */
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { makeChrome } from "./chrome-mock.mjs";

export const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");

export function readManifest() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
}

export function readFile(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

export function exists(rel) {
  return fs.existsSync(path.join(ROOT, rel));
}

/** 在 window 里执行一个仓库内脚本 */
export function evalRel(win, rel) {
  win.eval(readFile(rel));
}

/**
 * 造一个页面环境。
 * @param {{url?:string, html?:string, chrome?:object, chromeOpts?:object, fetch?:Function}} opts
 */
export function createEnv(opts = {}) {
  const html = opts.html || "<!doctype html><html><head><title>测试页</title></head><body></body></html>";
  let pageUrl = opts.url || "https://example.com/article";
  // 允许传相对路径片段
  if (!/^https?:/.test(pageUrl)) pageUrl = "https://example.com" + pageUrl;

  // 页面里的未捕获异常默认会被 jsdom 吞掉（扩展代码普遍用 .catch(() => {}) 收尾），
  // 结果就是"什么都没发生"这种最难查的失败。这里全部收集下来供断言。
  const pageErrors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (err) => pageErrors.push(err));
  virtualConsole.on("error", (...args) => pageErrors.push(new Error(args.map(String).join(" "))));

  const dom = new JSDOM(html, {
    url: pageUrl,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole
  });
  const win = dom.window;
  const chrome = opts.chrome || makeChrome(opts.chromeOpts || {});
  win.chrome = chrome;

  const fetchCalls = [];
  const fetchImpl = opts.fetch || (() => Promise.reject(new Error("测试中不应发生真实 fetch")));
  win.fetch = (...args) => {
    fetchCalls.push(args);
    return fetchImpl(...args);
  };

  // jsdom 没有实现 innerText，补一个基于 textContent 的近似实现，
  // 让 extract.js / heuristics.js 走真实分支而不是全部退化到 textContent。
  if (!("innerText" in win.HTMLElement.prototype)) {
    Object.defineProperty(win.HTMLElement.prototype, "innerText", {
      get() {
        return this.textContent;
      },
      set(v) {
        this.textContent = v;
      },
      configurable: true
    });
  }

  return { dom, win, doc: win.document, chrome, fetchCalls, pageErrors };
}

/** 按顺序注入若干 lib（默认自动带上 namespace + constants 前置） */
export function loadLibs(env, names, opts = {}) {
  const files = [];
  if (opts.includeBase !== false) {
    files.push("src/lib/namespace.js");
    if (opts.withConfig) files.push("src/lib/config.example.js");
    files.push("src/lib/constants.js");
  }
  for (const n of names) files.push(n.startsWith("src/") ? n : "src/lib/" + n);
  for (const f of files) evalRel(env.win, f);
}

/** 按 manifest 的 content_scripts[i].js 顺序注入 */
export function loadContentScript(env, index) {
  const manifest = readManifest();
  const entry = manifest.content_scripts[index];
  if (!entry) throw new Error("manifest.content_scripts[" + index + "] 不存在");
  for (const rel of entry.js) evalRel(env.win, rel);
  return entry;
}

/** 注入 background service worker，并把 importScripts 接到真实文件上 */
export function loadBackground(env, opts = {}) {
  const manifest = readManifest();
  const rel = manifest.background.service_worker;
  env.win.importScripts = (...paths) => {
    for (const p of paths) {
      const r = String(p).replace(/^\/+/, "");
      if (/(^|\/)lib\/config\.js$/.test(r)) {
        if (opts.hideConfig) throw new Error("模拟 config.js 不存在");
        if (opts.configStub) {
          // 用桩数据代替本地密钥文件，测试不接触真实 Key
          env.win.RS.DEFAULT_CONFIG = opts.configStub;
          continue;
        }
      }
      evalRel(env.win, r);
    }
  };
  evalRel(env.win, rel);
}

/** 轮询等待条件成立 */
export async function waitFor(fn, { timeout = 2000, interval = 10, label = "条件" } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch (e) {
      v = false;
    }
    if (v) return v;
    if (Date.now() - t0 > timeout) {
      throw new Error("等待超时（" + timeout + "ms）：" + label);
    }
    await sleep(interval);
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 造一个符合 Jev 响应结构的假响应 */
export function jevResponse(answers, extra = {}) {
  return {
    model: extra.model || "jev-1.13.0",
    answers: answers || {},
    usage: Object.assign({ input_tokens: 100, output_tokens: 20 }, extra.usage || {})
  };
}

/** 造一个 fetch 响应对象 */
export function jsonResponse(obj, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return obj;
    },
    async text() {
      return JSON.stringify(obj);
    }
  };
}

/** 一次典型的页面评估答案 */
export function pageAnswers(overrides = {}) {
  return Object.assign(
    {
      verdict: { type: "choice", choice: "read", confidence: 0.82, probabilities: { read: 0.88, skim: 0.11, skip: 0.01 } },
      relevance: { type: "score", score: 3.87, confidence: 0.89 },
      novelty: { type: "score", score: 3.1, confidence: 0.7 },
      value: { type: "choice", choice: "high", confidence: 0.74, probabilities: { high: 0.82, medium: 0.12, low: 0.06 } },
      credibility: { type: "score", score: 3.81, confidence: 0.84 },
      redundancy: { type: "noul", noul: 0.12 },
      contentType: { type: "choice", choice: "reference", confidence: 0.95, probabilities: { reference: 0.95 } },
      timelessness: { type: "score", score: 2.33, confidence: 0.42 }
    },
    overrides
  );
}
