param(
  [switch]$OpenBrowser
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$LogDir = Join-Path $RepoRoot '.archive-data\logs'
$SvnRootFile = Join-Path $RepoRoot '.archive-data\svn-root.txt'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (-not $env:SVN_WORKING_COPY_ROOT -and (Test-Path -LiteralPath $SvnRootFile)) {
  $configuredSvnRoot = (Get-Content -LiteralPath $SvnRootFile -Raw).Trim()
  if ($configuredSvnRoot) {
    $env:SVN_WORKING_COPY_ROOT = $configuredSvnRoot
  }
}

if ($env:SVN_WORKING_COPY_ROOT) {
  Write-Host "SVN working copy root: $env:SVN_WORKING_COPY_ROOT"
} else {
  Write-Warning "SVN_WORKING_COPY_ROOT is not configured. Put the local SVN checkout path in $SvnRootFile or set the environment variable before starting."
}

function Test-ListeningPort {
  param([int]$Port)

  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1

  return $null -ne $connection
}

function Start-StableProcess {
  param(
    [string]$Name,
    [int]$Port,
    [string]$Command,
    [string]$LogFileName
  )

  if (Test-ListeningPort -Port $Port) {
    Write-Host "$Name already listening on port $Port"
    return
  }

  $LogFile = Join-Path $LogDir $LogFileName
  $CommandLine = "cd /d `"$RepoRoot`" && $Command 1>> `"$LogFile`" 2>>&1"

  Start-Process -FilePath 'cmd.exe' `
    -ArgumentList @('/d', '/c', $CommandLine) `
    -WindowStyle Hidden `
    -WorkingDirectory $RepoRoot | Out-Null

  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Date) -lt $deadline) {
    if (Test-ListeningPort -Port $Port) {
      Write-Host "$Name started on port $Port"
      return
    }
    Start-Sleep -Milliseconds 500
  }

  Write-Warning "$Name did not start on port $Port within 20 seconds. Check $LogFile"
}

Start-StableProcess -Name 'Archive API' -Port 8791 -Command 'npm run api' -LogFileName 'archive-api.log'
Start-StableProcess -Name 'Vite app' -Port 5190 -Command 'npm run dev:stable' -LogFileName 'vite-5190.log'

if ($OpenBrowser) {
  Start-Process 'http://127.0.0.1:5190/' | Out-Null
}
