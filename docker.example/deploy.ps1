<#
.SYNOPSIS
  Build and start the Our Home web app and verify it responds.

.DESCRIPTION
  This compose file runs the web app only. MongoDB (a replica set) runs on its
  own, reached via SERVER_DATABASE_URL. Reminders run inside the web app. This
  script waits until the app responds, instead of the bare `docker compose up -d`
  that returns before it is ready.

  Settings live in the single repo-root .env (shared with local dev). This
  script verifies it exists but never creates or edits it, and passes it to
  compose with --env-file.

  On a fresh database, open the printed address: the setup page creates the
  admin and the household's accounts.

  The bash twin is deploy.sh.

.PARAMETER NoBuild
  Skip rebuilding the image; just (re)start the app.

.PARAMETER Timeout
  Seconds to wait for health checks (default 180).

.EXAMPLE
  .\deploy.ps1

.EXAMPLE
  .\deploy.ps1 -NoBuild -Timeout 240
#>
[CmdletBinding()]
param(
  [switch]$NoBuild,
  [int]$Timeout = 180,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Run from this script's directory (= docker\) so all compose paths resolve.
# ---------------------------------------------------------------------------
Set-Location -LiteralPath $PSScriptRoot
$script:EnvFile = '..\.env'   # the repo-root .env, shared with local dev

# Best-effort UTF-8 so the box-drawing / check glyphs render.
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ---------------------------------------------------------------------------
# Colour setup — ANSI, disabled when NO_COLOR is set, output is redirected, or
# the host is a legacy console that won't render virtual-terminal sequences.
# ---------------------------------------------------------------------------
$script:IsTty = -not [Console]::IsOutputRedirected
$enableColor = $true
if ($env:NO_COLOR) { $enableColor = $false }
elseif (-not $script:IsTty) { $enableColor = $false }
elseif (-not ($env:WT_SESSION -or ($env:TERM_PROGRAM -eq 'vscode') -or ($PSVersionTable.PSVersion.Major -ge 6))) { $enableColor = $false }

if ($enableColor) {
  $e = [char]27
  $script:Reset = "$e[0m"; $script:Bold = "$e[1m"; $script:Dim = "$e[2m"
  $script:Red = "$e[31m"; $script:Green = "$e[32m"; $script:Yellow = "$e[33m"
  $script:Blue = "$e[34m"; $script:Magenta = "$e[35m"; $script:Cyan = "$e[36m"
} else {
  $script:Reset = ''; $script:Bold = ''; $script:Dim = ''
  $script:Red = ''; $script:Green = ''; $script:Yellow = ''
  $script:Blue = ''; $script:Magenta = ''; $script:Cyan = ''
}

# ---------------------------------------------------------------------------
# Container names (from docker-compose.yml).
# ---------------------------------------------------------------------------
$script:CWeb = 'ourhome_web'

$script:ComposeV1  = $false
$script:ComposeStr = 'docker compose'
$script:StepN = 0
$script:StepTotal = 4
$script:SpinFrames = '-\|/'
$script:SpinI = 0

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
function Write-Ok   { param($m) Write-Host ("  {0}{1}{2} {3}" -f $script:Green,  [char]0x2713, $script:Reset, $m) }
function Write-Warn { param($m) Write-Host ("  {0}!{1} {2}"   -f $script:Yellow, $script:Reset, $m) }
function Write-Note { param($m) Write-Host ("  {0}.{1} {2}"   -f $script:Cyan,   $script:Reset, $m) }
function Write-Err  { param($m) Write-Host ("  {0}{1}{2} {3}" -f $script:Red,    [char]0x2717, $script:Reset, $m) }

function Stop-Deploy {
  param($m)
  Write-Err $m
  Write-Host ("`n{0}Deploy aborted.{1}  Inspect logs with: {2}{3} logs -f{1}" -f `
    ($script:Red + $script:Bold), $script:Reset, $script:Bold, $script:ComposeStr)
  exit 1
}

function Write-Step {
  param($m)
  $script:StepN++
  Write-Host ("`n{0}[{1}/{2}]{3} {4}{5}{6}" -f `
    $script:Dim, $script:StepN, $script:StepTotal, $script:Reset, $script:Bold, $m, $script:Reset)
}

function Show-Help {
  Write-Host @"
$($script:Bold)Our Home - Docker deploy (web app)$($script:Reset)

Builds and starts the web app, then waits until it responds.

$($script:Bold)Usage:$($script:Reset)
  .\deploy.ps1 [-NoBuild] [-Timeout <seconds>] [-Help]

$($script:Bold)Options:$($script:Reset)
  -NoBuild           Skip rebuilding the image; just (re)start the app.
  -Timeout <sec>     How long to wait for health checks (default: 180).
  -Help              Show this help and exit.

The settings file .env (repo root) must already exist.
"@
}

function Show-Banner {
  Write-Host ($script:Magenta + $script:Bold)
  Write-Host '  ╔══════════════════════════════════════════════════╗'
  Write-Host '  ║            O U R   H O M E   ·   deploy           ║'
  Write-Host '  ╚══════════════════════════════════════════════════╝'
  Write-Host $script:Reset -NoNewline
  Write-Host ("  {0}web app{1}" -f $script:Dim, $script:Reset)
}

# ---------------------------------------------------------------------------
# Spinner / wait helpers
# ---------------------------------------------------------------------------
function Update-Spinner {
  param($Label, $Elapsed)
  if (-not $script:IsTty) { return }
  $f = $script:SpinFrames[$script:SpinI % $script:SpinFrames.Length]
  $script:SpinI++
  Write-Host ("`r  {0}{1}{2} waiting for {3}... {4}s " -f $script:Cyan, $f, $script:Reset, $Label, $Elapsed) -NoNewline
}

function Clear-SpinnerLine {
  if ($script:IsTty) { Write-Host ("`r" + (' ' * 64) + "`r") -NoNewline }
}

function Wait-ForCondition {
  param([string]$Label, [int]$TimeoutSec, [scriptblock]$Check)
  $start = Get-Date
  if (-not $script:IsTty) { Write-Note "waiting for $Label..." }
  while ($true) {
    if (& $Check) { Clear-SpinnerLine; Write-Ok $Label; return $true }
    $elapsed = [int]((Get-Date) - $start).TotalSeconds
    if ($elapsed -ge $TimeoutSec) {
      Clear-SpinnerLine; Write-Err "$Label (timed out after ${TimeoutSec}s)"; return $false
    }
    Update-Spinner $Label $elapsed
    Start-Sleep -Milliseconds 500
  }
}

# ---------------------------------------------------------------------------
# Docker / compose helpers
# ---------------------------------------------------------------------------
function Invoke-Compose {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$CArgs)
  if ($script:ComposeV1) { & docker-compose --env-file $script:EnvFile @CArgs } else { & docker compose --env-file $script:EnvFile @CArgs }
}

