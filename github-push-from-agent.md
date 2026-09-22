# 从非交互环境把代码推到 GitHub

适用场景：Agent（或任何非交互的脚本环境）要往 GitHub 推代码，`git push` 什么都没干就失败了。

## 一、先确认你遇到的是这个问题

三条都符合，就是这个坑：

| 现象 | 说明 |
|---|---|
| `git push` 退出码 **128**，stdout 和 stderr **一个字都没有** | 不是网络错，网络错会打印 `Could not resolve host` 之类 |
| `git ls-remote https://github.com/git/git.git`（公开仓库）**正常** | 说明网络、TLS、`git-remote-https` 都没毛病 |
| 开 `GIT_TRACE=1` 后，trace 停在 `run_command: 'git credential-manager get'` 之后没有下文 | 决定性证据 |

## 二、原因

访问私有仓库时，git 第一步会收到 **401**，于是它要去找凭据助手要账号密码：
`git credential-manager get`。

在非交互环境里这个助手拿不到输入（没有 TTY），起不来。git 等不到凭据，直接退出——
**而且不打印任何错误信息**。这就是"退出码 128 + 零输出"的来源。

公开仓库不需要凭据，所以能正常 `ls-remote`。这一点最容易把人带到错误的方向（去查证书、代理、git 版本）。

## 三、解决办法：把 token 放进请求头，跳过凭据助手

git 支持按 URL 前缀注入额外 HTTP 头。直接在头里带上 Basic 认证，第一发请求就是 200，根本不需要凭据助手。

```powershell
$token = "<你的 GitHub token>"
$b64   = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$token"))
git -c "http.https://github.com/.extraheader=Authorization: Basic $b64" push -u origin main
```

成功的标志：输出里有 `unpack ok` / `ok refs/heads/main`，或者（已经推过时）`Everything up-to-date`。

三条注意：

- **token 只走命令行参数，不要写进 `.git/config`**。`origin` 的 URL 保持干净。
- 用 `-c` 传参，它是本次命令生效，不会落盘。
- 别用 `git push --force`，失败就停下来看原因。

## 四、现成脚本（推荐）

本项目 `scripts/gh-push.ps1` 把整套流程包好了，包括建私有库。整个脚本复制到你的项目里即可，无外部依赖。

```powershell
# 仓库已存在，只推送当前分支
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gh-push.ps1 -Repo <owner>/<name>

# 仓库不存在时先建私有库，再推送
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gh-push.ps1 -Repo <owner>/<name> -Create
```

可加参数：`-Branch <分支名>`（默认取当前分支）、`-Proxy <地址>`（默认 `http://127.0.0.1:7897`）。

脚本做五件事，任何一步不满足就带原因退出：

1. 前置检查：是不是 git 仓库、当前分支是什么、`credential.helper` 有没有被写成 `helper-selector`
2. 从 Windows 凭据管理器取 token（取不到就告诉你怎么让它存一次）
3. 用 `GET /user` 校验 token，并确认仓库属主和凭据账号一致
4. 仓库不存在且给了 `-Create` → 调 REST API 建私有库；`origin` 指向别的仓库时拒绝擅改
5. `extraheader` 推送，然后 `ls-remote` 复核一遍

## 五、不想用脚本时的手工三步

第 1 步，取 token（**必须落成文件再重定向**）：

```powershell
Set-Content "$env:TEMP\in.txt" -Value "protocol=https`nhost=github.com`n`n" -Encoding ASCII -NoNewline
$raw   = cmd /c "git credential fill < `"$env:TEMP\in.txt`""
$token = ($raw -split "`r?`n" | Where-Object { $_ -match '^password=' } | ForEach-Object { $_.Substring(9) } | Select-Object -First 1)
```

两个坑：把字符串**直接管道**给 `git credential fill` 会报 `refusing to work with credential missing protocol field`；
PowerShell 里 **`$input` 是保留自动变量**，不能拿来当变量名。

