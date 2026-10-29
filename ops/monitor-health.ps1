[CmdletBinding()]
param(
  [string]$SiteUrl = 'https://yatirim-defterim.aliihsanalpargu9.workers.dev/login',
  [string]$BackupRoot,
  [string]$D1TokenFile,
  [string]$MonitorSecretFile,
  [string]$AlertUrl = 'https://yatirim-defterim.aliihsanalpargu9.workers.dev/api/monitor-alert',
  [string]$StateFile,
  [int]$DailyBackupMaxHours = 36,
  [int]$WeeklyBackupMaxHours = 204,
  [int]$RestoreTestMaxDays = 40,
  [int]$FailuresBeforeAlert = 2,
  [switch]$DryRun,
  [switch]$SendTestAlert
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($BackupRoot)) {
  if ([string]::IsNullOrWhiteSpace($env:OneDrive)) {
    $BackupRoot = ''
  } else {
    $BackupRoot = Join-Path $env:OneDrive 'Yatirim Defterim Yedekleri'
  }
}
if ([string]::IsNullOrWhiteSpace($D1TokenFile)) {
  $D1TokenFile = Join-Path $projectRoot '.secrets\cloudflare-backup-token.dpapi'
}
if ([string]::IsNullOrWhiteSpace($MonitorSecretFile)) {
  $MonitorSecretFile = Join-Path $projectRoot '.secrets\monitor-alert-secret.dpapi'
}
if ([string]::IsNullOrWhiteSpace($StateFile)) {
  $StateFile = Join-Path $projectRoot '.secrets\monitor-state.json'
}
$logPath = Join-Path $projectRoot '.secrets\monitor.log'
$nodePath = Join-Path $projectRoot '.tools\node-v22.23.2-win-x64\node.exe'
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
}
$wranglerCliPath = Join-Path $projectRoot 'node_modules\wrangler\wrangler-dist\cli.js'
$configPath = Join-Path $projectRoot 'wrangler.jsonc'
$now = [DateTime]::UtcNow
$issues = New-Object System.Collections.Generic.List[object]
$checks = New-Object System.Collections.Generic.List[object]
$oldNoColor = $env:NO_COLOR
$oldMetrics = $env:WRANGLER_SEND_METRICS
$oldToken = $env:CLOUDFLARE_API_TOKEN

function Add-Check {
  param([string]$Key, [string]$Label, [bool]$Ok, [string]$Detail)
  $checks.Add([pscustomobject]@{ key = $Key; label = $Label; ok = $Ok; detail = $Detail })
  if (-not $Ok) {
    $issues.Add([pscustomobject]@{ key = $Key; label = $Label; detail = $Detail })
  }
}

function Read-DpapiText {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Sifreli ayar bulunamadi: $Path"
  }
  $secure = (Get-Content -LiteralPath $Path -Raw).Trim() | ConvertTo-SecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Get-LatestAge {
  param([string]$Directory, [string]$Filter)
  $file = Get-ChildItem -LiteralPath $Directory -Filter $Filter -File -ErrorAction Stop |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
  if ($null -eq $file) { throw "Dosya bulunamadi: $Directory\$Filter" }
  if (-not (Test-Path -LiteralPath ($file.FullName + '.sha256') -PathType Leaf)) {
    throw "Yedek hash dosyasi bulunamadi: $($file.Name).sha256"
  }
  return [pscustomobject]@{ file = $file; age = ($now - $file.LastWriteTimeUtc) }
}

