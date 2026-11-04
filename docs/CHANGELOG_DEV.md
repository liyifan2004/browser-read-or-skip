# 开发记录（CHANGELOG_DEV）

按轮次记录：目标、改动、技术选择、验证结果、遗留风险。不记一次性调试细节。

---

## 2026-11-04 · 发布 1.2.0

**包含**：第十轮的安全修复（IMP-22，模型名未转义 → HTML 注入）
+ 版本号同步脚本的排版修复（见下）。

### 发布前发现并修掉的缺陷：版本号改动被噪音淹没

第一次准备打 1.2.0 时，`npm version minor` 产生了 **28 行 diff，其中只有 1 行是真改动**：

```diff
-  "version": "1.1.0",
+  "version": "1.2.0",
-  "permissions": ["storage", "activeTab"],
-
-  "host_permissions": ["https://api.typesafe.ai/*"],
+  "permissions": [
+    "storage",
+    "activeTab"
+  ],
```

**根因**：`version-bump.mjs` 用 `JSON.stringify(data, null, indent)` 写回整个文件。
它保留了行尾与缩进，却没保留**紧凑单行数组**的排版 ——
`JSON.stringify` 会对所有数组做统一展开。

脚本自己的注释声称「读写 JSON 时保留原文件的缩进风格、行尾和结尾换行」——
**这个承诺只兑现了一半**。行尾保留了，数组排版没保留。

**为什么这条值得单独修**：发版是「改动最需要被看清」的时刻，
而版本号提交恰恰是**最容易被忽略**的提交（commit message 就是 "1.2.0"）。
diff 一旦被噪音淹没，review 时就会直接跳过 —— 于是发版脚本引入的排版变更
会静悄悄地累积到下一次发版，直到某天有人发现 manifest 被人重排过。

**改法**：只做一次**文本替换**（定位 `"version"` 键，替换它的值），
其余字节一个都不动。排版、行尾、结尾换行自然全部保留。

**效果**：同一个操作，diff 从 **28 行降到 4 行**（manifest 1 + package 1 +
package-lock 2，全是真实的版本号改动）。

**新增 6 例测试**（`tests/cases/14-version-sync.test.mjs`），
其中末条直接拿仓库里的**真 manifest.json** 断言「只变一行」——
最贴近真实用法的守门。

**顺带核实**：其余 6 个仓库的 `version-bump.mjs` 也用 `JSON.stringify` 写回，
但它们的 JSON 已是全展开格式，实际不产生噪音 —— **缺陷仅存在于本仓库**。
（唯一例外是 adaptive-workspace 与 mineru 的 `tsconfig.json` 里有紧凑数组，
但版本号脚本不碰这两个文件。）

### 发布验证

- `node tests/run.mjs` → **315 / 315**（原 309）
- `node tools/pack.mjs --check` → 自检通过
- tag `1.2.0` 指向版本提交；release.yml 有「tag 必须匹配 manifest 版本」的闸门

---

## 2026-11-04 · 第十轮：模型名未转义 → HTML 注入（IMP-22）

### 本次目标与完成情况

上一轮（第九轮）修完了百度摘要选择器。本轮把「同一份逻辑有两个实现」
这个判据用在了**安全边界**上：前几轮都在查功能一致性，
但漏了一类更严重的问题 —— **同一份转义约定，在不同文件里落实程度不同**。

核实出 **2 处未转义的注入点**，都已修；测试 304 → **309**。

### 问题证据（实测复现）

**缺陷 1：`src/content/hud.js` 的 `srcLabel()`**

```js
function srcLabel(r) {
  ...
  if (r.model) return String(r.model).replace(/^jev-/, "jev ");   // ← 未转义
  return "模型";
}
```

返回值在 `hud.js:487` 被直接拼进 `S.card.innerHTML`：

```js
'<span class="src">' + srcTag + "</span>" +
```

**数据来源是远端 API 响应**：`service-worker.js` 把 `resp.model` 原样透传
（`model: resp.model`），`questions.js` 的 `normalizePage` / `normalizeSerp`
把它写进 `result.model`。也就是说这是一个**外部可控**的字符串。

