/**
 * electron-builder sign hook for local dev builds.
 * Uses PowerShell Set-AuthenticodeSignature — no Windows SDK / signtool.exe required.
 * Set CSC_LINK to the PFX path and CSC_KEY_PASSWORD to the PFX password before building.
 * Used by make:win; production builds use azure-sign.cjs instead.
 */
const { spawnSync } = require('child_process');
const path = require('path');

module.exports = async function localSign(configuration) {
  if (!configuration?.path) {
    throw new Error('[local-sign] Missing file path from electron-builder sign hook.');
  }

  const cscLink = process.env.CSC_LINK || process.env.WIN_CSC_LINK;
  if (!cscLink) {
    console.log(`[local-sign] CSC_LINK not set — skipping: ${configuration.path}`);
    return;
  }

  const password = process.env.CSC_KEY_PASSWORD || process.env.WIN_CSC_KEY_PASSWORD || '';
  const escapedPfx    = cscLink.replace(/'/g, "''");
  const escapedTarget = configuration.path.replace(/'/g, "''");
  const escapedPwd    = password.replace(/'/g, "''");

  const psScript = [
    `$cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2('${escapedPfx}', '${escapedPwd}')`,
    `$r    = Set-AuthenticodeSignature -FilePath '${escapedTarget}' -Certificate $cert -HashAlgorithm SHA256`,
    `if ($r.Status -eq 'NotSigned') { Write-Error "Signing failed: $($r.StatusMessage)"; exit 1 }`,
  ].join('; ');

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', psScript],
    { stdio: 'inherit', encoding: 'utf8', timeout: 30000 },
  );

  if (result.status !== 0 || result.error) {
    throw result.error || new Error(`[local-sign] exit ${result.status} for ${path.basename(configuration.path)}`);
  }
};
