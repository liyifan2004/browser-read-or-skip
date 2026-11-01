# 开发记录（CHANGELOG_DEV）

按轮次记录：目标、改动、技术选择、验证结果、遗留风险。不记一次性调试细节。

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
