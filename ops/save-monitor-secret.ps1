[CmdletBinding()]
param(
  [string]$SecretFile
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($SecretFile)) {
  $SecretFile = Join-Path $projectRoot '.secrets\monitor-alert-secret.dpapi'
}
$nodePath = Join-Path $projectRoot '.tools\node-v22.23.2-win-x64\node.exe'
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
}
$wranglerCliPath = Join-Path $projectRoot 'node_modules\wrangler\wrangler-dist\cli.js'
$configPath = Join-Path $projectRoot 'wrangler.jsonc'
foreach ($path in @($nodePath, $wranglerCliPath, $configPath)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Gerekli dosya bulunamadi: $path" }
}

$bytes = New-Object byte[] 32
$generator = [Security.Cryptography.RandomNumberGenerator]::Create()
$secret = ''
try {
  $generator.GetBytes($bytes)
  $secret = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')

  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $nodePath
  $startInfo.WorkingDirectory = $projectRoot
  $startInfo.Arguments = '"{0}" secret put MONITOR_ALERT_SECRET --config "{1}"' -f $wranglerCliPath, $configPath
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $process = [Diagnostics.Process]::Start($startInfo)
  $process.StandardInput.WriteLine($secret)
  $process.StandardInput.Close()
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()
  if ($process.ExitCode -ne 0) {
    $detail = ($stderr + "`n" + $stdout).Trim()
    if ($detail.Length -gt 1200) { $detail = $detail.Substring($detail.Length - 1200) }
    throw "Cloudflare izleme anahtari kaydedilemedi (cikis $($process.ExitCode)): $detail"
  }

  $secretDirectory = Split-Path -Parent $SecretFile
  New-Item -ItemType Directory -Path $secretDirectory -Force | Out-Null
  ConvertTo-SecureString $secret -AsPlainText -Force |
    ConvertFrom-SecureString |
    Set-Content -LiteralPath $SecretFile -Encoding ASCII
  $roundTrip = (Get-Content -LiteralPath $SecretFile -Raw).Trim() | ConvertTo-SecureString
  if ($roundTrip.Length -le 0) { throw 'Yerel sifreli izleme anahtari dogrulanamadi.' }
  Write-Output 'Izleme bildirim anahtari Cloudflare ve Windows DPAPI kasasina kaydedildi.'
} finally {
  $secret = $null
  [Array]::Clear($bytes, 0, $bytes.Length)
  $generator.Dispose()
}