**缺陷 2：`src/popup/popup.js` 的 contentType 回退分支**

```js
chips.push('<span class="chip">' + (RS.CONTENT_TYPE_LABEL[r.contentType] || r.contentType) + "</span>");
```

`RS.CONTENT_TYPE_LABEL[r.contentType]` 查不到时回退到**原文** `r.contentType`，
而原文同样来自模型返回。`hud.js` 的同名逻辑（`chipsHTML`）是走了 `esc()` 的
—— 同一份约定，两个文件落实程度不同。

**为什么这是真实风险而不是理论风险**：浮层注入在**用户正在访问的页面**里
（内容脚本的 shadow root 活在页面 DOM 树中，页面脚本可以观察到）。
`esc()` 缺失 = 页面里多出可执行 DOM。

### 反证（用例有效性验证）

把修复临时改回旧代码后：

```
✗ 模型名里的 <img> 不会变成真实元素节点
    模型名里的 <img> 不得成为元素节点
          实际: 1
          期望: 0
✗ 模型名里的 <script> 不会成为真实元素节点，也不会执行
      不得产生 <script> 节点
          实际: 1
          期望: 0
✗ 把载荷塞进模型返回的每个字段后，DOM 结构与干净渲染完全一致
    载荷改变了 DOM 结构（说明有内容被当成了 HTML 解析）
          实际: ["SVG: 基线 2 → 载荷 3","IMG: 基线 0 → 载荷 1"]
```

**`<img>` 真的成了 DOM 节点** —— 注入可证实，不是推测。恢复修复后 5/5 通过。

### 方法论：为什么用 DOM 基线对比，而不是静态扫描

第一版用例是**静态扫描**「哪些 `innerHTML` 拼接点没有 `esc()`」。
反证时发现它对本次缺陷**完全无效** —— 因为 `srcLabel()` 的定义行里根本没有
`innerHTML`，转义发生在更外层。静态扫描只能看到**直接**拼接。

改成 **DOM 基线对比**：渲染两份（一份字段干净、一份字段带载荷），
逐标签比对元素数量。载荷不改变结构 = 没有内容被当成 HTML 解析。
这个判据与「转义发生在哪一层」无关，只看结果。

踩到的两个坑：

1. **不能用「标签白名单」** —— 本扩展自己的图标就是内联 SVG
   （`ICON.chev` / `ICON.collapse` / `ICON.warn`），白名单要么放行 SVG
   （放行了就漏掉注入的 `<svg onload>`），要么误伤自己的图标。
2. **就绪信号不能用「`.src` 出现」** —— 初判态的卡片里已经有 `.src`
   （内容是「初判」），而初判态与模型态渲染出的结构不同
   （初判没有「阅读价值 / 内容类型」两枚 chip）。用它当就绪信号会让
   基线与载荷截到**不同阶段**，基线对比法随即失效。
   判据改成「`.plabel` 变成『值得读』」—— 那是模型结论落地的标志。

### 改动

- `src/content/hud.js` —— `srcLabel()` 的 model 分支走 `esc()`，
  并补注释说明「返回的就是可安全插入的文本」这一契约。
- `src/popup/popup.js` —— contentType 回退分支走 `esc()`，与 hud.js 对齐。
- `tests/cases/16-xss-escaping.test.mjs`（新增，5 例）——
  载荷不产生元素节点 / 载荷不改变 DOM 结构 / 正常模型名显示不受影响。

### 验证

`node tests/run.mjs` → **309 / 309 全通过**（原 304）。

---

## 2026-11-04 · 第九轮：百度摘要选择器重新标定（IMP-18）

### 本次目标与完成情况

第八轮修掉了结果页「空窗」，并记下 IMP-18：百度的摘要选择器在 2026 年的真实
页面上命中 0 个，摘要始终为空。本轮专门处理它。

### 问题证据（实测）

在真实百度结果页（Playwright + Chromium，`--no-proxy-server`）上把旧选择器
原样交给页面统计：

