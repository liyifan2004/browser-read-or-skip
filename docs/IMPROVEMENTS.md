# 问题与优化清单（IMPROVEMENTS）

口径：每项记录问题、影响、关联功能 ID/位置、方案、验收标准、风险、优先级与状态。优先级按实际影响定，不夸大。
优先级定义：P0 数据丢失/严重安全/核心不可用；P1 核心缺陷或重大兼容问题；P2 收益明确的可靠性/体验/维护性改进；P3 低风险优化与探索。

最近更新：2026-11-11（本轮处理见 CHANGELOG_DEV.md）。

## 本轮已处理（2026-10-23）

### IMP-1 SERP 查询词提取只认 `?q=`，百度/搜狗拿不到查询词 —— P1

- **问题**：`serp.js` 用 `new URLSearchParams(location.search).get("q")` 提取查询词。百度用 `wd`/`word`、搜狗用 `query`，两者都提为空串。`serpQuestions` 的 instructions 以 `state.query` 为主信号（"results are BY DEFINITION topically related…"），查询词为空时 4 个问题全部退化为「无主信号」判定。
- **影响**：F-005；百度/搜狗（6 引擎中的 2 个）结果徽章判定质量系统性下降。
- **位置**：`src/content/serp.js`（evaluate 内联提取）。
- **方案**：查询词提取下沉为引擎配置（`ENGINES[].queryParams`，按顺序取第一个非空），消除硬编码特例。
- **验收**：新增用例：百度 `?wd=`、搜狗 `?query=` 取词正确；Google `?q=` 回归不变；都取不到时为空串。
- **风险**：低。纯取数逻辑，不影响渲染。
- **状态**：✅ 已实施（含测试）。

### IMP-2 隐私模式缺口：后台兜底 state 绕过隐私过滤 —— P1

- **问题**：`service-worker.js` 的 `extractStateFallback`（内容脚本未带 state 时启用）直接把 `page.text.slice(0, excerptChars)` 发给模型，不看 `privacyMode`。用户选了「仅标题与摘要」仍可能把正文发出去——隐私承诺被破坏。
- **影响**：F-013 / F-004；仅兜底路径触发（当前内容脚本总是带 state），但属隐私承诺缺口，不能靠「路径罕至」放任。
- **位置**：`src/background/service-worker.js:144`。
- **方案**：消除双路径——后台加载 `extract.js`（`buildState` 纯数据、不碰 DOM，SW 内可安全加载），兜底改走 `RS.extract.buildState(page, settings)`，全项目只剩一条 state 构造路径。
- **验收**：新增用例：`privacyMode: "titles"` 时兜底 state 不含 `content`/`stats`；full 模式含截断与 `truncated` 标记（与 06-extract 同语义）。
- **风险**：低。SW 脚本清单 +extract.js；01-manifest 的文件存在性检查自动覆盖。
- **状态**：✅ 已实施（含测试）。

### IMP-3 `REQUEST_STATE` 消息无错误处理，出错时发送方挂起 —— P2

- **问题**：该分支异步读存储但无 try/catch；任一 Promise 拒绝则 `sendResponse` 永不调用，Chrome 111+ 发送方收到 "message port closed" 报错/挂起。
- **影响**：F-015；预判查询（弹窗/未来消费方）可靠性。
- **位置**：`src/background/service-worker.js` 消息路由。
- **方案**：与 EVALUATE 分支同构：try/catch + 失败回 `{ok:false, error}`，保证任何路径都应答。
- **验收**：新增用例：存储抛错时 `REQUEST_STATE` 返回 `{ok:false}` 而不是挂起。
- **风险**：极低。
- **状态**：✅ 已实施（含测试）。

### IMP-4 `bumpStats` 并发丢更新（缓存层同类 bug 的翻版） —— P2

- **问题**：`bumpStats` 读-改-写 `rs.stats` 无串行化；SERP 批量评估 + 页面评估并发时互相覆盖，统计/费用凭空变少。缓存层早已为此加写锁（`withCacheWriteLock`），统计层漏了。
- **影响**：F-007；成本感知失真。
- **位置**：`src/lib/storage.js`。
- **方案**：复用同一把写锁链（`withCacheWriteLock`）包住 `bumpStats` 的读-改-写，一处机制两处使用，不另造锁。
- **验收**：新增用例：并发 N 次 bumpStats 全部累计，无丢失。
- **风险**：极低（锁粒度小）。
- **状态**：✅ 已实施（含测试）。

### IMP-5 `trustOfDomain` 子串匹配，仿冒域名可蹭高可信 —— P3

- **问题**：`TRUST_HIGH` 匹配用 `d.includes(h)`，`developer.chrome.com.evil.io` 这类仿冒域命中 `"developer.chrome.com"` 得 88 高可信——可信度启发式反向助攻仿冒站。
- **影响**：F-002；仅初判（模型覆盖），但方向性错误。
- **位置**：`src/lib/heuristics.js` `trustOfDomain`。
- **方案**：名单匹配收紧为主机名边界匹配（相等或 `.`+后缀）；带路径的名单条目（`sohu.com/a/` 等）本就该由 `scorePage` 的 host+path 作用域匹配处理，域名层不再参与。
- **验收**：新增用例：仿冒域返回中性 55；既有分层用例不回归。
- **风险**：低；启发式分数分布对边界域略变（测试已固化主路径）。
- **状态**：✅ 已实施（含测试）。

