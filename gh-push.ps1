<#
.SYNOPSIS
    在当前 git 仓库里，把当前分支推送到 GitHub（可选：不存在时先建私有库）。

.DESCRIPTION
    本机的非交互执行环境下，git 的凭据助手（git-credential-manager）起不来，
    表现为 `git push` 静默返回退出码 128、且 stdout/stderr 一个字都没有。
    这个脚本用 http.extraheader 直接把 token 放进请求头，绕过凭据助手。

.PARAMETER Repo
    GitHub 仓库全名，形如 owner/name。必须属于当前凭据对应的账号。

.PARAMETER Branch
    要推送的本地分支，默认取当前分支。

.PARAMETER Create
    指定后，如果远程仓库不存在就先建一个私有库。

.PARAMETER Proxy
    HTTPS 代理。本机直连 github.com 会失败，默认走 Clash 的 7897。

.EXAMPLE
    .\scripts\gh-push.ps1 -Repo liyifan2004/obsidian-jev-inbox-router

.EXAMPLE
    .\scripts\gh-push.ps1 -Repo liyifan2004/my-new-project -Create
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Repo,
    [string]$Branch = "",
    [switch]$Create,
    [string]$Proxy = "http://127.0.0.1:7897"
)

# 注意：不要设成 Stop。PowerShell 5.1 下原生命令写到 stderr 的进度信息
# （git push 一定会写）会被当成终止错误。这里统一用退出码判断。
$ErrorActionPreference = "Continue"

function Fail([string]$message) {
    Write-Host ""
    Write-Host "失败：$message" -ForegroundColor Red
    exit 1
}

function Step([string]$message) {
    Write-Host "==> $message"
}

if ($Repo -notmatch '^[^/]+/[^/]+$') {
    Fail "-Repo 要写成 owner/name 的形式，例如 liyifan2004/my-project"
}

# ---------------------------------------------------------------- 0. 前置检查

$insideRepo = (& git rev-parse --is-inside-work-tree 2>&1 | Out-String).Trim()
if ($insideRepo -ne "true") {
    Fail "当前目录不是 git 仓库。先在项目根目录跑 git init -b main。"
}

if (-not $Branch) {
    $Branch = (& git rev-parse --abbrev-ref HEAD 2>&1 | Out-String).Trim()
}
if (-not $Branch -or $Branch -eq "HEAD") {
    Fail "拿不到当前分支名，请用 -Branch 显式指定。"
}
Step "目标仓库 $Repo，分支 $Branch"

$helperCheck = (& git config --show-origin --get-all credential.helper 2>&1 | Out-String)
if ($helperCheck -match 'helper-selector') {
    Write-Host "提示：credential.helper 里出现了 helper-selector，git 会弹图形选择器。" -ForegroundColor Yellow
    Write-Host "      修一下：git config --system credential.helper manager" -ForegroundColor Yellow
}

# ---------------------------------------------------------------- 1. 取 token

Step "从 Windows 凭据管理器取 GitHub token"

$credInput = Join-Path $env:TEMP "gh-push-cred-in.txt"
$credOutput = Join-Path $env:TEMP "gh-push-cred-out.txt"
Set-Content -Path $credInput -Value "protocol=https`nhost=github.com`n`n" -Encoding ASCII -NoNewline

# 必须落成文件再重定向：把字符串直接管道给 git credential fill 会报
# "refusing to work with credential missing protocol field"。
# 另外 PowerShell 里 $input 是保留自动变量，不能拿来当变量名。
& cmd /c "git credential fill < `"$credInput`" > `"$credOutput`" 2>nul"
Remove-Item $credInput -Force -ErrorAction SilentlyContinue

$token = ""
if (Test-Path $credOutput) {
    $token = ((Get-Content $credOutput) | Where-Object { $_ -match '^password=' } |
        ForEach-Object { $_.Substring(9) } | Select-Object -First 1)
    Remove-Item $credOutput -Force -ErrorAction SilentlyContinue
}

if (-not $token) {
    Fail @"
凭据管理器里没有 GitHub 凭据。
  办法：在任意终端里手工 clone 一个你自己的私有库（git clone https://github.com/<你>/<某个私有库>.git），
  走一次登录，Git Credential Manager 就会把 token 存进 Windows 凭据管理器。之后本脚本就能自动取到。
"@
}
Write-Host "    拿到 token（$($token.Length) 字符，前缀 $($token.Substring(0, [Math]::Min(4, $token.Length)))…）"

# ---------------------------------------------------------------- 2. 校验 token

Step "校验 token"

$whoOut = Join-Path $env:TEMP "gh-push-who.json"
$code = & curl.exe -s -o $whoOut -w "%{http_code}" --max-time 30 -x $Proxy `
    -H "Authorization: Bearer $token" -H "User-Agent: gh-push-script" `
    -H "Accept: application/vnd.github+json" "https://api.github.com/user"
