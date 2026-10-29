[CmdletBinding()]
param(
  [ValidateSet('Json', 'Sql', 'All')]
  [string]$Mode = 'All',

  [string]$BackupRoot,

  [string]$DatabaseName = 'yatirim-defterim',

  [string]$WranglerPath,

  [string]$NodePath,

  [string]$WranglerCliPath,

  [string]$TokenFile,

  [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$projectRoot = Split-Path -Parent $PSScriptRoot
$useWranglerWrapper = -not [string]::IsNullOrWhiteSpace($WranglerPath)
if (-not $useWranglerWrapper) {
  if ([string]::IsNullOrWhiteSpace($NodePath)) {
    $bundledNodePath = Join-Path $projectRoot '.tools\node-v22.23.2-win-x64\node.exe'
    $NodePath = if (Test-Path -LiteralPath $bundledNodePath -PathType Leaf) {
      $bundledNodePath
    } else {
      (Get-Command node.exe -ErrorAction Stop).Source
    }
  }
  if ([string]::IsNullOrWhiteSpace($WranglerCliPath)) {
    $WranglerCliPath = Join-Path $projectRoot 'node_modules\wrangler\wrangler-dist\cli.js'
  }
}
if ([string]::IsNullOrWhiteSpace($ConfigPath)) {
  $ConfigPath = Join-Path $projectRoot 'wrangler.jsonc'
}
if ([string]::IsNullOrWhiteSpace($TokenFile)) {
  $TokenFile = Join-Path $projectRoot '.secrets\cloudflare-backup-token.dpapi'
}
if ([string]::IsNullOrWhiteSpace($BackupRoot)) {
  if ([string]::IsNullOrWhiteSpace($env:OneDrive)) {
    throw 'OneDrive klasoru bulunamadi. -BackupRoot ile bir hedef belirtin.'
  }
  $BackupRoot = Join-Path $env:OneDrive 'Yatirim Defterim Yedekleri'
}

if ($useWranglerWrapper -and -not (Test-Path -LiteralPath $WranglerPath -PathType Leaf)) {
  throw "Wrangler sarmalayicisi bulunamadi: $WranglerPath"
}
if (-not $useWranglerWrapper -and -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
  throw "Node.js bulunamadi: $NodePath"
}
if (-not $useWranglerWrapper -and -not (Test-Path -LiteralPath $WranglerCliPath -PathType Leaf)) {
  throw "Wrangler bulunamadi: $WranglerCliPath. Once proje klasorunde npm install calistirin."
}
if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
  throw "Wrangler yapilandirmasi bulunamadi: $ConfigPath"
}

$BackupRoot = [System.IO.Path]::GetFullPath($BackupRoot)
$dailyDirectory = Join-Path $BackupRoot 'gunluk-json'
$weeklyDirectory = Join-Path $BackupRoot 'haftalik-sql'
$logDirectory = Join-Path $BackupRoot 'gunlukler'
$stagingDirectory = Join-Path $BackupRoot '.hazirlaniyor'
$logPath = Join-Path $logDirectory 'yedekleme.log'
$timestamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$mutex = New-Object System.Threading.Mutex($false, 'Local\YatirimDefterimD1Backup')
$lockAcquired = $false
$oldNoColor = $env:NO_COLOR
$oldCloudflareApiToken = $env:CLOUDFLARE_API_TOKEN

function Import-CloudflareToken {
  if (-not (Test-Path -LiteralPath $TokenFile -PathType Leaf)) {
    return
  }

  $secureToken = (Get-Content -LiteralPath $TokenFile -Raw).Trim() | ConvertTo-SecureString
  $tokenPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
  try {
    $env:CLOUDFLARE_API_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($tokenPointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($tokenPointer)
  }
}

function Write-BackupLog {
  param(
    [ValidateSet('INFO', 'ERROR')]
    [string]$Level,
    [string]$Message
  )

  New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
  $line = '{0} [{1}] {2}' -f [DateTime]::UtcNow.ToString('o'), $Level, $Message
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

function Invoke-Wrangler {
  param(
    [string[]]$Arguments,
    [switch]$ParseJson
  )

  $runId = [Guid]::NewGuid().ToString('N')
  $stdoutPath = Join-Path $stagingDirectory ("wrangler-$runId.stdout.log")
  $stderrPath = Join-Path $stagingDirectory ("wrangler-$runId.stderr.log")
  try {
    $executable = $WranglerPath
    $effectiveArguments = $Arguments
    if (-not $useWranglerWrapper) {
      $executable = $NodePath
      $effectiveArguments = @('--no-warnings', '--experimental-vm-modules', $WranglerCliPath) + $Arguments
    }
    $encodedArguments = @($effectiveArguments | ForEach-Object {
      if ($_ -match '[\s"]') {
        '"{0}"' -f ($_.Replace('"', '\"'))
      } else {
        $_
      }
    })
    $process = Start-Process `
      -FilePath $executable `
      -ArgumentList ($encodedArguments -join ' ') `
      -WorkingDirectory $projectRoot `
      -RedirectStandardOutput $stdoutPath `
      -RedirectStandardError $stderrPath `
      -WindowStyle Hidden `
      -Wait `
      -PassThru
    $exitCode = $process.ExitCode
    $rawOutput = ''
    if (Test-Path -LiteralPath $stdoutPath) {
      $stdoutContent = Get-Content -LiteralPath $stdoutPath -Raw -ErrorAction SilentlyContinue
      if ($null -ne $stdoutContent) {
        $rawOutput = ([string]$stdoutContent).Trim()
      }
    }

    if ($exitCode -ne 0) {
      $jsonFailureDetail = ''
      if ($ParseJson -and -not [string]::IsNullOrWhiteSpace($rawOutput)) {
        try {
          $parsedDespiteExitCode = $rawOutput | ConvertFrom-Json
          $responseEntries = @($parsedDespiteExitCode)
          $failedEntries = @($responseEntries | Where-Object { $_.success -ne $true })
          if ($responseEntries.Count -gt 0 -and $failedEntries.Count -eq 0) {
            return $parsedDespiteExitCode
          }

          $safeErrors = @()
          foreach ($entry in $responseEntries) {
            if ($null -ne $entry.error) {
              $safeErrors += [string]$entry.error
            }
            foreach ($entryError in @($entry.errors)) {
              if ($null -ne $entryError.message) {
                $safeErrors += [string]$entryError.message
              }
            }
          }
          $jsonFailureDetail = ($safeErrors -join ' | ')
        } catch {
          $jsonFailureDetail = 'JSON hata yaniti ayrıştırılamadı.'
        }
      }

      $stderr = ''
      if (Test-Path -LiteralPath $stderrPath) {
        $stderrContent = Get-Content -LiteralPath $stderrPath -Raw -ErrorAction SilentlyContinue
        if ($null -ne $stderrContent) {
          $stderr = ([string]$stderrContent).Trim()
        }
      }
      if ($stderr.Length -gt 2000) {
        $stderr = $stderr.Substring($stderr.Length - 2000)
      }
      $stdoutDiagnostic = ''
      if (-not [string]::IsNullOrWhiteSpace($rawOutput)) {
        if ($rawOutput -match '^\s*[\[{]') {
          $stdoutDiagnostic = if ([string]::IsNullOrWhiteSpace($jsonFailureDetail)) {
            '[JSON hata ayrintisi yok]'
          } else {
            $jsonFailureDetail
          }
        } else {
          $stdoutDiagnostic = $rawOutput
          if ($stdoutDiagnostic.Length -gt 2000) {
            $stdoutDiagnostic = $stdoutDiagnostic.Substring($stdoutDiagnostic.Length - 2000)
          }
        }
      }
      throw "Wrangler basarisiz oldu (cikis $exitCode). stderr=$stderr stdout=$stdoutDiagnostic"
    }

    if ($ParseJson) {
      if ([string]::IsNullOrWhiteSpace($rawOutput)) {
        throw 'Wrangler bos JSON yaniti dondurdu.'
      }
      return $rawOutput | ConvertFrom-Json
    }

    return $rawOutput
  } finally {
    Remove-Item -LiteralPath $stdoutPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $stderrPath -Force -ErrorAction SilentlyContinue
  }
}

function Invoke-D1Query {
  param([string]$Sql)

  $response = Invoke-Wrangler -ParseJson -Arguments @(
    'd1', 'execute', $DatabaseName,
    '--remote',
    '--command', $Sql,
    '--json',
    '--config', $ConfigPath
  )
  $statement = @($response)[0]
  if ($null -eq $statement -or $statement.success -ne $true) {
    throw "D1 sorgusu basarisiz oldu: $Sql"
  }
  return @($statement.results)
}

function Publish-BackupFile {
  param(
    [string]$StagedPath,
    [string]$DestinationDirectory
  )

  if (-not (Test-Path -LiteralPath $StagedPath -PathType Leaf)) {
    throw "Hazirlanan yedek bulunamadi: $StagedPath"
  }
  if ((Get-Item -LiteralPath $StagedPath).Length -le 0) {
    throw "Hazirlanan yedek bos: $StagedPath"
  }

  New-Item -ItemType Directory -Path $DestinationDirectory -Force | Out-Null
  $destination = Join-Path $DestinationDirectory (Split-Path -Leaf $StagedPath)
  if (Test-Path -LiteralPath $destination) {
    throw "Ayni zaman damgali yedek zaten var: $destination"
  }

  Move-Item -LiteralPath $StagedPath -Destination $destination
  $hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
  $hashPath = "$destination.sha256"
  Set-Content -LiteralPath $hashPath -Value ("{0}  {1}" -f $hash, (Split-Path -Leaf $destination)) -Encoding ASCII

  return [pscustomobject]@{
    Path = $destination
    HashPath = $hashPath
    Sha256 = $hash
    Bytes = (Get-Item -LiteralPath $destination).Length
  }
}

function New-JsonBackup {
  $tableRows = Invoke-D1Query -Sql "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name;"
  $tableNames = @($tableRows | ForEach-Object { [string]$_.name })
  if ($tableNames.Count -eq 0) {
    throw 'D1 veritabaninda yedeklenecek tablo bulunamadi.'
  }

  $tables = [ordered]@{}
  $rowCounts = [ordered]@{}
  foreach ($tableName in $tableNames) {
    if ($tableName -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
      throw "Guvenli olmayan tablo adi algilandi: $tableName"
    }
    $rows = @(Invoke-D1Query -Sql ('SELECT * FROM [{0}];' -f $tableName))
    $tables[$tableName] = $rows
    $rowCounts[$tableName] = $rows.Count
  }

  $document = [ordered]@{
    format = 'yatirim-defterim-d1-json-backup'
    formatVersion = 1
    createdAtUtc = [DateTime]::UtcNow.ToString('o')
    database = $DatabaseName
    tables = $tables
    rowCounts = $rowCounts
  }

  $stagedPath = Join-Path $stagingDirectory ("yatirim-defterim-$timestamp.json")
  $document | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $stagedPath -Encoding UTF8
  $verified = Get-Content -LiteralPath $stagedPath -Raw | ConvertFrom-Json
  if ($verified.format -ne 'yatirim-defterim-d1-json-backup' -or $null -eq $verified.tables) {
    throw 'Olusturulan JSON yedegi dogrulanamadi.'
  }

  $published = Publish-BackupFile -StagedPath $stagedPath -DestinationDirectory $dailyDirectory
  Write-BackupLog -Level INFO -Message ("JSON tamamlandi: {0}; {1} bayt; SHA256={2}; tablolar={3}" -f (Split-Path -Leaf $published.Path), $published.Bytes, $published.Sha256, ($tableNames -join ','))
  return $published
}

function New-SqlBackup {
  $stagedPath = Join-Path $stagingDirectory ("yatirim-defterim-$timestamp.sql")
  $schemaRows = @(Invoke-D1Query -Sql "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name;")
  $tableRows = @($schemaRows | Where-Object { $_.type -eq 'table' })
  if ($tableRows.Count -eq 0) {
    throw 'D1 veritabaninda SQL yedegi icin tablo bulunamadi.'
  }

  $builder = [System.Text.StringBuilder]::new()
  [void]$builder.AppendLine('-- Yatirim Defterim D1 SQL backup')
  [void]$builder.AppendLine(("-- Created UTC: {0}" -f [DateTime]::UtcNow.ToString('o')))
  [void]$builder.AppendLine('PRAGMA foreign_keys=OFF;')
  [void]$builder.AppendLine('BEGIN TRANSACTION;')

  foreach ($table in $tableRows) {
    $ddl = ([string]$table.sql).Trim().TrimEnd(';')
    [void]$builder.AppendLine("$ddl;")
  }

  foreach ($table in $tableRows) {
    $tableName = [string]$table.name
    if ($tableName -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
      throw "Guvenli olmayan tablo adi algilandi: $tableName"
    }
    $escapedTable = $tableName.Replace(']', ']]')
    $columnRows = @(Invoke-D1Query -Sql ("PRAGMA table_info([{0}]);" -f $escapedTable))
    $columnNames = @($columnRows | ForEach-Object { [string]$_.name })
    if ($columnNames.Count -eq 0) {
      continue
    }

    $quotedColumns = @($columnNames | ForEach-Object { '[' + $_.Replace(']', ']]') + ']' })
    $literalColumns = @($quotedColumns | ForEach-Object { 'quote({0}) AS {0}' -f $_ })
    $dataRows = @(Invoke-D1Query -Sql ("SELECT {0} FROM [{1}];" -f ($literalColumns -join ', '), $escapedTable))
    foreach ($row in $dataRows) {
      $values = @($columnNames | ForEach-Object {
        $value = $row.PSObject.Properties[$_].Value
        if ($null -eq $value) { 'NULL' } else { [string]$value }
      })
      [void]$builder.AppendLine(("INSERT INTO [{0}] ({1}) VALUES ({2});" -f $escapedTable, ($quotedColumns -join ', '), ($values -join ', ')))
    }
  }

  foreach ($schemaEntry in @($schemaRows | Where-Object { $_.type -ne 'table' })) {
    $ddl = ([string]$schemaEntry.sql).Trim().TrimEnd(';')
    [void]$builder.AppendLine("$ddl;")
  }
  [void]$builder.AppendLine('COMMIT;')
  [void]$builder.AppendLine('PRAGMA foreign_keys=ON;')
  Set-Content -LiteralPath $stagedPath -Value $builder.ToString() -Encoding UTF8

  $sql = Get-Content -LiteralPath $stagedPath -Raw
  if ($sql -notmatch '(?im)^CREATE TABLE') {
    throw 'SQL yedegi beklenen tablo semasini icermiyor.'
  }

  $published = Publish-BackupFile -StagedPath $stagedPath -DestinationDirectory $weeklyDirectory
  Write-BackupLog -Level INFO -Message ("SQL tamamlandi: {0}; {1} bayt; SHA256={2}" -f (Split-Path -Leaf $published.Path), $published.Bytes, $published.Sha256)
  return $published
}

try {
  $lockAcquired = $mutex.WaitOne(0)
  if (-not $lockAcquired) {
    throw 'Baska bir Yatirim Defterim yedeklemesi halen calisiyor.'
  }

  $env:NO_COLOR = '1'
  Import-CloudflareToken
  New-Item -ItemType Directory -Path $stagingDirectory -Force | Out-Null

  $results = @()
  if ($Mode -in @('Json', 'All')) {
    $results += New-JsonBackup
  }
  if ($Mode -in @('Sql', 'All')) {
    $results += New-SqlBackup
  }

  $results | Select-Object Path, Bytes, Sha256
} catch {
  try {
    $stack = ($_.ScriptStackTrace -replace '[\r\n]+', ' ').Trim()
    Write-BackupLog -Level ERROR -Message ("$Mode basarisiz: {0}; konum={1}" -f $_.Exception.Message, $stack)
  } catch {
    # Ana hatayi koru; log klasoru ulasilamazsa ikinci bir hatayla gizleme.
  }
  throw
} finally {
  if ($lockAcquired) {
    $mutex.ReleaseMutex()
  }
  $mutex.Dispose()
  $env:NO_COLOR = $oldNoColor
  $env:CLOUDFLARE_API_TOKEN = $oldCloudflareApiToken
  if (Test-Path -LiteralPath $stagingDirectory) {
    Get-ChildItem -LiteralPath $stagingDirectory -Force -ErrorAction SilentlyContinue |
      Remove-Item -Force -Recurse -ErrorAction SilentlyContinue
  }
}
