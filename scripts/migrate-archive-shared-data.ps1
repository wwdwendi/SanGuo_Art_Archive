param(
  [Parameter(Mandatory = $true)]
  [string]$SharedRoot
)

$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$LocalDataRoot = Join-Path $RepoRoot '.archive-data'
$PublicWebClipsRoot = Join-Path $RepoRoot 'public\web-clips'
$SharedRootPath = [System.IO.Path]::GetFullPath($SharedRoot)
$SharedWebClipsRoot = Join-Path $SharedRootPath 'web-clips'

New-Item -ItemType Directory -Force -Path $SharedRootPath | Out-Null
New-Item -ItemType Directory -Force -Path $SharedWebClipsRoot | Out-Null

$LocalDb = Join-Path $LocalDataRoot 'archive-db.json'
$SharedDb = Join-Path $SharedRootPath 'archive-db.json'
if ((Test-Path -LiteralPath $LocalDb) -and -not (Test-Path -LiteralPath $SharedDb)) {
  Copy-Item -LiteralPath $LocalDb -Destination $SharedDb
}

$LocalWebClipsRoot = Join-Path $LocalDataRoot 'web-clips'
if (Test-Path -LiteralPath $LocalWebClipsRoot) {
  Copy-Item -LiteralPath (Join-Path $LocalWebClipsRoot '*') -Destination $SharedWebClipsRoot -Recurse -Force -ErrorAction SilentlyContinue
}

if (Test-Path -LiteralPath $PublicWebClipsRoot) {
  Copy-Item -LiteralPath (Join-Path $PublicWebClipsRoot '*') -Destination $SharedWebClipsRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$SharedRootConfigFile = Join-Path $LocalDataRoot 'shared-root.txt'
New-Item -ItemType Directory -Force -Path $LocalDataRoot | Out-Null
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($SharedRootConfigFile, "$SharedRootPath`n", $Utf8NoBom)

Write-Host "Archive shared data root configured: $SharedRootPath"
Write-Host "Database: $SharedDb"
Write-Host "Web clips: $SharedWebClipsRoot"
