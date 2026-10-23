# 技术调研结论（TECHNICAL REFERENCES）

记录格式：问题 → 出处（实际核对位置）→ 确认的事实 → 对本项目的采纳决定。
口径：区分「官方明确规定」「参考项目的具体实现」「分析判断」「待验证假设」。未实际访问的资料不写成已核对。

最近更新：2026-10-23。

## R1 MV3 Service Worker 生命周期与消息语义

- **要解决的问题**：确认后台消息处理、重试预算、状态存放是否符合官方生命周期语义，会不会被中途终止。
- **出处**：
  - Chrome for Developers《Longer extension service worker lifetimes》（developer.chrome.com/blog/longer-esw-lifetimes，已通过搜索摘录核对原文）。
  - Chrome for Developers《扩展 Service Worker 生命周期》（developer.chrome.google.cn/docs/extensions/develop/concepts/service-workers/lifecycle，中文镜像，搜索摘录核对）。
  - MDN《Background scripts》（developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts，全文核对）。
  - 说明：developer.chrome.com 主站直连 fetch 失败（网络原因），改用 google.cn 镜像摘录 + MDN 原文交叉核对，结论一致。
- **确认的官方事实**：
  1. SW 空闲 30 秒被终结；收到事件或调用扩展 API 会重置计时器。
  2. 单个请求（事件/API 调用）处理超 5 分钟被终结；**fetch() 响应到达超过 30 秒会触发终结**。
  3. 事件监听器必须在 SW 全局同步注册，异步注册会丢事件。
  4. 全局变量随 SW 终结丢失，持久数据走 `chrome.storage`（SW 不支持 Web Storage）。
  5. 跨浏览器异步响应的安全姿势：监听器同步 `return true` + 后续 `sendResponse`（MDN 明示 Promise 式响应在 Chrome 受限）。
  6. Chrome 110+ 起事件与扩展 API 调用都重置空闲计时，「只要在活跃处理事件」SW 就保持存活。
- **对本项目的核验结论**：
  - `service-worker.js` 全部监听器顶层同步注册 ✔（符合 3）。
  - 消息处理全部 `return true` + `sendResponse` ✔（符合 5，Firefox 亦可用）。
  - SW 无关键全局变量状态（唯一全局 `cacheWriteChain` 是写锁，丢失只影响极窄竞态窗口）✔（符合 4）。
  - 重试预算：`timeoutMs` 默认 8s × 3 次 + 退避 0.4s/1.2s ≈ 25.6s < 30s fetch 红线；SERP 批量最坏 2 波 ≈ 52s < 5 分钟上限 ✔（符合 2）。
- **采纳**：维持现状；`timeoutMs` 上限 30s（设置页夹紧）在 3 次重试时总预算可达 94s，**仍 < 5min 但 fetch 单次 30s 红线由 AbortController 保证**——重试总时长不是 fetch 单次时长，无违规。无需改动。
- **待本地测试进一步验证**：无（行为已被 `09-service-worker` mock 测试覆盖；真实 SW 休眠唤醒属浏览器行为，本轮未做真实浏览器长时验证）。

## R2 uBlacklist —— 搜索引擎 DOM 适配的维护方案（对标项目）

- **要解决的问题**：`serp.js` 引擎选择器硬编码，引擎改版即失效（README 已知限制）；同类项目如何长期维护多引擎适配。
- **出处**：github.com/iorate/ublacklist（README 已核对；MIT License）。
- **参考项目的具体实现**：
  - 支持 Google/Bing/Brave/DuckDuckGo/Ecosia/Kagi/SearXNG/Startpage/Yahoo! JAPAN/Yandex 十个引擎（Web/Images/Videos/News）。
  - 引擎 DOM 适配外置为 **SERPINFO 数据格式**（`@ublacklist/serpinfo`，含格式规范），内置描述由独立仓库 `ublacklist/builtin` 维护，扩展**定期下载数据更新**（数据而非可执行代码，不违反 MV3 远程代码禁令）。
  - 明确「不再内置新引擎」，社区用 SERPINFO 自助扩展。
