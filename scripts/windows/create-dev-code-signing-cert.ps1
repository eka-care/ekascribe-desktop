# Creates a self-signed Authenticode cert for local / internal Windows builds.
# Does NOT establish public trust or fix SmartScreen for arbitrary users.
#
# Usage (from repo root):
#   powershell -ExecutionPolicy Bypass -File scripts/windows/create-dev-code-signing-cert.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/windows/create-dev-code-signing-cert.ps1 -Password 'your-secret'
#   npm run cert:win:dev -- -Force   # replace existing certs\dev-code-signing.pfx
#
# Then build (repo root; electron-builder reads CSC_* — no certificateFile in package.json so unsigned builds still work):
#   $env:CSC_LINK = (Resolve-Path .\certs\dev-code-signing.pfx).Path
#   $env:CSC_KEY_PASSWORD = 'your-secret'
#   npm run dist:win
#
# Optional — trust on a test PC (admin PowerShell), then signed builds show as trusted there:
#   Import-Certificate -FilePath certs\dev-code-signing.cer -CertStoreLocation Cert:\LocalMachine\TrustedPublisher

param(
  [string] $Subject = 'CN=Eka Scribe Dev Code Signing',
  [string] $Password = 'dev-only-change-me',
  [switch] $Force
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$certDir = Join-Path $repoRoot 'certs'
New-Item -ItemType Directory -Force -Path $certDir | Out-Null

$pfxPath = Join-Path $certDir 'dev-code-signing.pfx'
$cerPath = Join-Path $certDir 'dev-code-signing.cer'

if (Test-Path $pfxPath) {
  if (-not $Force) {
    throw @"
$pfxPath already exists — skip this step unless you want a new cert.
  Use CSC_KEY_PASSWORD from when you created it (default: dev-only-change-me).
  To replace: npm run cert:win:dev -- -Force
"@
  }
  Remove-Item -Force -Path $pfxPath
}
if (Test-Path $cerPath) {
  Remove-Item -Force -Path $cerPath
}

Write-Host 'Creating self-signed code signing certificate (SHA256, exportable)...'
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject $Subject `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -KeyExportPolicy Exportable `
  -KeySpec Signature `
  -KeyUsage DigitalSignature `
  -HashAlgorithm SHA256 `
  -NotAfter (Get-Date).AddYears(5)

try {
  $securePwd = ConvertTo-SecureString -String $Password -AsPlainText -Force
  Export-PfxCertificate -Cert $cert -FilePath $pfxPath -Password $securePwd | Out-Null
  Export-Certificate -Cert $cert -FilePath $cerPath | Out-Null
  Write-Host "Wrote PFX (private): $pfxPath"
  Write-Host "Wrote CER (public):  $cerPath"
  Write-Host ''
  Write-Host 'Next (from repo root):'
  Write-Host "  `$env:CSC_LINK = (Resolve-Path .\certs\dev-code-signing.pfx).Path"
  Write-Host "  `$env:CSC_KEY_PASSWORD = '$Password'"
  Write-Host '  npm run dist:win'
  Write-Host ''
  Write-Host 'Self-signed builds still warn on machines that do not trust this cert. For internal testing, import the .cer to Trusted Publisher (see script header).'
}
finally {
  $thumb = $cert.Thumbprint
  Remove-Item -Path "Cert:\CurrentUser\My\$thumb" -DeleteKey
}
