$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$TaskName = 'SanGuo Costume Archive Stable Services'
$ScriptPath = Join-Path $RepoRoot 'scripts\stable-services-watchdog.vbs'
$WScript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$Arguments = "`"$ScriptPath`""

$ExistingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($ExistingTask) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
}

$Action = New-ScheduledTaskAction -Execute $WScript -Argument $Arguments -WorkingDirectory $RepoRoot
$LoginTrigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Seconds 0) `
  -Hidden

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $LoginTrigger `
  -Settings $Settings `
  -Description 'Keep SanGuo Costume Archive local app on 127.0.0.1:5190 and API on 127.0.0.1:8791 running.' `
  -Force | Out-Null

Start-ScheduledTask -TaskName $TaskName

Write-Host "Registered and started scheduled task: $TaskName"
