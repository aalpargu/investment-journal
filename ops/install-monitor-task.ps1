[CmdletBinding()]
param(
  [ValidateRange(5, 1440)]
  [int]$IntervalMinutes = 15,
  [string]$BackupRoot,
  [string]$D1TokenFile,
  [string]$MonitorSecretFile
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$monitorScript = Join-Path $PSScriptRoot 'monitor-health.ps1'
if ([string]::IsNullOrWhiteSpace($BackupRoot)) {
  if ([string]::IsNullOrWhiteSpace($env:OneDrive)) { throw 'OneDrive klasoru bulunamadi.' }
  $BackupRoot = Join-Path $env:OneDrive 'Yatirim Defterim Yedekleri'
}
if ([string]::IsNullOrWhiteSpace($D1TokenFile)) {
  $D1TokenFile = Join-Path $projectRoot '.secrets\cloudflare-backup-token.dpapi'
}
if ([string]::IsNullOrWhiteSpace($MonitorSecretFile)) {
  $MonitorSecretFile = Join-Path $projectRoot '.secrets\monitor-alert-secret.dpapi'
}
foreach ($path in @($monitorScript, $D1TokenFile, $MonitorSecretFile)) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Gerekli dosya bulunamadi: $path" }
}

& $monitorScript `
  -BackupRoot $BackupRoot `
  -D1TokenFile $D1TokenFile `
  -MonitorSecretFile $MonitorSecretFile `
  -SendTestAlert | Out-Null

$powerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -BackupRoot "{1}" -D1TokenFile "{2}" -MonitorSecretFile "{3}"' -f $monitorScript, $BackupRoot, $D1TokenFile, $MonitorSecretFile
$action = New-ScheduledTaskAction -Execute $powerShellExe -Argument $arguments -WorkingDirectory $projectRoot
$repeatTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $currentUser
$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
$principal = New-ScheduledTaskPrincipal -UserId $currentUser -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask `
  -Action $action `
  -Trigger @($repeatTrigger, $logonTrigger) `
  -Settings $settings `
  -Principal $principal `
  -Description 'Yatirim Defterim sitesini, D1 esitleme verisini ve yedeklerin guncelligini kontrol eder; Telegram ile yalnizca sorun ve duzelme bildirimi gonderir.'

$taskName = 'YatirimDefterim-Saglik-Izleme'
Register-ScheduledTask -TaskName $taskName -InputObject $task -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Start-Sleep -Seconds 2
$registered = Get-ScheduledTask -TaskName $taskName
$info = Get-ScheduledTaskInfo -TaskName $taskName
[pscustomobject]@{
  TaskName = $registered.TaskName
  State = $registered.State
  IntervalMinutes = $IntervalMinutes
  LastRunTime = $info.LastRunTime
  LastTaskResult = $info.LastTaskResult
  NextRunTime = $info.NextRunTime
}
