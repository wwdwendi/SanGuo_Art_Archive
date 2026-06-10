Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
repoRoot = fso.GetParentFolderName(scriptDir)
watchdog = fso.BuildPath(scriptDir, "stable-services-watchdog.ps1")
powershell = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"

shell.CurrentDirectory = repoRoot
shell.Run """" & powershell & """ -NoProfile -ExecutionPolicy Bypass -File """ & watchdog & """", 0, False
