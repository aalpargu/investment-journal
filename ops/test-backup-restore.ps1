[CmdletBinding()]
param(
  [string]$BackupRoot,
  [string]$NodePath,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($BackupRoot)) {
  if ([string]::IsNullOrWhiteSpace($env:OneDrive)) {
    throw 'OneDrive klasoru bulunamadi. -BackupRoot ile bir hedef belirtin.'
  }
  $BackupRoot = Join-Path $env:OneDrive 'Yatirim Defterim Yedekleri'
}
if ([string]::IsNullOrWhiteSpace($NodePath)) {
  $bundledNodePath = Join-Path $projectRoot '.tools\node-v22.23.2-win-x64\node.exe'
  $NodePath = if (Test-Path -LiteralPath $bundledNodePath -PathType Leaf) {
    $bundledNodePath
  } else {
    (Get-Command node.exe -ErrorAction Stop).Source
  }
}

$BackupRoot = [System.IO.Path]::GetFullPath($BackupRoot)
$verifierPath = Join-Path $PSScriptRoot 'verify-backup-restore.mjs'
$weeklyDirectory = Join-Path $BackupRoot 'haftalik-sql'
$dailyDirectory = Join-Path $BackupRoot 'gunluk-json'
$logDirectory = Join-Path $BackupRoot 'gunlukler'
$logPath = Join-Path $logDirectory 'geri-yukleme-testi.log'
$reportPath = Join-Path $logDirectory 'son-geri-yukleme-testi.json'
$stagingRoot = Join-Path $BackupRoot '.geri-yukleme-testi'
$mutex = New-Object System.Threading.Mutex($false, 'Local\YatirimDefterimRestoreTest')
$lockAcquired = $false
$runDirectory = $null

function Write-RestoreLog {
  param(
    [ValidateSet('INFO', 'ERROR')]
    [string]$Level,
    [string]$Message
  )

  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  Add-Content -LiteralPath $logPath -Encoding UTF8 -Value ('{0} [{1}] {2}' -f [DateTime]::UtcNow.ToString('o'), $Level, $Message)
}

function Get-LatestBackup {
  param([string]$Directory, [string]$Filter)

  $file = Get-ChildItem -LiteralPath $Directory -Filter $Filter -File -ErrorAction Stop |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
  if ($null -eq $file) {
    throw "Yedek bulunamadi: $Directory\$Filter"
  }
  if (-not (Test-Path -LiteralPath ($file.FullName + '.sha256') -PathType Leaf)) {
    throw "Yedek hash dosyasi bulunamadi: $($file.Name).sha256"
  }
  return $file
}

try {
  $lockAcquired = $mutex.WaitOne(0)
  if (-not $lockAcquired) {
    throw 'Baska bir geri yukleme testi halen calisiyor.'
  }
  if (-not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    throw "Node.js bulunamadi: $NodePath"
  }
  if (-not (Test-Path -LiteralPath $verifierPath -PathType Leaf)) {
    throw "Geri yukleme dogrulayicisi bulunamadi: $verifierPath"
  }

  $currentMonth = (Get-Date).ToString('yyyy-MM')
  if (-not $Force -and (Test-Path -LiteralPath $reportPath -PathType Leaf)) {
    try {
      $previousReport = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
      if ($previousReport.status -eq 'ok' -and $previousReport.testMonth -eq $currentMonth) {
        Write-Output "Bu ayin geri yukleme testi zaten basarili: $($previousReport.testedAtUtc)"
        return
      }
    } catch {
      # Bozuk veya eski rapor yeni testin calismasini engellemez.
    }
  }

  $sqlBackup = Get-LatestBackup -Directory $weeklyDirectory -Filter '*.sql'
  $jsonBackup = Get-LatestBackup -Directory $dailyDirectory -Filter '*.json'
  New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null
  $runDirectory = Join-Path $stagingRoot ([Guid]::NewGuid().ToString('N'))
  $resolvedStagingRoot = [System.IO.Path]::GetFullPath($stagingRoot)
  $resolvedRunDirectory = [System.IO.Path]::GetFullPath($runDirectory)
  if (-not $resolvedRunDirectory.StartsWith($resolvedStagingRoot + [System.IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Geri yukleme test klasoru yedek dizininin disinda.'
  }
  New-Item -ItemType Directory -Path $runDirectory | Out-Null

  $databasePath = Join-Path $runDirectory 'restore-test.sqlite'
  $stdoutPath = Join-Path $runDirectory 'report.json'
  $stderrPath = Join-Path $runDirectory 'error.log'
  $arguments = @(
    '--no-warnings',
    '--experimental-sqlite',
    $verifierPath,
    '--sql', $sqlBackup.FullName,
    '--json', $jsonBackup.FullName,
    '--database', $databasePath
  )
  $encodedArguments = @($arguments | ForEach-Object {
    if ($_ -match '[\s"]') { '"{0}"' -f ($_.Replace('"', '\"')) } else { $_ }
  })
  $process = Start-Process `
    -FilePath $NodePath `
    -ArgumentList ($encodedArguments -join ' ') `
    -WorkingDirectory $projectRoot `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -WindowStyle Hidden `
    -Wait `
    -PassThru
  if ($process.ExitCode -ne 0) {
    $detail = if (Test-Path -LiteralPath $stderrPath) { (Get-Content -LiteralPath $stderrPath -Raw).Trim() } else { '' }
    if ($detail.Length -gt 2000) { $detail = $detail.Substring($detail.Length - 2000) }
    throw "Geri yukleme dogrulayicisi basarisiz oldu (cikis $($process.ExitCode)): $detail"
  }

  $report = Get-Content -LiteralPath $stdoutPath -Raw | ConvertFrom-Json
  if ($report.status -ne 'ok' -or $report.sqliteIntegrity -ne 'ok') {
    throw 'Geri yukleme dogrulayicisi basarili rapor dondurmedi.'
  }
  $report | Add-Member -NotePropertyName testMonth -NotePropertyValue $currentMonth -Force
  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $reportPath -Encoding UTF8
  Write-RestoreLog -Level INFO -Message ("Basarili: SQL={0}; JSON={1}; tablolar={2}; portfoy={3}; islemler={4}; takip={5}; surumler={6}; bekleyen={7}" -f $report.sqlBackup, $report.jsonBackup, $report.restoredTables, $report.portfolioStates, $report.transactions, $report.watchlist, $report.portfolioVersions, $report.pendingTransactions)
  $report
} catch {
  try {
    Write-RestoreLog -Level ERROR -Message $_.Exception.Message
  } catch {
    # Ana hatayi koru.
  }
  throw
} finally {
  if ($lockAcquired) {
    $mutex.ReleaseMutex()
  }
  $mutex.Dispose()
  if ($null -ne $runDirectory -and (Test-Path -LiteralPath $runDirectory)) {
    Remove-Item -LiteralPath $runDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}
