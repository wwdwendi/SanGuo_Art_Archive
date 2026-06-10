$ErrorActionPreference = 'Continue'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$LogDir = Join-Path $RepoRoot '.archive-data\logs'
$WatchdogLog = Join-Path $LogDir 'stable-watchdog.log'
$CreatedNew = $false
$Mutex = New-Object System.Threading.Mutex($true, 'Global\SanGuoCostumeArchiveStableWatchdog', [ref]$CreatedNew)

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-WatchdogLog {
  param([string]$Message)

  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -Path $WatchdogLog -Value "[$timestamp] $Message" -Encoding UTF8
}

if (-not $CreatedNew) {
  Write-WatchdogLog 'watchdog already running'
  exit 0
}

Write-WatchdogLog 'watchdog started'

try {
  while ($true) {
    try {
      & (Join-Path $PSScriptRoot 'start-stable-services.ps1') *>> $WatchdogLog
    } catch {
      Write-WatchdogLog "watchdog error: $($_.Exception.Message)"
    }

    Start-Sleep -Seconds 60
  }
} finally {
  $Mutex.ReleaseMutex()
  $Mutex.Dispose()
}
