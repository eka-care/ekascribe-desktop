'use strict';

// Called by electron-builder for every Windows binary that needs signing.
// When AZURE_CLIENT_SECRET is absent (local dev), signing is skipped silently.
const { execFileSync } = require('child_process');

exports.default = async function sign(configuration) {
  if (!process.env.AZURE_CLIENT_SECRET) {
    console.log('[sign] AZURE_CLIENT_SECRET not set — skipping Windows code signing');
    return;
  }

  console.log(`[sign] Signing via Azure Key Vault: ${configuration.path}`);

  execFileSync(
    'azuresigntool',
    [
      'sign',
      '--azure-key-vault-url',         'https://codesigningeka.vault.azure.net',
      '--azure-key-vault-client-id',    process.env.AZURE_CLIENT_ID,
      '--azure-key-vault-client-secret', process.env.AZURE_CLIENT_SECRET,
      '--azure-key-vault-tenant-id',   process.env.AZURE_TENANT_ID,
      '--azure-key-vault-certificate', 'Eka-care-EV-Code-Signing',
      '--timestamp-rfc3161',           'http://timestamp.acs.microsoft.com',
      '--file-digest',                 'sha256',
      '--timestamp-digest',            'sha256',
      configuration.path,
    ],
    { stdio: 'inherit' }
  );
};
