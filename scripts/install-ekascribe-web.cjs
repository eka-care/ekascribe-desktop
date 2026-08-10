/**
 * Install ekascribe-web deps for packaging.
 *
 * 1. Hide the desktop app's esbuild so web postinstall does not pick up Vite's
 *    esbuild@0.21 binary (Expected "0.25.x" but got "0.21.5").
 * 2. Install web deps.
 * 3. Backfill platform-native optional packages omitted from darwin-generated
 *    package-lock.json (lightningcss, @tailwindcss/oxide, @esbuild).
 *
 * The web app is the `apps/web` workspace of the ekascribe monorepo submodule, and it
 * depends on sibling workspaces via `file:../../packages/*`. Installing therefore has to
 * happen at the monorepo root — that is also where npm hoists node_modules.
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const monorepoDir = path.join(root, 'external', 'ekascribe');
const hide = ['node_modules/esbuild', 'node_modules/@esbuild'];
const moved = [];

function platformNativePackage(parentName, version) {
  const { platform, arch } = process;
  const winArch = arch === 'arm64' ? 'arm64' : 'x64';

  if (parentName === 'lightningcss') {
    if (platform === 'win32') return `lightningcss-win32-${winArch}-msvc@${version}`;
    if (platform === 'darwin') return `lightningcss-darwin-${arch}@${version}`;
    if (platform === 'linux') return `lightningcss-linux-${winArch}-gnu@${version}`;
  }

  if (parentName === '@tailwindcss/oxide') {
    if (platform === 'win32') return `@tailwindcss/oxide-win32-${winArch}-msvc@${version}`;
    if (platform === 'darwin') return `@tailwindcss/oxide-darwin-${arch}@${version}`;
    if (platform === 'linux') return `@tailwindcss/oxide-linux-${winArch}-gnu@${version}`;
  }

  if (parentName === 'esbuild') {
    if (platform === 'win32') return `@esbuild/win32-${winArch}@${version}`;
    if (platform === 'darwin') return `@esbuild/darwin-${arch}@${version}`;
    if (platform === 'linux') return `@esbuild/linux-${winArch}@${version}`;
  }

  return null;
}

function nativePackagePath(native) {
  const pkgName = native.slice(0, native.lastIndexOf('@'));
  return path.join(monorepoDir, 'node_modules', ...pkgName.split('/'));
}

function missingNativeOptional(parentName) {
  const pkgJsonPath = path.join(monorepoDir, 'node_modules', ...parentName.split('/'), 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return null;

  const { version } = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  const native = platformNativePackage(parentName, version);
  if (!native) return null;

  return fs.existsSync(nativePackagePath(native)) ? null : native;
}

// Each `npm install` reconciles the tree against package-lock.json and prunes
// packages absent from it — including natives backfilled by a previous install.
// Install every missing native in ONE invocation so none get pruned.
function backfillNativeOptionals(parentNames) {
  const missing = parentNames
    .map(missingNativeOptional)
    .filter(Boolean);
  if (!missing.length) return;

  console.log(`[install-ekascribe-web] Backfilling missing native packages: ${missing.join(', ')}`);
  cp.execSync(`npm install --no-save --legacy-peer-deps ${missing.join(' ')}`, {
    cwd: monorepoDir,
    stdio: 'inherit',
    env: process.env,
  });

  const stillMissing = missing.filter((native) => !fs.existsSync(nativePackagePath(native)));
  if (stillMissing.length) {
    throw new Error(
      `[install-ekascribe-web] Native packages still missing after backfill: ${stillMissing.join(', ')}`
    );
  }
}

for (const rel of hide) {
  const from = path.join(root, rel);
  if (!fs.existsSync(from)) continue;
  const to = `${from}.__hide`;
  fs.renameSync(from, to);
  moved.push([to, from]);
}

try {
  cp.execSync('npm install --legacy-peer-deps', {
    cwd: monorepoDir,
    stdio: 'inherit',
    env: process.env,
  });

  // Parent is still hidden so @esbuild/win32-* lands under the web tree.
  backfillNativeOptionals(['lightningcss', '@tailwindcss/oxide', 'esbuild']);
} finally {
  for (const [from, to] of moved) {
    try {
      if (fs.existsSync(from)) fs.renameSync(from, to);
    } catch (_) {
      // best-effort restore
    }
  }
}
