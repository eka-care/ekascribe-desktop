const fs = require('node:fs');
const path = require('node:path');

const projectRoot = process.cwd();
// The web app is one workspace of the ekascribe monorepo submodule.
const monorepoRoot = path.join(projectRoot, 'external', 'ekascribe');
const ekascribeRoot = path.join(monorepoRoot, 'apps', 'web');
const nextRoot = path.join(ekascribeRoot, '.next');
const standaloneRoot = path.join(nextRoot, 'standalone');
// Lives outside the submodule so a build never leaves external/ekascribe dirty.
const runtimeRoot = path.join(projectRoot, 'external', 'ekascribe-runtime');
const staticRoot = path.join(nextRoot, 'static');
const publicRoot = path.join(ekascribeRoot, 'public');
// `next` is hoisted to the monorepo root by npm workspaces; fall back to the
// app-local tree in case a future layout installs it there instead.
const sourceNextCompiledRoot = [
  path.join(monorepoRoot, 'node_modules', 'next', 'dist', 'compiled'),
  path.join(ekascribeRoot, 'node_modules', 'next', 'dist', 'compiled'),
].find((candidate) => fs.existsSync(candidate)) ?? path.join(monorepoRoot, 'node_modules', 'next', 'dist', 'compiled');
const runtimeNodeModulesRoot = path.join(runtimeRoot, 'node_modules');

/** Next may sit at the bundle root (hoisted) or beside the app; use whichever exists. */
function resolveRuntimeNextCompiledRoot(runtimeAppRoot) {
  const candidates = [
    path.join(runtimeRoot, 'node_modules', 'next', 'dist', 'compiled'),
    path.join(runtimeAppRoot, 'node_modules', 'next', 'dist', 'compiled'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}
const runtimeBuildTimePackages = [
  'typescript',
  'webpack',
  'terser',
  'terser-webpack-plugin',
  'esbuild',
  '@esbuild',
  '@webassemblyjs',
  'enhanced-resolve',
  'loader-runner',
  'watchpack',
  'jest-worker',
  'schema-utils',
  'neo-async',
  'caniuse-lite',
  'browserslist',
];
const runtimePruneDirectories = new Set([
  '__tests__',
  '__mocks__',
  'test',
  'tests',
  'docs',
  'doc',
  'examples',
  '.github',
  '.vscode',
  'coverage',
  'benchmark',
  'benchmarks',
]);
const runtimePruneFilePatterns = [
  /\.map$/i,
  /\.md$/i,
  /\.markdown$/i,
  /\.ts$/i,
  /\.tsx$/i,
];

function ensureExists(targetPath, label) {
  if (!fs.existsSync(targetPath)) {
    throw new Error(`[prepare-ekascribe-runtime] Missing ${label}: ${targetPath}`);
  }
}

function copyDir(source, destination) {
  fs.cpSync(source, destination, { recursive: true });
}

function copyMissingEntries(sourceDir, destinationDir) {
  if (!fs.existsSync(sourceDir) || !fs.existsSync(destinationDir)) {
    return;
  }

  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    const sourceEntryPath = path.join(sourceDir, entry.name);
    const destinationEntryPath = path.join(destinationDir, entry.name);
    if (fs.existsSync(destinationEntryPath)) {
      continue;
    }
    fs.cpSync(sourceEntryPath, destinationEntryPath, { recursive: true });
  }
}

function removePathIfExists(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }
  fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}

function pruneRuntimeNodeModules() {
  if (!fs.existsSync(runtimeNodeModulesRoot)) {
    return;
  }
  for (const packageName of runtimeBuildTimePackages) {
    removePathIfExists(path.join(runtimeNodeModulesRoot, packageName));
  }
  pruneRuntimeByPatterns(runtimeNodeModulesRoot);
}

function shouldPruneFile(fileName) {
  return runtimePruneFilePatterns.some((pattern) => pattern.test(fileName));
}

function pruneRuntimeByPatterns(rootDir) {
  const stack = [rootDir];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        if (runtimePruneDirectories.has(entry.name.toLowerCase())) {
          fs.rmSync(entryPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
          continue;
        }
        stack.push(entryPath);
        continue;
      }
      if (entry.isFile() && shouldPruneFile(entry.name)) {
        fs.rmSync(entryPath, { force: true, maxRetries: 10, retryDelay: 500 });
      }
    }
  }
}

/**
 * `next.config.ts` pins `outputFileTracingRoot` to the monorepo root, so the standalone
 * output mirrors that tree: `node_modules/` at the root and the server under
 * `apps/web/`. Locate the server rather than assuming a fixed depth, so the bundle
 * still resolves if the tracing root or the workspace path changes upstream.
 */
function findAppDirRelative(root) {
  const stack = [''];
  while (stack.length > 0) {
    const relative = stack.shift();
    const absolute = path.join(root, relative);
    if (fs.existsSync(path.join(absolute, 'server.js'))) {
      return relative;
    }
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === 'node_modules') continue;
      stack.push(path.join(relative, entry.name));
    }
  }
  throw new Error(`[prepare-ekascribe-runtime] No server.js found under ${root}`);
}

ensureExists(standaloneRoot, 'Next standalone output');

fs.rmSync(runtimeRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
fs.mkdirSync(path.dirname(runtimeRoot), { recursive: true });
copyDir(standaloneRoot, runtimeRoot);

const appDirRelative = findAppDirRelative(runtimeRoot);
const runtimeAppRoot = path.join(runtimeRoot, appDirRelative);

if (fs.existsSync(staticRoot)) {
  copyDir(staticRoot, path.join(runtimeAppRoot, '.next', 'static'));
}

if (fs.existsSync(publicRoot)) {
  copyDir(publicRoot, path.join(runtimeAppRoot, 'public'));
}

// Read by ekascribeWebManager to locate the Next app dir inside the bundle.
fs.writeFileSync(
  path.join(runtimeRoot, 'runtime-manifest.json'),
  `${JSON.stringify({ appDir: appDirRelative.split(path.sep).join('/') }, null, 2)}\n`
);

copyMissingEntries(sourceNextCompiledRoot, resolveRuntimeNextCompiledRoot(runtimeAppRoot));
pruneRuntimeNodeModules();

console.log(
  '[prepare-ekascribe-runtime] Runtime bundle prepared at:',
  runtimeRoot,
  `(app dir: ${appDirRelative || '.'})`
);