function Invoke-D1HealthQuery {
  $token = Read-DpapiText -Path $D1TokenFile
  $runRoot = Join-Path $projectRoot '.secrets\monitor-tmp'
  New-Item -ItemType Directory -Path $runRoot -Force | Out-Null
  $runDirectory = Join-Path $runRoot ([Guid]::NewGuid().ToString('N'))
  $resolvedRoot = [System.IO.Path]::GetFullPath($runRoot)
  $resolvedRun = [System.IO.Path]::GetFullPath($runDirectory)
  if (-not $resolvedRun.StartsWith($resolvedRoot + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Gecici izleme klasoru guvenli kokun disinda.'
  }
  New-Item -ItemType Directory -Path $resolvedRun | Out-Null
  $stdoutPath = Join-Path $resolvedRun 'stdout.json'
  $stderrPath = Join-Path $resolvedRun 'stderr.log'
  try {
    $env:CLOUDFLARE_API_TOKEN = $token
    $env:NO_COLOR = '1'
    $env:WRANGLER_SEND_METRICS = 'false'
    $sql = "SELECT p.revision, p.updated_at, json_extract(p.state_json, '$.storage') AS storage, json_extract(p.state_json, '$.stateId') AS state_id, EXISTS(SELECT 1 FROM portfolio_state_manifests m WHERE m.user_id=p.user_id AND m.state_id=json_extract(p.state_json, '$.stateId')) AS manifest_exists, (SELECT COUNT(*) FROM portfolio_transactions t WHERE t.user_id=p.user_id AND t.state_id=json_extract(p.state_json, '$.stateId')) AS transactions, (SELECT COUNT(*) FROM portfolio_watchlist_items w WHERE w.user_id=p.user_id AND w.state_id=json_extract(p.state_json, '$.stateId')) AS watchlist FROM portfolio_states p;"
    $arguments = @(
      '--no-warnings', $wranglerCliPath,
      'd1', 'execute', 'yatirim-defterim',
      '--remote', '--command', $sql, '--json', '--config', $configPath
    )
    $encoded = @($arguments | ForEach-Object {
      if ($_ -match '[\s"]') { '"{0}"' -f ($_.Replace('"', '\"')) } else { $_ }
    })
    $process = Start-Process `
      -FilePath $nodePath `
      -ArgumentList ($encoded -join ' ') `
      -WorkingDirectory $projectRoot `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -WindowStyle Hidden `
      -Wait `
      -PassThru
    if ($process.ExitCode -ne 0) {
      $detail = if (Test-Path -LiteralPath $stderrPath) { (Get-Content -LiteralPath $stderrPath -Raw).Trim() } else { '' }
      if ($detail.Length -gt 600) { $detail = $detail.Substring($detail.Length - 600) }
      throw "D1 saglik sorgusu basarisiz (cikis $($process.ExitCode)): $detail"
    }
    $response = Get-Content -LiteralPath $stdoutPath -Raw | ConvertFrom-Json
    $statement = @($response)[0]
    if ($null -eq $statement -or $statement.success -ne $true) {
      throw 'D1 saglik sorgusu basarili yanit dondurmedi.'
    }
    return @($statement.results)
  } finally {
    $token = $null
    $env:CLOUDFLARE_API_TOKEN = $oldToken
    $env:NO_COLOR = $oldNoColor
    $env:WRANGLER_SEND_METRICS = $oldMetrics
    if (Test-Path -LiteralPath $resolvedRun) {
      Remove-Item -LiteralPath $resolvedRun -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
}

function Send-MonitorNotification {
  param([string]$Kind, [object[]]$Items)
  $monitorSecret = Read-DpapiText -Path $MonitorSecretFile
  try {
    $body = @{ kind = $Kind; items = $Items } | ConvertTo-Json -Depth 5 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($body)
    $response = Invoke-RestMethod `
      -Uri $AlertUrl `
      -Method Post `
      -Headers @{ 'x-portfolio-monitor-key' = $monitorSecret } `
      -ContentType 'application/json; charset=utf-8' `
      -Body $bytes `
      -TimeoutSec 25
  } finally {
    $monitorSecret = $null
  }
  if ($response.ok -ne $true) { throw 'Izleme bildirimi sunucuya iletilemedi.' }
}

function Write-MonitorLog {
  param([string]$Level, [string]$Message)
  New-Item -ItemType Directory -Path (Split-Path -Parent $logPath) -Force | Out-Null
  Add-Content -LiteralPath $logPath -Encoding UTF8 -Value ('{0} [{1}] {2}' -f $now.ToString('o'), $Level, $Message)
}

try {
  try {
    $response = Invoke-WebRequest -Uri $SiteUrl -Method Get -UseBasicParsing -TimeoutSec 25
    $siteOk = [int]$response.StatusCode -eq 200 -and $response.Content -match 'Yat.r.m Defterim'
    $siteDetail = if ($siteOk) { 'HTTP 200' } else { "Beklenmeyen yanit: HTTP $([int]$response.StatusCode)" }
    Add-Check -Key 'site' -Label 'Web sitesi' -Ok $siteOk -Detail $siteDetail
  } catch {
    Add-Check -Key 'site' -Label 'Web sitesi' -Ok $false -Detail $_.Exception.Message
  }

  try {
    $rows = @(Invoke-D1HealthQuery)
    $row = $rows | Select-Object -First 1
    $d1Ok = $null -ne $row -and [string]$row.storage -eq 'normalized-v1' -and [int]$row.manifest_exists -eq 1 -and [int]$row.revision -ge 1
    $d1Detail = if ($d1Ok) {
      "revizyon=$([int]$row.revision), islem=$([int]$row.transactions), takip=$([int]$row.watchlist)"
    } else {
      'Guncel normalize portfoy veya manifest bulunamadi.'
    }
    Add-Check -Key 'cloud_sync' -Label 'Bulut esitleme verisi' -Ok $d1Ok -Detail $d1Detail
  } catch {
    Add-Check -Key 'cloud_sync' -Label 'Bulut esitleme verisi' -Ok $false -Detail $_.Exception.Message
  }

  if ([string]::IsNullOrWhiteSpace($BackupRoot)) {
    Add-Check -Key 'backup_root' -Label 'Yedek klasoru' -Ok $false -Detail 'OneDrive yedek klasoru bulunamadi.'
  } else {
    try {
      $daily = Get-LatestAge -Directory (Join-Path $BackupRoot 'gunluk-json') -Filter '*.json'
      $ok = $daily.age.TotalHours -le $DailyBackupMaxHours
      Add-Check -Key 'daily_backup' -Label 'Gunluk JSON yedegi' -Ok $ok -Detail ("yas={0:N1} saat, dosya={1}" -f $daily.age.TotalHours, $daily.file.Name)
    } catch {
      Add-Check -Key 'daily_backup' -Label 'Gunluk JSON yedegi' -Ok $false -Detail $_.Exception.Message
    }
    try {
      $weekly = Get-LatestAge -Directory (Join-Path $BackupRoot 'haftalik-sql') -Filter '*.sql'
      $ok = $weekly.age.TotalHours -le $WeeklyBackupMaxHours
      Add-Check -Key 'weekly_backup' -Label 'Haftalik SQL yedegi' -Ok $ok -Detail ("yas={0:N1} saat, dosya={1}" -f $weekly.age.TotalHours, $weekly.file.Name)
    } catch {
      Add-Check -Key 'weekly_backup' -Label 'Haftalik SQL yedegi' -Ok $false -Detail $_.Exception.Message
    }
    try {
      $reportPath = Join-Path (Join-Path $BackupRoot 'gunlukler') 'son-geri-yukleme-testi.json'
      $report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
      $testedAt = [DateTime]::Parse([string]$report.testedAtUtc).ToUniversalTime()
      $age = $now - $testedAt
      $ok = $report.status -eq 'ok' -and $report.sqliteIntegrity -eq 'ok' -and $age.TotalDays -le $RestoreTestMaxDays
      Add-Check -Key 'restore_test' -Label 'Yedekten geri yukleme testi' -Ok $ok -Detail ("yas={0:N1} gun, durum={1}" -f $age.TotalDays, [string]$report.status)
    } catch {
      Add-Check -Key 'restore_test' -Label 'Yedekten geri yukleme testi' -Ok $false -Detail $_.Exception.Message
    }
  }

  $report = [ordered]@{
    status = if ($issues.Count -eq 0) { 'ok' } else { 'error' }
    checkedAtUtc = $now.ToString('o')
    checks = $checks.ToArray()
  }
  if ($DryRun) {
    $report | ConvertTo-Json -Depth 8
    return
  }

  $previousByKey = @{}
  if (Test-Path -LiteralPath $StateFile -PathType Leaf) {
    try {
      $previous = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json
      foreach ($entry in @($previous.issues)) { $previousByKey[[string]$entry.key] = $entry }
    } catch {
      $previousByKey = @{}
    }
  }
  $currentKeys = @{}
  $nextEntries = New-Object System.Collections.Generic.List[object]
  $newAlertKeys = New-Object System.Collections.Generic.HashSet[string]
  foreach ($issue in $issues) {
    $currentKeys[$issue.key] = $true
    $old = $previousByKey[$issue.key]
    $failures = if ($null -eq $old) { 1 } else { [int]$old.failures + 1 }
    $alerted = $null -ne $old -and [bool]$old.alerted
    if (-not $alerted -and $failures -ge $FailuresBeforeAlert) {
      [void]$newAlertKeys.Add([string]$issue.key)
      $alerted = $true
    }
    $nextEntries.Add([pscustomobject]@{
      key = $issue.key
      label = $issue.label
      failures = $failures
      alerted = $alerted
      detail = $issue.detail
      lastSeenAtUtc = $now.ToString('o')
    })
  }
  $recoveries = New-Object System.Collections.Generic.List[string]
  foreach ($key in $previousByKey.Keys) {
    $old = $previousByKey[$key]
    if (-not $currentKeys.ContainsKey($key) -and [bool]$old.alerted) {
      $recoveries.Add("- $([string]$old.label)")
    }
  }

  if ($SendTestAlert) {
    Send-MonitorNotification -Kind 'test' -Items @()
  }
  if ($newAlertKeys.Count -gt 0) {
    $alertItems = @($issues | Where-Object { $newAlertKeys.Contains([string]$_.key) } | ForEach-Object {
      @{ label = $_.label; detail = $_.detail }
    })
    Send-MonitorNotification -Kind 'alert' -Items $alertItems
  }
  if ($recoveries.Count -gt 0) {
    $recoveryItems = @($previousByKey.Keys | Where-Object {
      -not $currentKeys.ContainsKey($_) -and [bool]$previousByKey[$_].alerted
    } | ForEach-Object { @{ label = [string]$previousByKey[$_].label } })
    Send-MonitorNotification -Kind 'recovery' -Items $recoveryItems
  }

  $stateDirectory = Split-Path -Parent $StateFile
  New-Item -ItemType Directory -Path $stateDirectory -Force | Out-Null
  [ordered]@{ version = 1; checkedAtUtc = $now.ToString('o'); issues = $nextEntries.ToArray() } |
    ConvertTo-Json -Depth 6 |
    Set-Content -LiteralPath $StateFile -Encoding UTF8
  $logLevel = if ($issues.Count -eq 0) { 'INFO' } else { 'WARN' }
  Write-MonitorLog -Level $logLevel -Message ("kontrol={0}; yeniUyari={1}; duzelen={2}" -f $report.status, $newAlertKeys.Count, $recoveries.Count)
  $report | ConvertTo-Json -Depth 8
} finally {
  $env:CLOUDFLARE_API_TOKEN = $oldToken
  $env:NO_COLOR = $oldNoColor
  $env:WRANGLER_SEND_METRICS = $oldMetrics
}