### IMP-6 HUD SPA 导航后 `evaluate(true)` 强制绕缓存 —— P3

- **问题**：`onNavigate` 先读缓存渲染，随后 `evaluate(true)` 让后台又跳过缓存重新调模型——缓存白读，每次 SPA 导航都花一次调用。`force` 的既定语义是「重新评估」按钮专用。
- **影响**：F-001/F-006；成本与延迟。
- **位置**：`src/content/hud.js` `onNavigate`。
- **方案**：导航改 `evaluate()`（无 force）：命中完整缓存直接返回，未命中才调模型（partial 不算命中，仍会升级）。
- **验收**：既有 08-hud 用例不回归（其 force 契约只针对重新评估按钮）。
- **风险**：低。
- **状态**：✅ 已实施。

### IMP-7 README 与实际脱节 —— P3

- **问题**：README 写「218 用例 / 10 套件」，实际 12 套件 263 用例（本轮新增后更多）；「8 个并发问题（3 score / 3 choice / 2 noul）」与源码不符（实际 4 score / 3 choice / 1 noul，其自身表格也是 4+1）；`tools/test_serp_calibrate.mjs` 未记录。
- **影响**：文档可信度（功能账簿的对照行为会被误导）。
- **方案**：数字改为随测试输出更新；问法构成改 4/3/1；目录结构补工具。
- **状态**：✅ 已实施。

## 待处理（按优先级）