function Get-ContainerStatus {
  param($Name)
  $v = (& docker inspect -f '{{.State.Status}}' $Name 2>$null)
  if ($null -eq $v) { return '' }
  return ($v | Select-Object -First 1).ToString().Trim()
}

function Get-ContainerHealth {
  param($Name)
  $v = (& docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}-{{end}}' $Name 2>$null)
  if ($null -eq $v) { return '-' }
  return ($v | Select-Object -First 1).ToString().Trim()
}

function Test-WebUp {
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri $script:WebUrlLocal | Out-Null
    return $true
  } catch [System.Net.WebException] {
    # An HTTP response (even 4xx/5xx) means the server is up; only connection
    # failures mean it is not listening yet.
    if ($_.Exception.Response) { return $true }
    return $false
  } catch {
    return $false
  }
}

function Get-EnvValue {
  param($Key, $File = $script:EnvFile)
  if (-not (Test-Path -LiteralPath $File)) { return $null }
  $pattern = '^\s*{0}=' -f [regex]::Escape($Key)
  $match = Get-Content -LiteralPath $File | Where-Object { $_ -match $pattern } | Select-Object -Last 1
  if (-not $match) { return $null }
  $v = $match -replace $pattern, ''
  return $v.Trim().Trim('"').Trim("'")
}

function Write-Row {
  param($Label, $Container)
  $st = Get-ContainerStatus $Container; if (-not $st) { $st = 'absent' }
  $h  = Get-ContainerHealth $Container; if (-not $h) { $h = '-' }
  $color = switch ($st) { 'running' { $script:Green } 'exited' { $script:Dim } default { $script:Yellow } }
  $hs = if ($h -eq '-') { '' } else { "($h)" }
  Write-Host ("    {0,-24} {1}{2,-10}{3} {4}" -f $Label, $color, $st, $script:Reset, $hs)
}

# ===========================================================================
if ($Help) { Show-Help; exit 0 }
if ($Timeout -le 0) { Write-Host 'error: -Timeout must be a positive integer'; exit 2 }

Show-Banner

# --- [1/4] Preflight ------------------------------------------------------
Write-Step 'Preflight checks'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Stop-Deploy 'Docker is not installed or not on PATH.'
}
$dockerVersion = (& docker --version 2>$null | Select-Object -First 1)
Write-Ok "docker found ($dockerVersion)"

