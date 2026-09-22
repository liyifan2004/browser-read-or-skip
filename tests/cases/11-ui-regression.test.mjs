/**
 * UI 设计审查落地后的硬约束回归。
 * 把审查报告（design-review.html）里的 P0 / P1 修正固化成契约：
 *   a) 三个样式表都含 [hidden]{display:none!important}
 *   b) 三个样式表都有 :focus-visible
 *   c) 三个样式表都有 prefers-reduced-motion
 *   d) 除 11.5px 徽标档外，所有 font-size ≥ 12px
 *   e) border-radius 取值只落在定义的档位内（4 / 8 / 12 / 999 胶囊）
 *   f) SERP 徽章浅色与深色两套，每对前景/背景的 WCAG 对比度 ≥ 4.5（公式实时计算）
 *   g) 源码里不再出现「估算中」和 🚫；设置入口收敛
 */
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "../harness/registry.mjs";
import * as a from "../harness/assert.mjs";
import { ROOT, readFile, createEnv, evalRel, loadContentScript, waitFor } from "../harness/env.mjs";

const POPUP_CSS = readFile("src/popup/popup.css");
const OPTIONS_CSS = readFile("src/options/options.css");
const HUD_SRC = readFile("src/content/hud.js");
const SERP_SRC = readFile("src/content/serp.js");

/** hud.js / serp.js 的样式是文件内嵌的模板字符串，抽出来当独立样式表检查 */
function extractTemplate(src, name) {
  const m = new RegExp("const " + name + " = `([\\s\\S]*?)`;").exec(src);
  if (!m) throw new Error("找不到 " + name + " 模板字符串");
  return m[1];
}

const HUD_CSS = extractTemplate(HUD_SRC, "CSS");
const SERP_CSS = extractTemplate(SERP_SRC, "SERP_CSS");

const PAGES = [
  ["popup.css", POPUP_CSS],
  ["options.css", OPTIONS_CSS],
  ["hud.js 内嵌 CSS", HUD_CSS]
];

const ALL_SHEETS = PAGES.concat([["serp.js 内嵌 CSS", SERP_CSS]]);

/* ---------- WCAG 2.1 相对亮度与对比度 ---------- */

