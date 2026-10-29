[CmdletBinding()]
param(
  [string]$BackupRoot,
  [string]$TokenFile,
  [ValidatePattern('^([01]\d|2[0-3]):[0-5]\d$')]
  [string]$DailyAt = '02:15',
  [ValidatePattern('^([01]\d|2[0-3]):[0-5]\d$')]
  [string]$WeeklyAt = '02:30',
  [ValidatePattern('^([01]\d|2[0-3]):[0-5]\d$')]
  [string]$MonthlyCheckAt = '03:00'
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($BackupRoot)) {
  if ([string]::IsNullOrWhiteSpace($env:OneDrive)) {
    throw 'OneDrive klasoru bulunamadi. -BackupRoot ile bir hedef belirtin.'
  }
  $BackupRoot = Join-Path $env:OneDrive 'Yatirim Defterim Yedekleri'
}
$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($TokenFile)) {
  $TokenFile = Join-Path $projectRoot '.secrets\cloudflare-backup-token.dpapi'
}

$backupScript = Join-Path $PSScriptRoot 'backup-d1.ps1'
if (-not (Test-Path -LiteralPath $backupScript -PathType Leaf)) {
  throw "Yedekleme betigi bulunamadi: $backupScript"
}
$restoreTestScript = Join-Path $PSScriptRoot 'test-backup-restore.ps1'
if (-not (Test-Path -LiteralPath $restoreTestScript -PathType Leaf)) {
  throw "Geri yukleme testi betigi bulunamadi: $restoreTestScript"
}
$runtimeInstaller = Join-Path $PSScriptRoot 'install-backup-runtime.ps1'
if (-not (Test-Path -LiteralPath $runtimeInstaller -PathType Leaf)) {
  throw "Yedekleme Node.js kurucusu bulunamadi: $runtimeInstaller"
}
$runtimeOutput = @(& $runtimeInstaller)
$nodePath = [string]$runtimeOutput[-1]
if (-not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
  throw "Yedekleme Node.js calistirilabilir dosyasi bulunamadi: $nodePath"
}

$BackupRoot = [System.IO.Path]::GetFullPath($BackupRoot)
$powerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $powerShellExe -PathType Leaf)) {
  throw "Windows PowerShell bulunamadi: $powerShellExe"
}
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$dailyTime = [DateTime]::Today.Add([TimeSpan]::ParseExact($DailyAt, 'hh\:mm', [Globalization.CultureInfo]::InvariantCulture))
$weeklyTime = [DateTime]::Today.Add([TimeSpan]::ParseExact($WeeklyAt, 'hh\:mm', [Globalization.CultureInfo]::InvariantCulture))
$monthlyCheckTime = [DateTime]::Today.Add([TimeSpan]::ParseExact($MonthlyCheckAt, 'hh\:mm', [Globalization.CultureInfo]::InvariantCulture))
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2)
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited

function New-BackupAction {
  param([ValidateSet('Json', 'Sql')][string]$Mode)

  $arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Mode {1} -BackupRoot "{2}" -NodePath "{3}" -TokenFile "{4}"' -f $backupScript, $Mode, $BackupRoot, $nodePath, $TokenFile
  return New-ScheduledTaskAction -Execute $powerShellExe -Argument $arguments -WorkingDirectory (Split-Path -Parent $backupScript)
}

$dailyTask = New-ScheduledTask `
  -Action (New-BackupAction -Mode Json) `
  -Trigger (New-ScheduledTaskTrigger -Daily -At $dailyTime) `
  -Settings $settings `
  -Principal $principal `
  -Description 'Yatirim Defterim D1 veritabaninin okunabilir JSON yedegini OneDrive klasorune alir.'

$weeklyTask = New-ScheduledTask `
  -Action (New-BackupAction -Mode Sql) `
  -Trigger (New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At $weeklyTime) `
  -Settings $settings `
  -Principal $principal `
  -Description 'Yatirim Defterim D1 veritabaninin tam SQL yedegini OneDrive klasorune alir.'

$restoreArguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -BackupRoot "{1}" -NodePath "{2}"' -f $restoreTestScript, $BackupRoot, $nodePath
$restoreTask = New-ScheduledTask `
  -Action (New-ScheduledTaskAction -Execute $powerShellExe -Argument $restoreArguments -WorkingDirectory (Split-Path -Parent $restoreTestScript)) `
  -Trigger (New-ScheduledTaskTrigger -Daily -At $monthlyCheckTime) `
  -Settings $settings `
  -Principal $principal `
  -Description 'Her ay en yeni Yatirim Defterim yedegini gecici SQLite veritabanina geri yukler ve veri butunlugunu dogrular; basarisizsa ertesi gun yeniden dener.'

Register-ScheduledTask -TaskName 'YatirimDefterim-D1-JSON-Gunluk' -InputObject $dailyTask -Force | Out-Null
Register-ScheduledTask -TaskName 'YatirimDefterim-D1-SQL-Haftalik' -InputObject $weeklyTask -Force | Out-Null
Register-ScheduledTask -TaskName 'YatirimDefterim-Yedek-GeriYukleme-Aylik' -InputObject $restoreTask -Force | Out-Null

Get-ScheduledTask -TaskName 'YatirimDefterim-D1-JSON-Gunluk', 'YatirimDefterim-D1-SQL-Haftalik', 'YatirimDefterim-Yedek-GeriYukleme-Aylik' |
  Select-Object TaskName, State, Description
