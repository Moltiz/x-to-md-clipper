$ErrorActionPreference = "Stop"

$workspace = Split-Path -Parent $PSScriptRoot
$source = Join-Path $workspace ".output\chrome-mv3"
$target = Join-Path $workspace ".output\chrome-mv3-dev"

if (-not (Test-Path $source)) {
  throw "Production build not found at $source. Run npm run build first."
}

if (-not (Test-Path $target)) {
  New-Item -ItemType Directory -Path $target | Out-Null
}

Copy-Item -Path (Join-Path $source "*") -Destination $target -Recurse -Force
Write-Host "Synced production build into loaded extension folder: $target"