第 2 步，建私有库（没有 `gh` CLI 时）：

```powershell
$body = @{ name = "<name>"; private = $true; auto_init = $false } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText("$env:TEMP\body.json", $body, (New-Object System.Text.UTF8Encoding($false)))
curl.exe -s -X POST -x http://127.0.0.1:7897 `
  -H "Authorization: Bearer $token" -H "User-Agent: agent" `
  -H "Accept: application/vnd.github+json" -H "Content-Type: application/json" `
  --data-binary "@$env:TEMP\body.json" https://api.github.com/user/repos
```

**`Set-Content -Encoding UTF8` 在 Windows PowerShell 5.1 下会写 BOM**，GitHub 会回
`{"message":"Problems parsing JSON"}`。必须用 `[System.IO.File]::WriteAllText` + `UTF8Encoding($false)`。

第 3 步，推送（见第三节那行命令）。

## 六、前置条件（三项，缺一项就失败）

1. **代理在跑**。本机直连 `github.com` 必失败。用户用的是 Clash Verge，端口 **7897**（http 与 socks5 同端口）。托盘有图标才算在跑。
2. **git 配了 GitHub 专用代理**。检查：
   ```
   git config --get http.https://github.com.proxy     # 期望 http://127.0.0.1:7897
   ```
   没有就补上；不要用 `http.proxy` 全局代理（会连累 gitee / gitlab）。
3. **凭据管理器里存过 GitHub 凭据**。检查：
   ```
   git config --show-origin --get-all credential.helper   # 期望只有一项、值为 manager
   ```
   取不到 token 时，最省事的办法是**手工 clone 一次你自己的私有库**，走完登录，Git Credential Manager 就会把 token 存进去。

顺带一提：如果 `credential.helper` 的值是 `helper-selector`，每次需要凭据都会弹一个图形选择窗口。修：
`git config --system credential.helper manager`。

## 七、失败排查表

| 现象 | 原因 | 处理 |
|---|---|---|
| 退出码 128，零输出 | 本文描述的问题 | 用 `extraheader` |
| `Could not resolve host` / `Failed to connect` | Clash 没在跑，或节点挂了 | 开 Clash / 换节点后重试**一次** |
| `schannel: failed to receive handshake` | 代理节点质量差 | 换节点 |
| 401 / `Authentication failed` | token 过期、或凭据属于另一个账号 | 别反复试，重新登录一次让凭据刷新 |
| `403 Must have admin rights` | token 的 scope 不含 `delete_repo` | 删仓库只能到网页上操作 |
| `rejected` / `non-fast-forward` | 远程有你没有的提交 | 先 `git pull` 合并再推；**不要 force push** |
| 卡住 5 分钟没输出 | 代理慢 | 中断，换节点，重试一次 |

## 八、已经试过、确认无效的方案（别再花时间）

以下四种都实测失败，根因都是"git 还是会去找凭据助手"：

| 试过的做法 | 结果 |
|---|---|
| 把 token 拼进 URL：`https://x-access-token:TOKEN@github.com/...` | 仍然 128，零输出 |
| 关沙箱重跑（`dangerouslyDisableSandbox`） | 仍然 128——**和沙箱无关** |
| `Start-Process` 重定向 stdout/stderr 到文件 | 什么都抓不到 |
| `cmd /c "git push ..."` 包一层 | 同样是 128 |

## 九、给另一个项目的 Agent 的交接语

把本文件和 `scripts/gh-push.ps1` 复制到那个项目里，然后把下面这段直接发给它：

> 项目里的 `scripts/gh-push.ps1` 和 `docs/github-push-from-agent.md` 是现成的。
> 先读那个 md 了解原理和前置条件，然后执行：
> `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gh-push.ps1 -Repo liyifan2004/<仓库名> -Create`
> 完成后把脚本的**完整输出**贴给我。不要自己另写推送脚本，也不要改 `origin` 的 URL。