| ID | 问题 | 优先级 | 关联 | 方案要点 | 验收 |
| --- | --- | --- | --- | --- | --- |
| IMP-8 | 真实浏览器验证缺位：全部"已验证"都是 jsdom 模拟；引擎选择器、SW 休眠唤醒、样式隔离在真实 Chrome 无自动化证据 | P2 | F-005/016/017 | 引入 Playwright/Puppeteer 冒烟：加载扩展→本地夹具页→断言徽章/HUD/缓存；引擎真实页用录制快照 | 起码一条真实浏览器冒烟进 CI |
| IMP-18 | ~~百度摘要选择器已失效~~ **已处理（2026-11-04）** | ~~P1~~ | F-005 | 旧选择器（`.c-abstract` / `.content-right_8Zs40` / `[class*='content-right']` / `.c-span-last p`）在 2026 年的真实百度页面上**四条全 0**。百度的新类名是「稳定语义前缀 + 构建期哈希后缀」（`summary-text_15QGa`），故改用 `[class*='summary-text']` 属性包含匹配（旧选择器保留作兜底）；新增 `15-engines` 与 `07-serp` 的回归用例 | 真实百度页面上摘要非空，且新旧两种结构都有回归契约 |
| IMP-21 | **百度的 `summary-gap` / `content-gap` 会把发布日期混进摘要**：`[class*='summary-gap']` 取到的文本是「2025年11月6日 + 摘要正文」，`content-gap` 同理。摘要文本会原样发给模型，日期噪声会稀释语义判定 | P2 | F-005 | 已把 `summary-text`（唯一不带日期的那个）排为首选、`summary-gap` 降为次选。但**次选仍会带日期** —— 下轮可考虑取 `summary-text` 的**内层文本**而非容器文本，或对日期前缀做剥离 | 次选路径取到的文本不带日期前缀 |
| IMP-19 | **Google ccTLD 覆盖不全**：只覆盖 com / com.hk / com.tw，其余 ccTLD（如 `www.google.co.jp`）结果页无徽章 | P3 | F-005 | 属**产品范围决策**而非缺陷（README 与账簿声明的就是三档）。若决定扩大，可直接复用同 fleet QuerySwitch 仓库里收录的 Chromium 官方 `kGoogleConfigs` 220 主机清单（`shared/constants.js` 的 `GOOGLE_CCDOMAINS`），加进 `engines.js` 的 `hosts` 即可 | 决策后要么补齐并写进 README，要么在 README 明说"仅支持这三档" |
| IMP-20 | **真实浏览器 e2e 未固化进 CI**：2026-11-04 已用 Playwright + 本地夹具页 + `--host-resolver-rules` 手动跑通修复前后对照（证明 www./html./lite.duckduckgo.com 的空窗已修），但脚本在 `.workbuddy/scratch/`（不入库），CI 里没有 | P2 | F-005/016/017 | 把 e2e 脚本移到 `tests/e2e/` 并接进 CI。注意两点环境坑：① 本机装了系统代理，Chromium 会把请求交给代理，`--host-resolver-rules` 失效（**必须加 `--no-proxy-server`**）；② 扩展装载用 `channel="chromium"`（Playwright 自带 Chromium），品牌版 Chrome 已移除 `--load-extension` | CI 里有一条真实 Chrome 的冒烟，徽章/HUD/空窗三类断言都过 |
| IMP-9 | ~~`init().catch(() => {})` 静默吞初始化异常~~ **已处理（2026-11-11）** | ~~P2~~ | F-001/F-010 | 反证时确认这比"吞掉"更糟：抽取抛错时异常直接逃出异步回调（Node 里整个测试进程崩掉，浏览器里是看不见的 unhandled rejection）。改为统一出口 `fail(err, showCard)`：记 `S.error`、`console.warn`、`RS_GET_HUD_STATE` 带 `error` 字段；已确定要浮层之后的失败再挂一张只写原因、不带假分数的「出错」卡片。`serp.js` 同样补日志 | 抽错时页面有原因卡片、弹窗有具体原因 + 刷新动作、控制台有日志 |
| IMP-10 | ~~发布打包无自动化~~ **已处理（2026-11-02）** | ~~P2~~ | 发布 | `tools/pack.mjs` 白名单打包（manifest/src/icons/README/LICENSE）+ 结构自检；新增 `tests/cases/13-pack.test.mjs` 5 用例守住「密钥不进包 / manifest 引用齐全 / 无开发产物 / 体积 <1MB」 | 产出 zip 仅含运行必需文件 |
| IMP-11 | `composite()`/`domainOf()`/`esc()` 多处重复实现（hud/popup/options/sw） | P3 | F-010 等 | 收敛进 `src/lib/`（如 `format.js`），各处引用 | 唯一实现，测试全绿 |
| IMP-12 | 引擎选择器硬编码，改版需发版（uBlacklist SERPINFO 方向，R2） | P3 | F-005 | 引擎描述数据化（本地 JSON/常量表分离），逻辑与数据解耦 | 改选择器不动逻辑 |
| IMP-13 | `pausedSites` 过期条目永不清理，长期累积垃圾键 | P3 | F-012 | 读取时顺手剔除过期项（懒清理） | 存储不随时间膨胀 |
| IMP-14 | `hudPosition` 设置项未消费（占位死配置） | P3 | F-001 | 实现位置偏好或删掉该默认值 | 配置与行为一致 |
| IMP-15 | 预留消息协议 `RS_RESULT_UPDATE`/`RS_GET_SETTINGS`/`RS_CLEAR_BADGE` 无消费方 | P3 | F-015 | 确认无计划用途后删除，或在账簿注明保留理由 | 协议面收敛 |
| IMP-16 | 设置无导入/导出，换机/重装丢配置（含黑名单与主题） | P3 | F-011 | 导出/导入 JSON（注意不含 apiKey 或显式确认） | 一键迁移 |
| IMP-17 | Tarnish 类静态安全扫描未跑（R5） | P3 | 安全 | 安装并跑一次，输出告警清单 | 告警逐条定级 |
| IMP-22 | ~~`hud.js` 的 `srcLabel()` 未转义 → HTML 注入~~ **已处理（2026-11-04）** | ~~P1~~ | F-005/010 | `r.model` 来自**远端 API 响应**（service-worker.js 把 `resp.model` 原样透传），被 `srcLabel()` 原样拼进 `S.card.innerHTML`。浮层注入在**用户访问的页面**里，这是真实 XSS 通道。同时修 `popup.js` 的 contentType 回退分支。新增 `tests/cases/16-xss-escaping.test.mjs`（5 例，DOM 级断言 + 反证验证） | 载荷只作为纯文本显示，DOM 结构与干净渲染逐标签一致 |

## 安全与权限审查结论（2026-10-23）

- **权限面**：`storage` + `activeTab` + host_permissions 仅 `https://api.typesafe.ai/*`。无 `tabs`、无 `webRequest`、无 `<all_urls>` host 权限。**结论：最小权限成立。**
- **内容脚本注入面**：`http://*/*` + `https://*/*` 全站注入是功能必需（任意页面判定），安装时 Chrome 会提示「读取所有网站数据」。商店描述必须披露（P3 文案项）。
- **输入处理**：所有宿主页/模型来源文本进 innerHTML 前经 `esc()` 转义或走 `textContent`；**2026-11-04 第十轮证伪了这条结论**（见 IMP-22）：`hud.js` 的 `srcLabel()` 与 `popup.js` 的 contentType 回退分支是漏网之处，已修并补了 DOM 级回归契约。徽章/浮层均 Shadow DOM，`all: initial` 起手。
- **密钥**：`src/lib/config.js` 含真实 Key 但已被 `.gitignore` 覆盖（本轮 `git check-ignore`/`git ls-files` 核实：未入库）。无其他密钥入库。
- **网络**：仅 `api.typesafe.ai` 一个外发端点，无统计上报，与 README 隐私声明一致。
- **遗留风险**：页面正文默认发往第三方 API（功能本质，隐私模式可关）；`state` 无 schema 校验（信任自家内容脚本，风险可接受）。
