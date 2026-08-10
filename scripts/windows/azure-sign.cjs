const { spawnSync } = require('child_process');

const RETRYABLE_PATTERNS = [
  /No such host is known/i,
  /ENOTFOUND/i,
  /EAI_AGAIN/i,
  /Retry failed after \d+ tries/i,
  /temporarily unavailable/i,
  /timed out/i,
  // ERROR_SHARING_VIOLATION — NSIS output, Defender, or indexer still has the file
  /80070020/i,
  /SHARING_VIOLATION/i,
  /being used by another process/i,
  /The process cannot access the file/i
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isRetryableError(error) {
  const message = [error?.message, error?.stderr?.toString?.(), error?.stdout?.toString?.()]
    .filter(Boolean)
    .join('\n');
  return RETRYABLE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * electron-builder custom Windows sign hook.
 * Called once for each signable artifact.
 */
module.exports = async function azureSign(configuration) {
  if (!configuration?.path) {
    throw new Error('[azure-sign] Missing file path from electron-builder sign hook.');
  }

  if (process.env.SKIP_SIGNING === 'true') {
    console.log(`[azure-sign] SKIP_SIGNING=true — skipping code signing for ${configuration.path}`);
    return;
  }

  const targetPath = configuration.path;
  const vaultUrl =
    process.env.AZURE_KEY_VAULT_URL || 'https://codesigningeka.vault.azure.net';
  const certificateName =
    process.env.AZURE_KEY_VAULT_CERT || 'Eka-care-EV-Code-Signing';
  const timestampUrl =
    process.env.AZURE_SIGN_TIMESTAMP_URL || 'http://timestamp.digicert.com';
  const hashAlgorithm = process.env.AZURE_SIGN_HASH || 'sha256';

  const args = [
    'sign',
    '-kvu',
    vaultUrl,
    '-kvc',
    certificateName,
    '-kvm',
    '-tr',
    timestampUrl,
    '-td',
    hashAlgorithm,
    '-fd',
    hashAlgorithm,
    '-v',
    targetPath
  ];

  const attempts = Number.parseInt(process.env.AZURE_SIGN_RETRY_ATTEMPTS || '4', 10);
  const baseDelayMs = Number.parseInt(process.env.AZURE_SIGN_RETRY_DELAY_MS || '2000', 10);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Pipe stderr so we can detect HRESULTs like 80070020 for retries; `inherit`
    // drops stderr on the thrown Error and breaks sharing-violation detection.
    const result = spawnSync('AzureSignTool', args, {
      stdio: ['inherit', 'inherit', 'pipe'],
      env: process.env,
      encoding: 'utf8'
    });
    if (result.error) {
      throw result.error;
    }
    const errText = result.stderr || '';
    if (errText) process.stderr.write(errText);
    if (result.status === 0) {
      return;
    }

    const error = Object.assign(new Error(`AzureSignTool exited with code ${result.status}`), {
      stderr: errText,
      status: result.status
    });
    const retryable = isRetryableError(error);
    const isLast = attempt >= attempts;
    if (!retryable || isLast) {
      throw error;
    }
    const delay = baseDelayMs * Math.pow(2, attempt - 1);
    console.warn(
      `[azure-sign] Transient signing failure for ${targetPath}. Retrying ${attempt}/${attempts - 1} in ${delay}ms...`
    );
    await sleep(delay);
  }
};