| 选择器 | 命中 |
| --- | --- |
| `.c-abstract` | 0 |
| `.content-right_8Zs40` | 0 |
| `[class*='content-right']` | 0 |
| `.c-span-last p` | 0 |

**四条全 0** —— 百度的摘要从未被取到，SERP 判定少了一个重要信号（标题 + URL +
查询词之外，摘要是判断"这是不是正文型内容"的主要依据）。

### 关键发现：类名是「稳定前缀 + 构建期哈希后缀」

2026 年百度结果页用的类名形如：

```
summary-text_15QGa
summary-gap_68jXq
content-gap_3jlQr
img-container_6nk6p
```

**语义前缀稳定，后缀是构建期哈希**。因此：

- 硬编码完整类名（`.summary-text_15QGa`）等于给定时炸弹 —— 百度下次发布就失效；
- 用 `[class*='summary-text']` 属性包含匹配则只依赖稳定前缀，不会随构建变。

> 实测边界（诚实标注）：同一构建内连续 4 次加载，哈希后缀**完全一致**
> （4/4 均为 `summary-text_15QGa`）。所以"每次构建都变"是**基于类名形态的推断**，
> 不是本次实测到的事实 —— 本次实测确认的是"前缀稳定、当前后缀为 15QGa"。
> 无论后缀何时变，前缀匹配都能扛住；这正是不硬编码的理由。

### 候选选择器的实测对比

在 5 个不同查询上采样（每个查询用全新 context）：

| 选择器 | 命中数（5 个查询） | 取到的文本 |
| --- | --- | --- |
| `[class*='summary-text']` | 6 / 6 / 8 / 8 / 8 | **纯摘要正文**，无日期噪声 |
| `[class*='summary-gap']` | 6 / 6 / 9 / 8 / 8 | 日期 + 摘要正文 |
| `[class*='content-gap']` | 6 / 3 / 5 / 7 / 7 | 日期 + 摘要正文 |
| `[class*='c-span-last']` | 1 / 4 / 0 / 11 / 1 | 部分结果的摘要 |

**首选 `summary-text`** —— 它是唯一不带日期噪声的那个。`summary-gap` / `content-gap`
会把发布日期混进摘要（"2025年11月6日一、Manifest V3的诞生背景…"），稀释发给
模型的语义，所以降为次选。

### 方案

`src/lib/engines.js` 的百度 `snippetSel` 改为：

```js
snippetSel: [
  "[class*='summary-text']",   // 首选：唯一不带日期噪声的
  "[class*='summary-gap']",    // 次选：带日期前缀
  "[class*='c-span-last']",    // 另一类结果的摘要容器
  ".c-abstract",               // 旧结构兜底（百度若回滚）
  "[class*='content-right']",  // 旧结构兜底
],
```

旧选择器**保留在后面** —— 百度若回滚到旧结构仍能工作，代价为零。

### 横向排查：还有别的引擎也失效了吗

同一脚本跑全部 6 个引擎（用各自当前的 `snippetSel`）：

| 引擎 | 结果容器 | 取到摘要 | 命中选择器 |
| --- | --- | --- | --- |
| 必应 | 10 | **10/10** | `.b_caption p` |
| 搜狗 | 11 | **9/11** | `.fz-mid` / `.space-txt` |
| 百度 | — | 0（修复前） | — |
| Google / DuckDuckGo / Brave | — | 未能采样 | 网络超时（`ERR_CONNECTION_TIMED_OUT`） |

结论：**只有百度失效**，必应与搜狗正常。Google / DDG / Brave 因本机网络超时
未采到样本，如实标注为「待核实」。

### 验证

- `npm test`：**304/304 全绿**（303 → 304；新增 6 例）
  - `15-engines` 5 例：百度的选择器**不许硬编码哈希后缀类名**、前缀匹配能命中
    实测形态、首选必须是 `summary-text`、旧选择器保留作兜底
  - `07-serp` 1 例：**新结构与旧结构两种夹具下，摘要都要能取到并出现在
    发给后台的 `items[].snippet` 里**（这才是 IMP-18 的核心断言）
