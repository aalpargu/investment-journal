[CmdletBinding()]
param(
  [SecureString]$Token,
  [string]$TokenFile,
  [switch]$FromClipboard
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($TokenFile)) {
  $TokenFile = Join-Path $projectRoot '.secrets\cloudflare-backup-token.dpapi'
}
$clearClipboard = $false
try {
  if ($null -eq $Token -or $Token.Length -eq 0) {
    if ($FromClipboard) {
      $plainToken = (Get-Clipboard -Raw).Trim()
      if ($plainToken -notmatch '^cfut_[A-Za-z0-9_-]+$') {
        throw 'Panoda gecerli bir Cloudflare API tokeni bulunamadi.'
      }
      $Token = ConvertTo-SecureString $plainToken -AsPlainText -Force
      $plainToken = $null
      $clearClipboard = $true
    }
    else {
      $Token = Read-Host 'Cloudflare D1 Read API tokenini yapistirin' -AsSecureString
    }
  }

  $tokenDirectory = Split-Path -Parent $TokenFile
  New-Item -ItemType Directory -Path $tokenDirectory -Force | Out-Null
  $Token | ConvertFrom-SecureString | Set-Content -LiteralPath $TokenFile -Encoding ASCII

  $roundTrip = (Get-Content -LiteralPath $TokenFile -Raw).Trim() | ConvertTo-SecureString
  if ($roundTrip.Length -le 0) {
    throw 'Sifrelenmis Cloudflare belirteci dogrulanamadi.'
  }

  Write-Output "Cloudflare yedekleme belirteci Windows DPAPI ile kaydedildi: $TokenFile"
}
finally {
  if ($clearClipboard) {
    Set-Clipboard -Value ''
  }
}
