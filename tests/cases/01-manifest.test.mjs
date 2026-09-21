/**
 * manifest.json 与代码的一致性。
 * 这类测试的价值：manifest 是最容易手滑写错、且出错后报错信息最难懂的地方。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "../harness/registry.mjs";
import * as a from "../harness/assert.mjs";
import { ROOT, readManifest, exists } from "../harness/env.mjs";

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === ".git" || name === ".workbuddy") continue;
      walk(p, out);
    } else {
      out.push(path.relative(ROOT, p).replace(/\\/g, "/"));
    }
  }
  return out;
}

/**
 * 抹掉注释与字符串字面量，只留"会在浏览器里真正执行"的代码。
 * 否则 siteBlocklist 里的 "chrome.google.com/webstore" 会被误判成调用了 chrome.google。
 */
function stripLiterals(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:\w])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, '""')
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""');
}

describe("manifest 一致性", () => {
  const m = readManifest();
  const allFiles = walk(ROOT);

  it("是合法 JSON 且 manifest_version 为 3", () => {
    a.equal(m.manifest_version, 3);
    a.match(m.version, /^\d+\.\d+\.\d+$/, "version 必须是 x.y.z");
    a.isString(m.name);
    a.gt(m.name.length, 0);
    a.gt((m.description || "").length, 0, "description 不能为空");
  });

  it("所有被引用的脚本 / 样式 / 图标文件都真实存在", () => {
    const refs = [];
    refs.push(m.background.service_worker);
    for (const cs of m.content_scripts) refs.push(...cs.js);
    for (const size of Object.keys(m.icons)) refs.push(m.icons[size]);
    for (const size of Object.keys(m.action.default_icon)) refs.push(m.action.default_icon[size]);
    refs.push(m.action.default_popup);
    refs.push(m.options_ui.page);

    const missing = refs.filter((r) => !exists(r));
    a.deepEqual(missing, [], "以下文件被 manifest 引用但不存在：" + missing.join(", "));
  });

  it("图标是真实 PNG 且四种尺寸齐全", () => {
    for (const size of [16, 32, 48, 128]) {
      const rel = m.icons[String(size)];
      const buf = fs.readFileSync(path.join(ROOT, rel));
      a.gt(buf.length, 50, rel + " 体积过小，不像有效 PNG");
      const sig = buf.subarray(0, 8).toString("hex");
      a.equal(sig, "89504e470d0a1a0a", rel + " 不是 PNG");
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      a.equal(w, size, rel + " 宽度不符");
      a.equal(h, size, rel + " 高度不符");
    }
  });

  it("内容脚本的注入顺序满足依赖：namespace 最先、hud 最后", () => {
    const js = m.content_scripts[0].js;
    a.equal(js[0], "src/lib/namespace.js", "namespace 必须最先注入");
    a.equal(js[js.length - 1], "src/content/hud.js", "hud 应最后注入");
    const idx = (f) => js.indexOf(f);
    a.gt(idx("src/lib/constants.js"), idx("src/lib/namespace.js"), "constants 必须在 namespace 之后");
    a.gt(idx("src/lib/storage.js"), idx("src/lib/constants.js"), "storage 必须在 constants 之后");
    a.gt(idx("src/lib/heuristics.js"), idx("src/lib/constants.js"), "heuristics 依赖 constants");
    a.gt(idx("src/lib/extract.js"), idx("src/lib/heuristics.js"), "extract 依赖 heuristics");
    a.gt(idx("src/content/hud.js"), idx("src/lib/extract.js"), "hud 依赖 extract");
  });

  it("类库文件在 manifest 里都有声明（防止漏依赖）", () => {
    const declared = new Set();
    for (const cs of m.content_scripts) for (const f of cs.js) declared.add(f);
    const allLibs = allFiles.filter((f) => /^src\/lib\/[a-z-]+\.js$/.test(f));
    const templateOnly = "src/lib/config.example.js";
    const mainOnly = "src/lib/config.js"; // 本地密钥，按设计不进 content script
    const jevOnly = "src/lib/jev.js"; // 只在 service worker / 设置页跑，内容脚本不能直连 API
    const questionsOnly = "src/lib/questions.js"; // 同上，只在后台用
    const missing = allLibs.filter(
      (f) => !declared.has(f) && f !== templateOnly && f !== mainOnly && f !== jevOnly && f !== questionsOnly
    );
    a.deepEqual(missing, [], "这些 lib 没被任何 content_scripts 声明：" + missing.join(", "));
  });

  it("搜索结果脚本只挂在搜索引擎结果页", () => {
    const cs = m.content_scripts[1];
    a.includes(cs.js.join(","), "src/content/serp.js");
    a.notIncludes(cs.js.join(","), "hud.js", "结果页脚本不应重复注入 hud");
    a.equal(cs.run_at, "document_idle", "serp 需要 DOM 就绪后再跑");
    a.equal(cs.all_frames, false);
    const matches = cs.matches.join(" ");
    for (const host of ["google.com", "bing.com", "baidu.com", "duckduckgo.com", "brave.com", "sogou.com"]) {
      a.includes(matches, host, "结果页匹配规则缺少 " + host);
    }
    a.includes(matches, "/search", "结果页匹配规则应限定到搜索结果路径");
  });

  it("content script 在 document_start 注入，才能拿到『最早一帧』", () => {
    a.equal(m.content_scripts[0].run_at, "document_start");
    a.equal(m.content_scripts[0].all_frames, false, "只在顶层文档跑，避免 iframe 里重复弹窗");
  });

  it("权限与代码里实际调用的 chrome API 匹配", () => {
    const jsText = allFiles
      .filter((f) => f.startsWith("src/") && f.endsWith(".js"))
      .map((f) => stripLiterals(fs.readFileSync(path.join(ROOT, f), "utf8")))
      .join("\n");

    const used = new Set();
    const re = /chrome\.([a-zA-Z]+)\./g;
    let match;
    while ((match = re.exec(jsText))) used.add(match[1]);

    const permissions = new Set(m.permissions || []);
    // 这些命名空间无需在 permissions 里声明
    const freeNamespaces = new Set(["runtime", "action", "commands", "i18n", "extension"]);

    for (const ns of used) {
      if (freeNamespaces.has(ns)) continue;
      if (ns === "storage") {
        a.ok(permissions.has("storage"), "代码用了 chrome.storage，manifest 必须申请 storage 权限");
      } else if (ns === "tabs") {
        a.ok(
          permissions.has("tabs") || permissions.has("activeTab"),
          "代码用了 chrome.tabs，需要 tabs 或 activeTab 权限"
        );
      } else {
        a.ok(permissions.has(ns), "代码用了 chrome." + ns + "，manifest 权限里没有 " + ns);
      }
    }

    for (const p of permissions) {
      a.ok(
        new RegExp("chrome\\." + p + "\\.").test(jsText) || p === "activeTab",
        "manifest 申请了 " + p + " 权限，但代码里没有用到 —— 应该去掉，少一个权限少一次审核问询"
      );
    }
  });

  it("host_permissions 覆盖代码里真正请求的接口域名", () => {
    const jev = fs.readFileSync(path.join(ROOT, "src/lib/jev.js"), "utf8");
    const apiUrl = /RS\.API_URL\s*=\s*"([^"]+)"/.exec(
      fs.readFileSync(path.join(ROOT, "src/lib/constants.js"), "utf8")
    );
    a.ok(apiUrl, "constants.js 里应定义 RS.API_URL");
    const host = new URL(apiUrl[1]).host;
    const hosts = (m.host_permissions || []).join(" ");
    a.includes(hosts, host, "host_permissions 必须包含 " + host);
    a.includes(jev, "RS.API_URL", "jev.js 应该用常量而不是硬编码 URL");
  });

  it("快捷键与后台监听的名字一致", () => {
    const sw = fs.readFileSync(path.join(ROOT, m.background.service_worker), "utf8");
    for (const name of Object.keys(m.commands || {})) {
      a.includes(sw, '"' + name + '"', "后台没有处理 manifest 里声明的快捷键 " + name);
    }
    a.equal(m.commands["toggle-panel"].suggested_key.default, "Alt+Shift+R");
  });

  it("后台脚本不把 API Key 写死在源码里", () => {
    const sw = fs.readFileSync(path.join(ROOT, m.background.service_worker), "utf8");
    a.notIncludes(sw, "apikey_", "后台源码里不应出现真实 Key");
    const jev = fs.readFileSync(path.join(ROOT, "src/lib/jev.js"), "utf8");
    a.notIncludes(jev, "apikey_", "jev.js 里不应出现真实 Key");
  });

  it("密钥文件已被 .gitignore 排除", () => {
    const gi = fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    a.includes(gi, "src/lib/config.js", ".gitignore 必须排除本地密钥文件");
  });

  it("popup / options 页面的脚本顺序满足依赖", () => {
    const popup = fs.readFileSync(path.join(ROOT, m.action.default_popup), "utf8");
    a.includes(popup, "../lib/namespace.js");
    a.includes(popup, "../lib/constants.js");
    a.includes(popup, "../lib/storage.js");
    a.match(popup, /namespace\.js[\s\S]*constants\.js[\s\S]*storage\.js[\s\S]*popup\.js/, "popup 脚本顺序不对");

    const opts = fs.readFileSync(path.join(ROOT, m.options_ui.page), "utf8");
    a.match(
      opts,
      /namespace\.js[\s\S]*config\.example\.js[\s\S]*config\.js[\s\S]*constants\.js[\s\S]*storage\.js[\s\S]*heuristics\.js[\s\S]*jev\.js[\s\S]*options\.js/,
      "options 脚本顺序不对：config.example 必须在 config 之前，options.js 必须最后"
    );
  });
});