- **对本项目的参考价值**：把「引擎 → 容器/结果/标题/摘要选择器」从代码常量升级为**数据表**（哪怕先本地 JSON），改版只动数据不动逻辑；长期可考虑外置数据订阅。
- **采纳决定**：**部分采纳**。方向认可（选择器数据化），本轮先把 `ENGINES` 表内的查询词参数等引擎差异配置化（已完成）；完整 SERPINFO 化与远程订阅**暂不采纳**——理由：远程数据订阅引入更新通道与供应链信任面，与本项目「零依赖、无构建、最小信任面」定位冲突；当前 6 引擎的改动频率可用发版覆盖。列为 P3 探索项。
- **待验证**：SERPINFO 规范细节未逐条阅读（仅 README 级别核对），若将来采纳需读 `ublacklist/packages` 里的格式规范。

## R3 Mozilla Readability —— 正文抽取为什么不照搬

- **要解决的问题**：`extract.js` 是否应换成成熟的 Readability。
- **出处**：github.com/mozilla/readability（Apache-2.0，业界事实标准，README/实现众所周知；本轮未逐行核对源码）。
- **参考项目的具体实现**：为 Reader Mode 设计的完整抽取（评分、清洗、改写 DOM），代码量数万字级，含大量启发式与兼容补丁。
- **对本项目的参考价值**：本项目只需要「快 + 统计 + 摘录」，`extract.js` 的候选打分（正文长度 × (1-链接密度) + 段落/标题/代码块加权）已覆盖需求，<1ms 级开销。
- **采纳决定**：**不采纳替换**。理由：引入 Readability 增加体积与依赖、抽取延迟与 DOM 改写风险，而本项目判定主信号是模型而非抽取精度。**部分采纳其思想**：主节点评分与链接密度惩罚即源自同类实践。
- **待验证**：复杂页面（多主题、懒加载）抽取质量差距未量化——可作为将来评测项。

## R4 可信度标注类扩展的先行者（思路对标）

- **要解决的问题**：「在链接/搜索结果上标可信度」这个产品形态是否有人做过、怎么做的。
- **出处**：
  - Bullshit Detector（Daniel Sieradski，2016，代码开源发布于 GitHub）：维护不可信站点名单，在 Facebook/Twitter 链接上标记。
  - FiB（2016 Princeton hackathon，开源）：Facebook 信息流链接打「已核实/未核实」徽章，来源可信度 + 交叉核实。
  - 二手报道（网易/凤凰 2016）核对，原始仓库本轮未逐行核对——如实标注。
- **确认的事实**：名单驱动的链接可信度标注、SERP/信息流徽章形态均有先例；两者的公开教训是「名单维护成本高、覆盖不全」。
- **采纳决定**：思路层面确认本项目形态可行（徽章 + 来源分层 + 模型判定补名单覆盖不足）；不抄任何代码。`RS.TRUST_HIGH/TRUST_LOW` 名单定位为「初判参考」而非权威判定，与先驱的教训一致。

## R5 扩展安全静态分析工具（后续审查备选）

- **要解决的问题**：权限/注入/危险 API 的系统性检查是否有现成工具。
- **出处**：Tarnish（github.com/mandatoryprogrammer/tarnish，静态分析 Chrome 扩展：权限告警、innerHTML/eval 等危险调用、CSP、web_accessible_resources 指纹）——本轮经二手报道核对，**未安装、未执行**。
- **采纳决定**：列为后续安全审查的备选工具（P3）；本轮安全审查以人工对照 `manifest.json` + 代码走查 + `01-manifest` 测试为准。

## 结论摘要

| 编号 | 决定 | 状态 |
| --- | --- | --- |
| R1 | 后台生命周期与消息姿势符合官方语义，维持现状 | 已核验 |
| R2 | 引擎选择器数据化方向采纳（本轮做查询参数配置化），SERPINFO 订阅暂缓 | 部分采纳 |
| R3 | 不引入 Readability，保留轻量抽取 | 不采纳替换 |
| R4 | 形态有先例，名单只作初判参考 | 思路采纳 |
| R5 | Tarnish 作为后续安全审查备选 | 待验证 |