- **测试有效性反证**：把选择器临时改回修复前的旧值，该用例**当场失败**
  （`snippet=""`）；恢复后通过 —— 证明这条用例真的能抓住这个缺陷。
- **真实浏览器验证**：用实测到的真实类名形态造夹具页 + 加载真实扩展，
  新结构 2 个徽章、旧结构 1 个徽章，汇总条都正常。
- `node tools/sync-engines.mjs --check`、`node tools/pack.mjs --check`：通过。

### 遗留问题

- **IMP-21（P2）**：次选路径（`summary-gap` / `content-gap`）取到的文本**仍带日期
  前缀**，日期噪声会稀释发给模型的语义。下轮可考虑取 `summary-text` 的内层文本
  而非容器文本，或对已知的日期形态做剥离。
- **反爬限制**：百度按请求频率触发验证码页（连续请求即跳
  `wappass.baidu.com/static/captcha/`）。本轮后半程的采样因此受阻，
  部分对比数据是在限流前采到的。**下次标定搜索引擎要预留大间隔**。
- **Google / DDG / Brave 的摘要选择器未采到样本**（网络超时），仍属「待核实」。

---

## 2026-11-04 · 第八轮：搜索引擎的单一事实源（修空窗缺陷）

### 本次目标与完成情况

前七轮收敛的是 CI / 发布 / 版本号链路。本轮转向**功能正确性**，找到并修掉一个
用户可见的静默故障：搜索结果页上「既没有徽章，也没有浮层」（下称"空窗"）。

### 问题证据（实测复现，不是推测）

「哪些页面是搜索结果页」此前在**三处各写一遍**：

| 位置 | 作用 | 缺陷 |
| --- | --- | --- |
| `manifest.json` `content_scripts[1].matches` | 决定 `serp.js` 会不会被注入 | 只写裸域 `duckduckgo.com` |
| `src/lib/heuristics.js` `SEARCH_ENGINE_PATTERNS` | 决定 HUD 会不会让位 | 写 `/(^\|\.)duckduckgo\.com$/`，覆盖各级子域 |
| `src/content/serp.js` `ENGINES[].match` | 决定 serp.js 内部认不认这个引擎 | 写 `/(^\|\.)duckduckgo\.com$/`，覆盖各级子域 |

两者不一致的后果是：HUD 认为这是结果页 → **浮层让位**；但 manifest 没覆盖该主机
→ **serp.js 没被注入** → 结果页上零反馈。实测三档主机全部中招：

- `www.duckduckgo.com`
- `html.duckduckgo.com`
- `lite.duckduckgo.com`

真实 Chromium 修复前后对照（Playwright + 本地夹具页 + `--host-resolver-rules`，
分别加载 `git worktree` 导出的 HEAD 原始树与修复后的工作区）：

```
主机                        修复前(徽章/汇总/HUD)    修复后(徽章/汇总/HUD)
duckduckgo.com            (1, 1, 0)              (1, 1, 0)
www.duckduckgo.com        (0, 0, 0)   ← 空窗      (1, 1, 0)   ← 修复
html.duckduckgo.com       (0, 0, 0)   ← 空窗      (1, 1, 0)   ← 修复
lite.duckduckgo.com       (0, 0, 0)   ← 空窗      (1, 1, 0)   ← 修复
```

修复前那三档的 HUD 也是 0 —— 因为浮层让位了，整页什么都没有。

### 方案

不做"给 manifest 补三条 pattern"这种补丁（下次加引擎还会漂移），而是把
「一个引擎长什么样」收成一份数据：

- **新增 `src/lib/engines.js`** —— 搜索引擎的**单一事实源**。每个引擎一条记录：
  `id` / `hosts`（主机后缀规则）/ `pathPrefixes`（路径前缀）/ `queryParams`
  （查询词参数名）/ `matchPatterns`（Chrome match pattern）/ 五个 DOM 选择器。