if ($code -ne "200") {
    Fail "token 校验失败（HTTP $code）。多半是过期或没有 repo 权限。原始响应：`n$(Get-Content $whoOut -Raw)"
}
$login = ((Get-Content $whoOut -Raw) | ConvertFrom-Json).login
Remove-Item $whoOut -Force -ErrorAction SilentlyContinue
Write-Host "    身份：$login"

$owner = $Repo.Split("/")[0]
if ($owner -ne $login) {
    Fail "仓库属主是 $owner，但凭据属于 $login。这个脚本只能操作自己账号下的仓库。"
}

# ---------------------------------------------------------------- 3. 建库（可选）

$repoBase = "https://api.github.com/repos/$Repo"
$existsOut = Join-Path $env:TEMP "gh-push-exists.json"
$existsCode = & curl.exe -s -o $existsOut -w "%{http_code}" --max-time 30 -x $Proxy `
    -H "Authorization: Bearer $token" -H "User-Agent: gh-push-script" $repoBase
Remove-Item $existsOut -Force -ErrorAction SilentlyContinue

if ($existsCode -eq "404") {
    if (-not $Create) {
        Fail "远程仓库 $Repo 不存在。加 -Create 让脚本先建一个私有库。"
    }
    Step "远程仓库不存在，创建私有库 $Repo"

    $bodyPath = Join-Path $env:TEMP "gh-push-body.json"
    $body = @{ name = $Repo.Split("/")[1]; private = $true; auto_init = $false } | ConvertTo-Json -Compress
    # 必须无 BOM：Set-Content -Encoding UTF8 会写 BOM，GitHub 会回 "Problems parsing JSON"
    [System.IO.File]::WriteAllText($bodyPath, $body, (New-Object System.Text.UTF8Encoding($false)))

    $createOut = Join-Path $env:TEMP "gh-push-create.json"
    $createCode = & curl.exe -s -o $createOut -w "%{http_code}" --max-time 60 -X POST -x $Proxy `
        -H "Authorization: Bearer $token" -H "User-Agent: gh-push-script" `
        -H "Accept: application/vnd.github+json" -H "Content-Type: application/json" `
        --data-binary "@$bodyPath" "https://api.github.com/user/repos"
    Remove-Item $bodyPath -Force -ErrorAction SilentlyContinue

    if ($createCode -ne "201") {
        Fail "建库失败（HTTP $createCode）：`n$(Get-Content $createOut -Raw)"
    }
    Remove-Item $createOut -Force -ErrorAction SilentlyContinue
    Write-Host "    已创建私有库 https://github.com/$Repo"
} elseif ($existsCode -eq "200") {
    Step "远程仓库已存在"
} else {
    Fail "查询仓库失败（HTTP $existsCode）。检查 Clash 是否在跑（$Proxy 是否可连）。"
}

# ---------------------------------------------------------------- 4. 对齐 remote

$remoteUrl = (& git remote get-url origin 2>&1 | Out-String).Trim()
if ($LASTEXITCODE -ne 0) {
    Step "添加 remote origin"
    & git remote add origin "https://github.com/$Repo.git"
} elseif ($remoteUrl -notmatch [regex]::Escape($Repo)) {
    Fail @"
origin 已经指向别的仓库，脚本不擅自改：
  现在：$remoteUrl
  期望：https://github.com/$Repo.git
  要改的话自己跑：git remote set-url origin https://github.com/$Repo.git
"@
} else {
    Step "remote origin 已指向 $Repo"
}

# ---------------------------------------------------------------- 5. 推送

Step "推送 $Branch（用 extraheader 带 token，绕过凭据助手）"

$b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$token"))
$env:GIT_TERMINAL_PROMPT = "0"

& git -c "http.https://github.com/.extraheader=Authorization: Basic $b64" push -u origin $Branch
$pushCode = $LASTEXITCODE
& git -c "http.https://github.com/.extraheader=Authorization: Basic $b64" ls-remote --heads "https://github.com/$Repo.git" | Out-Null
$lsCode = $LASTEXITCODE

if ($pushCode -ne 0) {
    Fail @"
推送失败（退出码 $pushCode）。
  先确认 Clash 在运行（gitconfig 里 GitHub 专用代理是 $Proxy）。
  代理在但很慢 → 换一个 Clash 节点重试一次。
  认证失败 → 不要反复试，先确认凭据是否是同一个账号（第 2 步的校验会拦住这种情况）。
"@
}
if ($lsCode -ne 0) {
    Fail "推送返回 0，但 ls-remote 复核失败（退出码 $lsCode）。到网页上确认一次再继续。"
}

Write-Host ""
Write-Host "完成：https://github.com/$Repo （分支 $Branch）" -ForegroundColor Green