function channel(c) {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(hex) {
  const h = String(hex).replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

describe("UI 回归 / hidden 兜底与可访问性", () => {
  it("三个样式表都有 [hidden]{display:none!important} 兜底", () => {
    for (const [name, css] of PAGES) {
      a.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/, name + " 缺少 [hidden] 兜底");
    }
  });

  it("三个样式表都有 :focus-visible 焦点环", () => {
    for (const [name, css] of PAGES) {
      a.includes(css, ":focus-visible", name + " 缺少焦点环样式");
    }
  });

  it("三个样式表都有 prefers-reduced-motion 降级", () => {
    for (const [name, css] of PAGES) {
      a.includes(css, "prefers-reduced-motion", name + " 缺少动效降级");
    }
  });

  it("焦点环使用 --rs-focus 令牌，reduced-motion 关闭全部动画与过渡", () => {
    for (const [name, css] of PAGES) {
      a.includes(css, "var(--rs-focus)", name + " 焦点环应使用令牌色");
      a.match(
        css,
        /prefers-reduced-motion:\s*reduce\s*\)\s*\{\s*\*\s*\{\s*animation:\s*none\s*!important;\s*transition:\s*none\s*!important/,
        name + " 的 reduced-motion 应同时关闭 animation 与 transition"
      );
    }
  });
});

describe("UI 回归 / 字号与圆角档位", () => {
  it("除 11.5px 徽标档外，所有 font-size ≥ 12px", () => {
    for (const [name, css] of ALL_SHEETS) {
      const sizes = [];
      for (const m of css.matchAll(/font-size:\s*([\d.]+)px/g)) sizes.push(Number(m[1]));
      for (const m of css.matchAll(/font:\s*[^;\n]*?([\d.]+)px/g)) sizes.push(Number(m[1]));
      a.gt(sizes.length, 0, name + " 应能解析出字号声明");
      for (const s of sizes) {
        a.ok(
          s >= 12 || s === 11.5,
          name + " 出现违规字号 " + s + "px（仅允许 11.5px 徽标档，支持性文字下限 12px）"
        );
      }
    }
  });

  it("border-radius 只落在定义的档位内（4 徽标 / 8 控件 / 12 容器 / 999 胶囊）", () => {
    const allowed = new Set([4, 8, 12, 999]);
    for (const [name, css] of ALL_SHEETS) {
      for (const m of css.matchAll(/border-radius:\s*([^;]+);/g)) {
        const raw = m[1].trim();
        for (const token of raw.split(/\s+/)) {
          if (token === "0" || token.endsWith("%")) continue;
          if (!token.endsWith("px")) {
            a.fail(name + " 出现非档位圆角值：" + raw);
          }
          const v = Number(token.slice(0, -2));
          a.ok(allowed.has(v), name + " 出现档位外的圆角值：" + v + "px（声明 " + raw + "）");
        }
      }
    }
  });
});

describe("UI 回归 / SERP 徽章对比度", () => {
  let THEME = null;
  try {
    const env = createEnv({});
    evalRel(env.win, "src/lib/namespace.js");
    evalRel(env.win, "src/lib/constants.js");
    THEME = env.win.RS.SERP_THEME;
  } catch (e) {
    // 让用例显式失败而不是静默跳过
  }

  it("浅色与深色两套徽章都定义了 read / skim / skip / pending 四档", () => {
    a.ok(THEME, "RS.SERP_THEME 未定义");
    for (const mode of ["light", "dark"]) {
      a.ok(THEME[mode], "缺少 " + mode + " 主题套");
      for (const verdict of ["read", "skim", "skip", "pending"]) {
        const pair = THEME[mode][verdict];
        a.ok(pair && pair.fg && pair.bg, mode + "/" + verdict + " 缺少前景/背景对");
      }
    }
    a.ok(THEME.summary && THEME.summary.light && THEME.summary.dark, "缺少汇总条主题套");
  });

  it("每一对前景/背景的 WCAG 对比度都 ≥ 4.5（公式实时计算，不是写死的数值）", () => {
    a.ok(THEME, "RS.SERP_THEME 未定义");
    for (const mode of ["light", "dark"]) {
      for (const verdict of ["read", "skim", "skip", "pending"]) {
        const { fg, bg } = THEME[mode][verdict];
        const c = contrast(fg, bg);
        a.gte(c, 4.5, mode + "/" + verdict + " 对比度 " + c.toFixed(2) + ":1，低于 4.5");
      }
      const s = THEME.summary[mode];
      a.gte(contrast(s.fg, s.bg), 4.5, "汇总条 " + mode + " 正文对比度 " + contrast(s.fg, s.bg).toFixed(2) + ":1");
      a.gte(contrast(s.brand, s.bg), 4.5, "汇总条 " + mode + " 品牌字对比度 " + contrast(s.brand, s.bg).toFixed(2) + ":1");
    }
  });

  it("serp.js 的注入样式确实引用了主题里的每一对颜色", () => {
    a.ok(THEME, "RS.SERP_THEME 未定义");
    for (const mode of ["light", "dark"]) {
      for (const verdict of ["read", "skim", "skip", "pending"]) {
        // serp.js 源码里是模板插值，检查引用接线即可（数值正确性由上一条用公式保证）
        a.includes(SERP_CSS, "RS.SERP_THEME." + mode + "." + verdict + ".fg", mode + "/" + verdict + " 前景色未接入样式");
        a.includes(SERP_CSS, "RS.SERP_THEME." + mode + "." + verdict + ".bg", mode + "/" + verdict + " 背景色未接入样式");
      }
    }
    for (const mode of ["light", "dark"]) {
      a.includes(SERP_CSS, "RS.SERP_THEME.summary." + mode + ".fg", "汇总条 " + mode + " 正文色未接入样式");
      a.includes(SERP_CSS, "RS.SERP_THEME.summary." + mode + ".brand", "汇总条 " + mode + " 品牌色未接入样式");
    }
  });

  it("每档等级都有非颜色线索标记", () => {
    a.ok(THEME, "RS.SERP_THEME 未定义");
    const markers = ["read", "skim", "skip"].map((v) => THEME.light[v].marker);
    a.deepEqual(new Set(markers).size, 3, "三档的线索应互不相同：" + markers.join(","));
    for (const marker of markers) {
      a.includes(SERP_CSS, 'data-marker="' + marker + '"', "样式里缺少线索实现：" + marker);
    }
  });
});

describe("UI 回归 / 术语与入口收敛", () => {
  function walk(dir, out = []) {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        walk(p, out);
      } else {
        out.push(path.relative(ROOT, p).replace(/\\/g, "/"));
      }
    }
    return out;
  }

  it("src/ 下不再出现「估算中」和 🚫", () => {
    const files = walk(path.join(ROOT, "src")).filter((f) =>
      /\.(js|css|html)$/.test(f) && !/lib[\\/]config\.js$/.test(f)
    );
    a.gt(files.length, 0);
    for (const f of files) {
      const src = fs.readFileSync(path.join(ROOT, f), "utf8");
      a.notIncludes(src, "估算中", f + " 仍含「估算中」（本地阶段应统一叫「初判」）");
      a.notIncludes(src, "🚫", f + " 仍含 emoji 🚫（应换成几何 SVG 图标）");
    }
  });

  it("设置入口收敛：弹窗与 HUD 底栏不再有设置按钮", () => {
    a.notIncludes(readFile("src/popup/popup.html"), "openOptions", "弹窗底部不应再有「打开设置」按钮");
    a.notIncludes(HUD_SRC, ">设置</button>", "HUD 底栏不应再有「设置」按钮");
    a.includes(HUD_SRC, 'data-act="refresh"', "HUD 底栏应保留主按钮「重新评估」");
  });

  it("弹窗与设置页使用同一符号（三段递减横条），不再是书本 SVG", () => {
    for (const f of ["src/popup/popup.html", "src/options/options.html"]) {
      const html = readFile(f);
      a.includes(html, "<rect", f + " 应使用横条几何符号");
      a.notIncludes(html, "M2 4h6a3 3 0 0 1 3 3v13", f + " 不应再是书本 SVG");
    }
  });
});

