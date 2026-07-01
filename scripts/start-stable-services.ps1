param(
  [switch]$OpenBrowser,
  [switch]$Restart
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$SharedRootFile = Join-Path $RepoRoot '.archive-data\shared-root.txt'
if (-not $env:ARCHIVE_SHARED_DATA_ROOT -and (Test-Path -LiteralPath $SharedRootFile)) {
  $configuredSharedRoot = (Get-Content -LiteralPath $SharedRootFile -Raw).Trim()
  if ($configuredSharedRoot) {
    $env:ARCHIVE_SHARED_DATA_ROOT = $configuredSharedRoot
  }
}

$ArchiveDataRoot = if ($env:ARCHIVE_SHARED_DATA_ROOT) { $env:ARCHIVE_SHARED_DATA_ROOT } else { Join-Path $RepoRoot '.archive-data' }
$LogDir = Join-Path $ArchiveDataRoot 'logs'
$SvnRootFile = Join-Path $RepoRoot '.archive-data\svn-root.txt'
$PaddlePythonFile = Join-Path $RepoRoot '.archive-data\paddle-ocr-python.txt'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if ($env:ARCHIVE_SHARED_DATA_ROOT) {
  if (-not $env:ARCHIVE_REQUIRE_CENTER_API) { $env:ARCHIVE_REQUIRE_CENTER_API = 'true' }
  if (-not $env:ARCHIVE_REQUIRED_SHARED_DATA_ROOT) { $env:ARCHIVE_REQUIRED_SHARED_DATA_ROOT = $ArchiveDataRoot }
  if (-not $env:ARCHIVE_REQUIRED_DATA_FILE) { $env:ARCHIVE_REQUIRED_DATA_FILE = Join-Path $ArchiveDataRoot 'archive-db.json' }
  if (-not $env:VITE_ARCHIVE_REQUIRE_CENTER_API) { $env:VITE_ARCHIVE_REQUIRE_CENTER_API = 'true' }
  if (-not $env:VITE_ARCHIVE_REQUIRED_SHARED_ROOT) { $env:VITE_ARCHIVE_REQUIRED_SHARED_ROOT = $ArchiveDataRoot }
  if (-not $env:VITE_ARCHIVE_REQUIRED_DATA_FILE) { $env:VITE_ARCHIVE_REQUIRED_DATA_FILE = Join-Path $ArchiveDataRoot 'archive-db.json' }
}

function Import-EnvFile {
  param([string]$Path)

  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) {
      return
    }
    $separatorIndex = $line.IndexOf('=')
    if ($separatorIndex -lt 1) {
      return
    }
    $name = $line.Substring(0, $separatorIndex).Trim()
    $value = $line.Substring($separatorIndex + 1).Trim().Trim("'").Trim('"')
    if ($name) {
      Set-Item -Path "Env:$name" -Value $value
    }
  }
}

$ModelEnvFiles = @(
  (Join-Path $RepoRoot '.env'),
  (Join-Path $RepoRoot '.env.local'),
  (Join-Path $RepoRoot '.archive-data\archive-ai.env'),
  (Join-Path $RepoRoot '.archive-data\summary-model.env'),
  (Join-Path $ArchiveDataRoot 'archive-ai.env'),
  (Join-Path $ArchiveDataRoot 'summary-model.env')
)
$ModelEnvFiles | Select-Object -Unique | ForEach-Object { Import-EnvFile -Path $_ }

if ($env:ARCHIVE_SHARED_DATA_ROOT) {
  Write-Host "Archive shared data root: $env:ARCHIVE_SHARED_DATA_ROOT"
} else {
  Write-Warning "ARCHIVE_SHARED_DATA_ROOT is not configured. Records will stay local. Put the shared path in $SharedRootFile or set the environment variable before starting."
}

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
if (-not $env:PADDLE_OCR_PYTHON -and (Test-Path -LiteralPath $PaddlePythonFile)) {
  $configuredPaddlePython = (Get-Content -LiteralPath $PaddlePythonFile -Raw).Trim()
  if ($configuredPaddlePython -and (Test-Path -LiteralPath $configuredPaddlePython)) {
    $env:PADDLE_OCR_PYTHON = $configuredPaddlePython
  }
}
if ($env:PADDLE_OCR_PYTHON) {
  Write-Host "PaddleOCR Python: $env:PADDLE_OCR_PYTHON"
} else {
  Write-Warning "PADDLE_OCR_PYTHON is not configured. OCR will try python/python3 from PATH."
}

if (-not $env:VITE_APP_BASE) { $env:VITE_APP_BASE = '/art_archive/' }
$ViteProtocol = if (($env:ARCHIVE_VITE_HTTPS_CERT -and $env:ARCHIVE_VITE_HTTPS_KEY) -or ($env:VITE_HTTPS_CERT -and $env:VITE_HTTPS_KEY)) { 'https' } else { 'http' }
Write-Host "Vite app base: $env:VITE_APP_BASE"
Write-Host "Vite app protocol: $ViteProtocol"

function Test-ListeningPort {
  param([int]$Port)

  $connection = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1

  return $null -ne $connection
}

function Stop-ListeningPort {
  param([int]$Port)

  $processIds = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique

  foreach ($processId in $processIds) {
    if ($processId -and $processId -ne $PID) {
      Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
    }
  }
}

function Start-StableProcess {
  param(
    [string]$Name,
    [int]$Port,
    [string]$Command,
    [string]$LogFileName
  )

  if (Test-ListeningPort -Port $Port) {
    if ($Restart) {
      Write-Host "Restarting $Name on port $Port"
      Stop-ListeningPort -Port $Port
      Start-Sleep -Milliseconds 500
    } else {
      Write-Host "$Name already listening on port $Port"
      return
    }
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
$ViteOptimizeCache = Join-Path $RepoRoot 'node_modules\.vite'
if (Test-Path -LiteralPath $ViteOptimizeCache) {
  Remove-Item -LiteralPath $ViteOptimizeCache -Recurse -Force
}
Start-StableProcess -Name 'Vite app' -Port 5190 -Command 'npm run dev:stable' -LogFileName 'vite-5190.log'

if ($OpenBrowser) {
  Start-Process "${ViteProtocol}://127.0.0.1:5190/" | Out-Null
}
