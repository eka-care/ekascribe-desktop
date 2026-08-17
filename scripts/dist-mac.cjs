/**
 * Signed macOS dist (dmg + zip).
 *
 * Notarization is best-effort: if Apple ID / app-specific password are missing
 * or rejected (401), we still sign with Developer ID and skip notarytool so a
 * local dist can complete. CI with valid secrets still notarizes.
 */
'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
process.chdir(root);

const electronEnv = path.join(root, 'electron.env');
const envLocal = path.join(root, 'external/ekascribe/apps/web/.env.local');
if (fs.existsSync(electronEnv)) {
  fs.mkdirSync(path.dirname(envLocal), { recursive: true });
  fs.copyFileSync(electronEnv, envLocal);
}

function sanitizeAppleId(raw) {
  if (!raw) return raw;
  let id = raw.trim();
  // `export APPLE_ID='me@x.com'export PATH=...` concatenates to `me@x.comexport`
  if (id.includes('@') && id.endsWith('export')) {
    id = id.slice(0, -'export'.length);
    console.warn(`[dist:mac] Stripped trailing "export" from APPLE_ID (concatenated shell exports). Using ${id}`);
  }
  return id;
}

if (process.env.APPLE_ID) {
  process.env.APPLE_ID = sanitizeAppleId(process.env.APPLE_ID);
}

function canNotarize() {
  const appleId = process.env.APPLE_ID;
  const password = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;
  if (!appleId || !password || !teamId) {
    console.warn('[dist:mac] APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set — skipping notarization.');
    return false;
  }
  try {
    cp.execFileSync(
      'xcrun',
      ['notarytool', 'history', '--apple-id', appleId, '--password', password, '--team-id', teamId],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return true;
  } catch (err) {
    const stderr = err && err.stderr ? String(err.stderr) : String(err);
    console.warn('[dist:mac] notarytool rejected credentials — skipping notarization.');
    console.warn('[dist:mac] Generate a new app-specific password at https://appleid.apple.com and update APPLE_APP_SPECIFIC_PASSWORD.');
    if (stderr.includes('401') || stderr.includes('Invalid credentials')) {
      return false;
    }
    console.warn(stderr.trim());
    return false;
  }
}

const notarize = canNotarize();
const helperPath = path.join(root, 'mac/build/Release/EkaCareDesktopHelper.app');
cp.execSync('npm run build:mac-helper:clean', { stdio: 'inherit' });
if (!fs.existsSync(helperPath)) {
  throw new Error('Mac helper missing at ' + helperPath);
}
cp.execSync('npm run package', { stdio: 'inherit' });

const builderArgs = ['--mac', 'dmg', 'zip'];
if (!notarize) {
  builderArgs.push('--config.mac.notarize=false');
}

const builderBin = path.join(root, 'node_modules/.bin/electron-builder');
cp.execFileSync(builderBin, builderArgs, { stdio: 'inherit', env: process.env });