/* ===================== QA 独立复核固化的契约 ===================== */

describe("UI 回归 / QA 复核固化的契约", () => {
  /** 审查第 05 节给出的 15 个深色令牌，逐值锁定 */
  const TOKEN_SPEC = {
    canvas: "#0C0E13", surface: "#15181E", "surface-2": "#1E222A", field: "#0A0C10",
    border: "#262B34", "border-ctl": "#5E6675", text: "#EDEFF4", "text-2": "#9CA4B3",
    accent: "#3B82F6", focus: "#7FB0FF", read: "#4ADE9E", skim: "#F2C14E",
    skip: "#A7B0BE", warn: "#FBBF24", danger: "#FD8A9B"
  };

  /** options.css 末尾有浅色主题覆盖，锁定深色令牌时只取覆盖块之前的部分 */
  function darkTokenSlice(css) {
    const lightAt = css.indexOf("prefers-color-scheme: light");
    return lightAt === -1 ? css : css.slice(0, lightAt);
  }

  it("三处深色 --rs-* 令牌与审查规格逐值一致（15/15）", () => {
    const sheets = [
      ["popup.css", POPUP_CSS],
      ["options.css（:root 深色套）", darkTokenSlice(OPTIONS_CSS)],
      ["hud.js 内嵌 CSS", HUD_CSS]
    ];
    for (const [name, css] of sheets) {
      const found = {};
      for (const m of css.matchAll(/--rs-([a-z0-9-]+)\s*:\s*(#[0-9A-Fa-f]{6})/g)) found[m[1]] = m[2];
      for (const [k, v] of Object.entries(TOKEN_SPEC)) {
        a.equal(
          (found[k] || "").toUpperCase(), v.toUpperCase(),
          name + " 的 --rs-" + k + " 应为 " + v + "，实际 " + (found[k] || "缺失")
        );
      }
    }
    a.includes(OPTIONS_CSS, "prefers-color-scheme: light", "设置页应保留浅色主题覆盖（审查修订顺序第 8 步）");
  });

  const SERP_FIXTURE = `<!doctype html><html><body>
<div id="search">
  <div class="MjjYud">
    <a href="https://developer.chrome.com/docs/x"><h3>QA 复核：样式注入顺序用例的结果一</h3></a>
    <div class="VwiC3b">这条摘要的内容足够长，能通过脚本里的长度检查要求。</div>
  </div>
  <div class="MjjYud">
    <a href="https://example.org/post"><h3>QA 复核：样式注入顺序用例的结果二</h3></a>
    <div class="VwiC3b">另一条结果的摘要内容也足够长，能通过长度检查要求。</div>
  </div>
</div>
</body></html>`;

  it("serp.js 在插入首枚徽章之前完成样式节点注入", async () => {
    const env = createEnv({
      url: "https://www.google.com/search?q=qa",
      html: SERP_FIXTURE,
      chromeOpts: { onRuntimeSendMessage: () => Promise.resolve({ ok: true, results: {} }) }
    });
    // 记录 createElement 次序：style 节点必须先于第一枚徽章创建，
    // 否则徽章会以无样式状态插入（裸奔）后才补样式。
    const order = [];
    const origCreate = env.doc.createElement.bind(env.doc);
    env.doc.createElement = (tag, ...rest) => {
      const el = origCreate(tag, ...rest);
      el.__qaCreateOrder = order.length; // className 在创建后才赋值，所以只记序号、事后查类名
      order.push(el);
      return el;
    };
    loadContentScript(env, 1);
    await waitFor(() => env.doc.querySelectorAll(".rs-serp-chip").length >= 1, { label: "徽章出现" });

    const styleIdx = order.findIndex((el) => el.tagName === "STYLE");
    const chipIdx = order.findIndex((el) => el.tagName === "SPAN" && String(el.className).includes("rs-serp-chip"));
    a.ok(styleIdx !== -1, "应创建样式节点");
    a.ok(chipIdx !== -1, "应创建徽章元素");
    a.ok(styleIdx < chipIdx, "样式节点必须先于首枚徽章创建（serp.js 的 ensureStyle 应在 scan 之前调用）");
    a.ok(env.doc.getElementById("rs-serp-style"), "样式节点应已挂到文档上");
  });

  it("命中区用伪元素扩到 44px，弹窗与设置页有 pointer: coarse 触屏放大", () => {
    a.match(POPUP_CSS, /\.iconbtn::after\s*\{[^}]*inset:\s*-8px/, "弹窗图标按钮应扩出 44px 命中区");
    a.match(HUD_CSS, /\.iconbtn::after\s*\{[^}]*inset:\s*-8px/, "HUD 图标按钮应扩出 44px 命中区");
    a.includes(POPUP_CSS, "@media (pointer: coarse)", "弹窗缺少触屏命中区放大");
    a.includes(OPTIONS_CSS, "@media (pointer: coarse)", "设置页缺少触屏命中区放大");
  });

  it("HUD 自动收起保留焦点、定位用实测尺寸", () => {
    a.includes(HUD_SRC, "S.card.contains(ae)", "自动收起回调必须检查焦点是否在卡片内");
    a.includes(HUD_SRC, "getBoundingClientRect", "applyPosition 应实测卡片尺寸做边界夹紧");
    a.includes(HUD_SRC, "requestAnimationFrame(() => applyPosition())", "render 内容变化后应重定位一次");
  });
});
