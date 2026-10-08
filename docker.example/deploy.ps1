<#
.SYNOPSIS
  Our Home deploy on Windows: runs deploy.sh (the one installer) through Git
  Bash, or WSL when Git Bash isn't installed.

.DESCRIPTION
  deploy.sh does everything: the settings walkthrough, the service stacks
  (MongoDB, Paperless-ngx, Proton Bridge), the web app build and start, and
  the Paperless setup. This wrapper only finds a bash and hands over, mapping
  the PowerShell-style options below to deploy.sh's flags. Any other
  arguments are passed through as they are (e.g. .\deploy.ps1 --timeout 300).

  Git Bash comes with Git for Windows (https://git-scm.com/download/win);
  Docker Desktop must be running either way.

.PARAMETER NoCache
  Rebuild every layer and re-pull the base image (-n).

.PARAMETER Local
  Build from this checkout instead of GitHub (-l).

.PARAMETER Branch
  Git branch to build (-b).

.PARAMETER Setup
  Go straight to the settings walkthrough (-s).

.PARAMETER Yes
  Don't ask about settings; just deploy (-y).

.PARAMETER NoBuild
  Skip rebuilding the image; just (re)start the app (--no-build).

.PARAMETER Timeout
  Seconds to wait for health checks (--timeout).

.EXAMPLE
  .\deploy.ps1 -Setup
#>
[CmdletBinding()]
param(
  [Alias('n')][switch]$NoCache,
  [Alias('l')][switch]$Local,
  [Alias('b')][string]$Branch = '',
  [Alias('s')][switch]$Setup,
  [Alias('y')][switch]$Yes,
  [switch]$NoBuild,
  [int]$Timeout = 0,
  [Alias('h')][switch]$Help,
  [Parameter(ValueFromRemainingArguments = $true)][string[]]$Rest = @()
)

$ErrorActionPreference = 'Stop'

$bashArgs = @()
if ($NoCache) { $bashArgs += '-n' }
if ($Local)   { $bashArgs += '-l' }
if ($Branch)  { $bashArgs += @('-b', $Branch) }
if ($Setup)   { $bashArgs += '-s' }
if ($Yes)     { $bashArgs += '-y' }
if ($NoBuild) { $bashArgs += '--no-build' }
if ($Timeout -gt 0) { $bashArgs += @('--timeout', "$Timeout") }
if ($Help)    { $bashArgs += '-h' }
$bashArgs += $Rest

# Git Bash: the usual install folders, or next to git.exe on PATH.
function Find-GitBash {
  $candidates = @(
    (Join-Path $env:ProgramFiles 'Git\bin\bash.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\Git\bin\bash.exe')
  )
  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($git) { $candidates += (Join-Path (Split-Path (Split-Path $git.Source)) 'bin\bash.exe') }
  foreach ($c in $candidates) { if ($c -and (Test-Path -LiteralPath $c)) { return $c } }
  return $null
}

$script = Join-Path $PSScriptRoot 'deploy.sh'
$gitBash = Find-GitBash
if ($gitBash) {
  & $gitBash $script @bashArgs
  exit $LASTEXITCODE
}

# WSL: needs a distribution and Docker Desktop's WSL integration turned on.
$wsl = Get-Command wsl.exe -ErrorAction SilentlyContinue
if ($wsl) {
  & wsl.exe -e true *> $null
  if ($LASTEXITCODE -eq 0) {
    $wslPath = (& wsl.exe -e wslpath -a ($script -replace '\\', '/')).Trim()
    & wsl.exe -e bash $wslPath @bashArgs
    exit $LASTEXITCODE
  }
}

Write-Host 'deploy.ps1 needs bash to run deploy.sh. Install one of:'
Write-Host '  - Git for Windows (includes Git Bash): https://git-scm.com/download/win'
Write-Host '  - WSL: wsl --install   (then turn on WSL integration in Docker Desktop)'
Write-Host 'and run .\deploy.ps1 again.'
exit 1