- **三处都从它派生**：
  - `manifest.json` 的 matches 由 `tools/sync-engines.mjs` 生成（新增）；
  - `heuristics.isSearchResultsPage` 改为委托 `RS.engines.isSearchResultsPage`；
  - `serp.js` 的 `ENGINES` 改为从 `RS.engines.ENGINES` 映射而来，不再自带主机正则。
- **新增 `tools/sync-engines.mjs --check`** 并挂进 CI —— manifest 与单一事实源
  不一致时 CI 直接失败，漂移不可能再溜进发布。

### 几个关键判断

1. **host 判定比 Chrome 的 glob 更严格，是刻意的。** Chrome 的 `*.suffix`
   同时匹配 suffix 本身与各级子域（依据 Chromium 源码
   `extensions/common/url_pattern.cc` 的 `URLPattern::MatchesHost`），但 path
   的 `*` 是纯 glob —— `*://*.baidu.com/s*` 会命中 `/sugrec`。而
   `RS.engines` 是「这页是不是结果页」的**权威判定**（HUD 让位与 serp.js
   内部识别都用它），必须精确到路径段边界：`/s` 命中，`/sugrec` 不命中。
   manifest 的 match pattern 略宽是安全的（注入了但认不出引擎会安静退出）；
   权威判定略宽则会让 HUD 在非结果页上让位，**反而制造空窗**。
2. **`engines.js` 用主机后缀规则而不是 Chrome 通配符表达主机**，是因为
   Chrome 的 match pattern 表达不了"只匹配 www."这种精确主机；用显式后缀列表
   语义更清楚，也与 manifest 的 pattern 一一对应。
3. **不在本轮扩大引擎范围。** 顺带核实时发现 `www.google.co.jp` 等 ccTLD 也
   未被覆盖，但 README 与功能账簿声明的 Google 范围就是 com / com.hk / com.tw
   三档。扩大范围属于产品决策，不在"修缺陷"范围内 —— 已作为待办记入账簿。
   （参考：同 fleet 的 QuerySwitch 仓库已收录 Chromium 官方
   `kGoogleConfigs` 的 220 个 Google 主机清单，需要时可直接复用。）

### 实际执行的测试与结果

- `npm test`：**298/298 全绿**（14.1s）。基线 282/282，新增 16 例（`15-engines`）：
  - 单一事实源的导出面完整性、引擎 id 唯一性；
  - manifest 的 matches 与 `engines.js` **逐条相等**（不一致即失败）；
  - 各引擎主机/子域识别、**仿冒域名不得蹭上引擎**（`notduckduckgo.com`、
    `duckduckgo.com.evil.io`、`evil-google.com` 等）；
  - **防空窗回归**：凡被判定为结果页的 URL，manifest 必须覆盖；
    **防双标注回归**：manifest 覆盖的 URL，HUD 必须让位；
  - Chrome match pattern 语义（依据 Chromium 源码与 `url_pattern_unittest.cc`）：
    `*.suffix` 匹配 suffix 本身与各级子域、path 的 `*` 覆盖 path+query、
    `X/*` 额外匹配精确的 `X`。
- `node tools/sync-engines.mjs --check`：通过（9 条 pattern）。
- `node tools/pack.mjs --check`：通过（`src/lib/engines.js` 已在打包白名单内，
  manifest 引用的 15 个文件均在包内）。
- **真实浏览器验证**（Playwright + Chromium，`channel="chromium"`）：见上方
  修复前后对照表。这是本仓库第一次有真实 Chrome 的自动化证据（对应 IMP-8）。

### 遗留问题与后续建议

- **百度的摘要选择器已失效**（本轮顺带发现，未修）：真实页面上
  `.c-abstract` / `.content-right_8Zs40` / `[class*='content-right']` /
  `.c-span-last p` **命中 0 个**，百度的摘要因此始终为空。2026 年的百度结果页
  改用 `cos-line-clamp-*` / `summary-text_*` 一类哈希后缀的类名（每次构建都会变，
  哈希类名不适合硬编码）—— 需要另找稳定锚点。已记入功能账簿 F-005 已知问题。