& docker info *> $null
if ($LASTEXITCODE -ne 0) { Stop-Deploy 'Docker daemon is not reachable. Is Docker Desktop running?' }
Write-Ok 'Docker daemon is running'

& docker compose version *> $null
if ($LASTEXITCODE -eq 0) {
  $script:ComposeV1 = $false; $script:ComposeStr = 'docker compose'
} elseif (Get-Command docker-compose -ErrorAction SilentlyContinue) {
  $script:ComposeV1 = $true; $script:ComposeStr = 'docker-compose'
} else {
  Stop-Deploy "Docker Compose v2 not found (need 'docker compose')."
}
Write-Ok "Compose available ($($script:ComposeStr))"

if (-not (Test-Path -LiteralPath 'docker-compose.yml')) {
  Stop-Deploy "docker-compose.yml not found in $PSScriptRoot."
}

if (-not (Test-Path -LiteralPath $script:EnvFile)) {
  Stop-Deploy 'Missing .env in the repo root - copy .env.example to .env and fill it in.'
}
Write-Ok 'Settings file present (..\.env)'

# Soft placeholder warnings (do not block).
if (Select-String -Path $script:EnvFile -Pattern 'replace-with|change-me' -Quiet) {
  Write-Warn '.env still contains placeholder values (replace-with... / change-me).'
}

# Resolve ports / URL from .env (fall back to compose defaults).
$webPort = Get-EnvValue 'WEB_HOST_PORT';   if (-not $webPort) { $webPort = '3000' }
$authUrl = Get-EnvValue 'PUBLIC_URL'
$webBind = Get-EnvValue 'WEB_BIND';        if (-not $webBind) { $webBind = '0.0.0.0' }
# This machine's address on the home network, for the "open it here" hint.
$lanIp = $null
try {
  $lanIp = Get-NetIPConfiguration -ErrorAction Stop |
    Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
    ForEach-Object { $_.IPv4Address.IPAddress } | Select-Object -First 1
} catch {}
$script:WebUrlLocal = "http://127.0.0.1:$webPort/"

# Shared Docker network (compose declares it external). Create it if missing.
$net = Get-EnvValue 'DOCKER_NETWORK'; if (-not $net) { $net = 'ourhome_net' }
& docker network inspect $net *> $null
if ($LASTEXITCODE -eq 0) {
  Write-Ok "Docker network present ($net)"
} else {
  & docker network create $net *> $null
  if ($LASTEXITCODE -ne 0) { Stop-Deploy "Could not create Docker network '$net'." }
  Write-Ok "Docker network created ($net)"
}

# --- [2/4] Build & start --------------------------------------------------
if ($NoBuild) {
  Write-Step 'Start web app (no rebuild)'
  Invoke-Compose up -d
  if ($LASTEXITCODE -ne 0) { Stop-Deploy "'$($script:ComposeStr) up -d' failed." }
} else {
  Write-Step 'Build & start web app'
  Invoke-Compose up -d --build
  if ($LASTEXITCODE -ne 0) { Stop-Deploy "'$($script:ComposeStr) up -d --build' failed." }
}
Write-Ok 'Containers created/started'

# --- [3/4] Health verification -------------------------------------------
Write-Step "Verify health (timeout ${Timeout}s)"
if (-not (Wait-ForCondition "Web app (HTTP :$webPort)" $Timeout { Test-WebUp })) {
  Stop-Deploy 'Web app did not start responding.'
}

# --- [4/4] Summary --------------------------------------------------------
Write-Step 'Summary'
Write-Row 'web' $script:CWeb

Write-Host ("`n  {0}{1}{2} web app is up{3}" -f $script:Green, $script:Bold, [char]0x2713, $script:Reset)
Write-Host ("    {0,-18} {1}" -f 'On this machine:', "http://localhost:$webPort/")
if ($webBind -ne '127.0.0.1' -and $lanIp) {
  Write-Host ("    {0,-18} {1}" -f 'On your network:', "http://${lanIp}:$webPort/")
}
if ($authUrl) { Write-Host ("    {0,-18} {1}" -f 'Public URL:', $authUrl) }

# --- Next steps -----------------------------------------------------------
Write-Host ("`n  {0}First run?{1} Open one of the addresses above. The setup page creates" -f $script:Bold, $script:Reset)
Write-Host '  the admin account, then the rest of the household.'
Write-Host ("    - Follow logs:   {0} logs -f web`n" -f $script:ComposeStr)
