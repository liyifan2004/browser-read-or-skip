# Read or Skip

浏览器扩展（Chrome / Edge，Manifest V3）。打开网页后立刻判断这个页面**值得认真读 / 快速扫 / 可以跳过**，并给出相关度、新信息程度、阅读价值、信息可信度。在搜索结果页上直接给每条结果打等级。

判定由 [TypeSafe AI 的 Jev 决策模型](https://typesafe.ai) 完成 —— 它不生成文字，只返回可被代码直接使用的结构化决策（概率、选项、评分），所以足够快、足够便宜。

## 实测数据

在本机（Windows，中国大陆网络直连 `api.typesafe.ai`）实测：

| 环节 | 耗时 |
| --- | --- |
| 本地启发式初判（URL + DOM 结构 + 主题词重合） | < 50 ms |
| Jev 返回完整网页判定（8 个问题并发） | 约 300–400 ms |
| Jev 返回单条搜索结果判定（4 个问题） | 约 270 ms |
| 命中缓存 / 搜索结果预判 | < 20 ms |

单页输入约 1.8k–5.5k tokens，按 $0.042 / 百万输入 token 计（输出免费），折算**每页约 ¥0.0005**。

## 功能

**1. 页面判定浮层**

右下角悬浮卡片，四根指标条 + 综合评分环：

- 相关度 — 相对你在设置里写的「当前关注主题」
- 新信息程度 — 对已经跟这个方向的人有多新
- 可信度 — 署名、出处、一手来源、内容农场特征
- 时效性 — 多久之后会过时
- 阅读价值 — 高 / 中 / 低
- 综合判定 — 值得认真读 / 快速扫 / 可以跳过

叠加警告：内容与你已掌握的高度重复时显示「⚠️ 可能没有太多新信息」；标题与内容不符或属于商业页 / 登录墙时单独提示；模型置信度偏低时也会明说。

卡片可拖动、可收起成角标、可关闭本次显示。`Alt + Shift + R` 或 `Esc` 控制。

**2. 搜索结果标注**

在 Google / Google 香港 / 必应 / 百度 / 搜狗 / DuckDuckGo / Brave 的结果页上，给每条自然结果标题前插一枚等级徽章（如「值得读 · 87%」），悬停看详情。列表顶部有一行汇总：值得读几条、可扫几条、可跳过几条。

**3. 预判加速**

搜索结果页的评估结果按 URL 写进缓存。点进某条结果时，浮层直接命中缓存，20ms 内出结论，然后后台用正文换成更准的判定。

**4. 其他**

- 站点黑名单（邮箱、网盘、登录页默认排除）
- 隐私模式：可切换为「只发送标题与摘要」
- 本地 LRU 缓存，默认 7 天有效、300 条上限
- 用量统计（页数、调用次数、token、估算花费）
- 404 / 401 / 422 / 429 / 529 分别有明确的错误文案与退避重试

## 安装

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择本仓库根目录
4. 点扩展图标 → 「打开设置」

## 配置 API Key

Jev 目前是早期访问（waitlist）。获取步骤：

1. 在 <https://typesafe.ai> 申请早期访问
2. 拿到权限后登录 <https://console.typesafe.ai>
3. 左侧 **API Keys** → **Create key**
4. 复制形如 `apikey_xxxxxxxx_xxxxxxxx` 的字符串

两种填法，任选其一：

- **设置页填**：扩展图标 → 设置 → 「TypeSafe API Key」→ 点「测试连接」确认 → 保存。Key 存在 `chrome.storage.local`，只在本机。
- **文件填**：`cp src/lib/config.example.js src/lib/config.js`，把 Key 写进 `apiKey` 字段。`config.js` 已被 `.gitignore` 排除，不会进仓库。

设置页的「测试连接」会发一次最小请求，同时把往返延迟打印出来 —— 那就是你机器上浮层判定的典型耗时。

## 工作原理

```
网页加载
  │
  ├─ document_start  注入内容脚本（Shadow DOM，不污染宿主页样式）
  │
  ├─ 命中缓存 / 搜索结果预判 ──────────────► 立即渲染（< 20ms）
  │
  ├─ DOMContentLoaded 抽取正文 + 本地启发式 ► 渲染估算结果（< 50ms，标注「本地估算」）
  │
  └─ 发消息给 service worker
        ├─ 唯一持有 Key、唯一发起跨域请求（绕过页面 CORS 限制）
        ├─ POST api.typesafe.ai/v1/systemone
        │    state    = { url, title, domain, 正文摘录, focusTopics, 结构统计 }
        │    questions = 8 个并发问题（3 个 score / 3 个 choice / 2 个 noul）
        ├─ 解析 answers → 归一化成 verdict + 四个百分比 + 理由
        ├─ 写缓存、记用量、画工具栏徽章
        └─ 返回 ──────────────────────────► 原地升级卡片（约 300–400ms）
```

Jev 的三种问题原语对应三种用途：

| 原语 | 用途 | 本项目的问法 |
| --- | --- | --- |
| `score` | 有序等级打分 | 相关度、新信息程度、可信度、时效性 |
| `choice` | 从选项里挑一个 | 综合判定、阅读价值、内容类型 |
| `noul` | 是 / 否 + 概率 | 「内容与你已掌握的高度重复」 |

模型不产出文字，所以卡片上的「理由」是本地从各分量拼装的，不是生成的，也不会编造。

## 目录结构

```
manifest.json
icons/                     图标（由 tools/make_icons.py 生成）
src/
  lib/
    namespace.js           全局命名空间（最先加载）
    config.example.js      配置模板
    config.js              本地密钥（gitignored）
    constants.js           枚举、默认设置、域名可信度表
    jev.js                 Jev 客户端（重试、退避、答案解析）
    storage.js             设置 / LRU 缓存 / 统计
    questions.js           8 个问题的定义 + 结果归一化
    heuristics.js          本地启发式打分
    extract.js             正文抽取（正文候选打分，非完整 Readability）
  background/
    service-worker.js      消息路由、跨域调用、徽章
  content/
    hud.js                 页面浮层
    serp.js                搜索结果标注
  popup/                   工具栏弹窗
  options/                 设置页
tools/
  make_icons.py            生成 PNG 图标（纯标准库）
  test_jev.mjs             用真实 API 跑三个场景，验证问法与映射
  bench_latency.mjs        输入长度对延迟的影响
```

## 开发与自测

```bash
# 用真实 API 验证判定质量（会打印 Jev 的原始 answers）
node tools/test_jev.mjs

# 输入长度与延迟关系
node tools/bench_latency.mjs
```

改了 `src/lib/` 下的内容脚本或 service worker 后，需要在 `chrome://extensions` 里点一次扩展的刷新按钮，再刷新目标网页。

## 隐私

- API Key 只存在本机 `chrome.storage.local`，或本地的 `src/lib/config.js`
- 除 `api.typesafe.ai` 外，扩展不向任何域名发请求，没有统计上报
- 默认发送正文摘录（上限 6000 字符）。可以在设置里切到「仅标题与摘要」
- 邮箱、网盘、登录页、`localhost` 默认不评估
- 所有判定结果只写在本机缓存里；「清空缓存」可一键删除

## 已知限制

- Jev 无自托管选项，必须联网
- 内容脚本读不到跨域 iframe 和需要登录才有正文的页面，这类页面会走「本地估算」
- 搜索结果页的 DOM 结构由各搜索引擎决定，改版后需要更新 `src/content/serp.js` 里的选择器
- 「新信息程度」是模型的估计，不是真的比对你读过的东西 —— 除非你在设置里把关注主题写细
- 首次调用可能有 0.5–1s 冷启动，之后稳定在 300–400ms

## License

MIT