- **IMP-8 真实浏览器验证**：本轮已用 Playwright 手动跑通（可重复的脚本在
  `.workbuddy/scratch/`），但尚未接入 CI —— 下一步应把 e2e 冒烟固化进 CI。
- **IMP-9 初始化异常静默吞掉**（P2，未处理）：`init().catch(() => {})` 仍是
  "什么都没发生"类问题的温床，本轮的空窗缺陷正是它本该拦住的那类问题。
- 下一轮建议方向：把本轮的真实浏览器 e2e 固化进 CI（IMP-8），或转向
  MSE 那 2000 行未测 DOM 层。

---

## 2026-10-23 · 第一轮：功能账簿建立 + 首批缺陷修复

### 本次目标与完成情况

按《浏览器扩展持续开发与维护规范》首次执行：项目摸底 → 功能账簿 → 技术调研 → 质量审查 → 优化清单 → 首批实施 → 文档同步。全部完成。

### 关键文件与功能 ID

| 文件 | 改动 | 功能 ID |
| --- | --- | --- |
| `src/content/serp.js` | 查询词提取引擎化（`ENGINES[].queryParams` + `currentQuery()`） | F-005 |
| `src/background/service-worker.js` | 兜底 state 改走 `RS.extract.buildState`；REQUEST_STATE 加错误应答；importScripts 增 heuristics/extract | F-013/F-015/F-004 |
| `src/lib/extract.js` | `buildState` 对缺失 text 容错 | F-003/F-013 |
| `src/lib/storage.js` | 写锁更名 `withStorageWriteLock`，`bumpStats` 入锁 | F-006/F-007 |
| `src/lib/heuristics.js` | `trustOfDomain` 名单匹配收紧为主机名边界 | F-002 |
| `src/lib/constants.js` | `answers.yahoo` → `answers.yahoo.com`（配合边界匹配） | F-002 |
| `src/content/hud.js` | SPA 导航后改 `evaluate()`（不绕缓存） | F-001/F-006 |
| `tests/cases/{02,05,07,09}` | 新增 5 个回归契约 | — |
| `docs/`（4 个新文档） | 功能账簿 / 调研结论 / 优化清单 / 本记录 | — |
| `README.md` | 测试数字、8 问构成、工具与 docs 索引修正 | — |

### 重要技术选择

1. **state 构造单路径**（IMP-2）：不做「在兜底里再抄一份隐私过滤」的补丁，而是让后台加载 `extract.js` 复用 `buildState`。隐私语义只存在一处，未来改隐私规则不会漏掉某条路径。`buildState` 本身不碰 DOM，SW 内可安全加载（调研结论 R1 的环境约束已核）。
2. **查询词提取配置化**（IMP-1）：不写 `if (engine === "baidu")` 特例，把引擎差异收敛进 ENGINES 数据表——与调研 R2（uBlacklist SERPINFO）「选择器/差异数据化」方向一致。
3. **一把写锁**（IMP-4）：统计与缓存共用 `withStorageWriteLock`，不另造锁机制。

### 实际执行的测试与结果

- `npm test`：**268/268 全绿**（22.8s）。基线为本轮摸底时的 263/263，新增 5 个用例：
  - `02` 仿冒域名不得蹭白名单高可信（新匹配规则契约）
  - `05` 并发 bumpStats 不丢更新
  - `07` 查询词按引擎参数提取（百度 wd/word、搜狗 query、兜底空串）
  - `09` 兜底 state 在 titles 隐私模式不带正文/统计
  - `09` REQUEST_STATE 存储出错必须应答 `{ok:false}`（不挂起）
- **未执行**：`npm run test:api`（需真实 API Key，会真实计费）、`npm run bench`、真实浏览器加载验证（本机未开浏览器冒烟流程）。这些项保持「待核实」，未标为通过。

### 遗留问题与后续建议

见 `docs/IMPROVEMENTS.md` 待处理表。下一轮最有价值的三件：

