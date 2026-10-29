[CmdletBinding()]
param(
  [string]$Version = '22.23.2'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$projectRoot = Split-Path -Parent $PSScriptRoot
$toolsRoot = Join-Path $projectRoot '.tools'
$archiveName = "node-v$Version-win-x64.zip"
$runtimeDirectory = Join-Path $toolsRoot "node-v$Version-win-x64"
$nodePath = Join-Path $runtimeDirectory 'node.exe'
$stagingDirectory = Join-Path $toolsRoot "node-v$Version-indiriliyor"

if (Test-Path -LiteralPath $nodePath -PathType Leaf) {
  $installedVersion = (& $nodePath --version).TrimStart('v')
  if ($installedVersion -eq $Version) {
    Write-Output $nodePath
    exit 0
  }
  throw "Beklenmeyen Node.js surumu bulundu: $installedVersion"
}

$expectedToolsRoot = [System.IO.Path]::GetFullPath((Join-Path $projectRoot '.tools'))
$resolvedStaging = [System.IO.Path]::GetFullPath($stagingDirectory)
if (-not $resolvedStaging.StartsWith($expectedToolsRoot + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Gecici Node.js klasoru proje .tools dizininin disinda.'
}

New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null
if (Test-Path -LiteralPath $stagingDirectory) {
  Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
}
New-Item -ItemType Directory -Path $stagingDirectory | Out-Null

$archivePath = Join-Path $stagingDirectory $archiveName
$checksumsPath = Join-Path $stagingDirectory 'SHASUMS256.txt'
$releaseRoot = "https://nodejs.org/download/release/v$Version"

try {
  Invoke-WebRequest -Uri "$releaseRoot/$archiveName" -OutFile $archivePath -UseBasicParsing
  Invoke-WebRequest -Uri "$releaseRoot/SHASUMS256.txt" -OutFile $checksumsPath -UseBasicParsing

  $checksumLine = Get-Content -LiteralPath $checksumsPath |
    Where-Object { $_ -match ("^[a-fA-F0-9]{{64}}\s+{0}$" -f [regex]::Escape($archiveName)) } |
    Select-Object -First 1
  if ([string]::IsNullOrWhiteSpace($checksumLine)) {
    throw "Resmi SHA256 listesinde $archiveName bulunamadi."
  }

  $expectedHash = ($checksumLine -split '\s+')[0].ToLowerInvariant()
  $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $expectedHash) {
    throw "Node.js arsivi SHA256 dogrulamasindan gecemedi. Beklenen=$expectedHash Gercek=$actualHash"
  }

  Expand-Archive -LiteralPath $archivePath -DestinationPath $stagingDirectory -Force
  $expandedDirectory = Join-Path $stagingDirectory "node-v$Version-win-x64"
  if (-not (Test-Path -LiteralPath (Join-Path $expandedDirectory 'node.exe') -PathType Leaf)) {
    throw 'Node.js arsivi beklenen node.exe dosyasini icermiyor.'
  }
  Move-Item -LiteralPath $expandedDirectory -Destination $runtimeDirectory

  $installedVersion = (& $nodePath --version).TrimStart('v')
  if ($installedVersion -ne $Version) {
    throw "Kurulan Node.js surumu dogrulanamadi: $installedVersion"
  }

  Write-Output $nodePath
} finally {
  if (Test-Path -LiteralPath $stagingDirectory) {
    Remove-Item -LiteralPath $stagingDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}