1. **IMP-8 真实浏览器冒烟**（P2）：全部"已验证"目前都是 jsdom 模拟；引擎选择器与样式隔离在真实 Chrome 无自动化证据。
2. **IMP-9 初始化异常留痕**（P2）：`init().catch(() => {})` 静默吞错仍是「什么都没发生」类问题的温床。
3. **IMP-10 发布打包**（P2）：`design-review.html`/`gh-push.ps1` 等开发产物目前会混进商店包。

### 文档同步情况

- `docs/FEATURE_LEDGER.md`：新建，17 项功能（F-001…F-017），含消息时序图与未纳入账簿的仓库内容说明。
- `docs/TECHNICAL_REFERENCES.md`：新建，R1–R5 调研结论（官方生命周期语义已核验；developer.chrome.com 主站 fetch 失败，用 google.cn 镜像 + MDN 交叉核对，已如实注明）。
- `docs/IMPROVEMENTS.md`：新建，本轮 7 项已处理（IMP-1…IMP-7）+ 10 项待处理 + 安全审查结论。
- `README.md`：修正过期数字与问法构成，补 docs/ 索引。

### Git 差异审查

此前工作区干净、分支 main、无未提交修改。改动仅限上表文件，无无关修改、无临时产物入库；`src/lib/config.js`（本地 Key）确认仍被 `.gitignore` 排除（`git check-ignore` 核实）。

按原子提交拆分为 3 次提交（hash 见 `git log`）：

1. `fix(serp)`：查询词提取引擎化（serp.js + 07 回归契约）
2. `fix(core)`：隐私单路径 / REQUEST_STATE 应答 / 写锁 / 域名边界（其余 src + 02/05/09 回归契约，268 用例全绿）
3. `docs`：功能账簿体系 4 文档 + README 同本记录

## 2026-11-02 · IMP-10 发布打包自动化

**目标**：商店包用白名单打包，杜绝开发产物与本地密钥混进去。

**做法**：新增 `tools/pack.mjs`。

- **白名单而非黑名单**：只认「运行必需文件」（manifest.json / README.md / LICENSE / src/ / icons/）。
  黑名单会在新增目录时静默漏排——只要有人忘了加排除项，开发产物就进包了。
  白名单下新文件默认不进包，要进包必须显式改清单。
- **两条硬红线**：
  1. `src/lib/config.js`（真实 API Key）永远不进包，扩展在缺它时回退到 `config.example.js`（apiKey 为空），
     用户在设置页手填 Key——这是设计好的降级路径。
  2. 打包后逐条核对 manifest 引用的文件都在包里、包里没有多余文件。
- **零新依赖**：用 node 自带的 `node:zlib` 手工构造 zip（运行时零依赖是本项目硬约束）。
  打包器不引入任何 npm 包。

**实现中修掉的两个自己的 bug**（都写进了注释）：
1. 第一版目录遍历只取了一层，`src/background/`、`src/lib/` 下的文件全漏掉 → 改成递归。
2. 第一版把 `config.example.js` 排除了——**这是错的**。`service-worker.js` 在 `config.js` 缺失时
   `importScripts` 回退到它，少了这个文件后台直接起不来。已改为必须进包。

**测试**：新增 `tests/cases/13-pack.test.mjs` 5 个用例，直接读 zip 的中央目录（不依赖打包器代码）：
- 打包自检通过；
- zip 合法且不含 `config.js`、含 `config.example.js`；
- manifest 引用的 14 个文件都在包里；
- 包里没有 tests/tools/docs/assets、没有开发文件、没有 jpg/@2x 源图；
- 包体 < 1MB（实际 76.3 KB / 24 个文件）。

**验证**：`npm test` 268 → 273 用例全绿；另用 Python 的 `zipfile`（独立实现，不复用打包器逻辑）
做过 CRC 校验与内容抽检——CRC OK，manifest 可解析，密钥文件确认不在包内。

**未执行**：真实 Chrome 加载商店包的冒烟验证（本机无 Chrome for Testing，见 IMP-8）；
`npm run test:api`（需真实 Key、真实计费）仍未跑。
