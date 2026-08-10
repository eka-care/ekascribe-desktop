import path from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import { createRequire } from 'node:module';
import { app, ipcMain } from 'electron';

const EKASCRIBE_WEB_PORT = 3876;
const EKASCRIBE_WEB_HOST = '127.0.0.1';
const EKASCRIBE_WEB_URL = `http://${EKASCRIBE_WEB_HOST}:${EKASCRIBE_WEB_PORT}`;

type NextAppLike = {
  prepare: () => Promise<void>;
  getRequestHandler: () => (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> | void;
  close?: () => Promise<void>;
};

let ekascribeServer: HttpServer | null = null;
let ekascribeNextApp: NextAppLike | null = null;
let startPromise: Promise<string> | null = null;

export function registerEkascribeWebIpcHandlers(): void {
  ipcMain.handle('ekascribe-web:start', startEkascribeWeb);
  ipcMain.handle('ekascribe-web:stop', stopEkascribeWeb);
  ipcMain.handle('ekascribe-web:url', () => EKASCRIBE_WEB_URL);
}

export async function startEkascribeWeb(): Promise<string> {
  if (ekascribeServer?.listening) {
    return EKASCRIBE_WEB_URL;
  }

  if (startPromise) {
    return startPromise;
  }

  startPromise = (async () => {
    process.env.NEXT_PUBLIC_APP_SOURCE =
      process.platform === 'win32' ? 'electron-windows' : 'electron-mac';

    if (app.isPackaged) {
      const staticRoot = tryResolveEkascribeStaticRoot();
      if (staticRoot) {
        await startStaticServer(staticRoot);
      } else {
        const repoPath = resolveEkascribeRepoPath();
        await ensureDependenciesInstalled(repoPath);
        await startNextServer(repoPath);
      }
    } else {
      const repoPath = resolveEkascribeRepoPath();
      await ensureDependenciesInstalled(repoPath);
      await startNextServer(repoPath);
    }
    return EKASCRIBE_WEB_URL;
  })();

  try {
    return await startPromise;
  } finally {
    startPromise = null;
  }
}

export async function stopEkascribeWeb(): Promise<void> {
  const server = ekascribeServer;
  ekascribeServer = null;
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  if (ekascribeNextApp?.close) {
    try {
      await ekascribeNextApp.close();
    } catch (error) {
      console.error('[ekascribe-web] failed closing next app', error);
    }
  }
  ekascribeNextApp = null;
}

async function ensureDependenciesInstalled(repoPath: string): Promise<void> {
  // npm workspaces hoist node_modules to the monorepo root, and the Next standalone
  // bundle does the same, so the tree may live several levels above the app dir.
  if (findHoistedNodeModules(repoPath)) {
    return;
  }

  const triedPaths = getEkascribeRepoCandidates()
    .map((candidatePath) => `- ${candidatePath}`)
    .join('\n');

  throw new Error(
    `Missing dependencies for ${repoPath} (no node_modules in it or any parent).\nSearched ekascribe-web locations:\n${triedPaths}\nRun "npm install" inside external/ekascribe before packaging, then rebuild the desktop app.`
  );
}

function findHoistedNodeModules(startPath: string): string | null {
  let current = startPath;
  for (;;) {
    const candidate = path.join(current, 'node_modules');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveEkascribeStaticRoot(): string {
  const candidates = getEkascribeStaticCandidates();
  const existing = candidates.find((candidatePath) =>
    existsSync(path.join(candidatePath, 'index.html'))
  );
  if (existing) {
    return existing;
  }

  const triedPaths = candidates.map((candidatePath) => `- ${candidatePath}`).join('\n');
  throw new Error(
    `Missing static ekascribe-web export (index.html).\nSearched export locations:\n${triedPaths}\nRun "npm run build:ekascribe-web:static" before packaging, then rebuild the desktop app.`
  );
}

function tryResolveEkascribeStaticRoot(): string | null {
  try {
    return resolveEkascribeStaticRoot();
  } catch {
    return null;
  }
}

function getEkascribeStaticCandidates(): string[] {
  const appPath = appRootPath();
  const resourcesPath = process.resourcesPath;

  if (!app.isPackaged) {
    return [
      path.join(appPath, 'external', 'ekascribe', 'apps', 'web', 'out'),
      path.join(appPath, '..', 'external', 'ekascribe', 'apps', 'web', 'out'),
    ];
  }

  return [
    path.join(appPath, 'external', 'ekascribe', 'apps', 'web', 'out'),
    path.join(resourcesPath, 'external', 'ekascribe', 'apps', 'web', 'out'),
    path.join(resourcesPath, 'ekascribe-web', 'out'),
  ];
}

function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.html': return 'text/html; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.mjs': return 'application/javascript; charset=utf-8';
    case '.css': return 'text/css; charset=utf-8';
    case '.json': return 'application/json; charset=utf-8';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.ico': return 'image/x-icon';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.ttf': return 'font/ttf';
    default: return 'application/octet-stream';
  }
}

async function startStaticServer(staticRoot: string): Promise<void> {
  const server = createServer((req, res) => {
    try {
      const rawUrl = req.url ?? '/';
      const urlPath = rawUrl.split('?')[0] || '/';
      const decodedPath = decodeURIComponent(urlPath);
      const safeRelative = decodedPath.replace(/^\/+/, '');
      const requestedPath = safeRelative === '' ? 'index.html' : safeRelative;
      const resolvedPath = path.resolve(staticRoot, requestedPath);
      const normalizedRoot = path.resolve(staticRoot);

      if (!resolvedPath.startsWith(normalizedRoot)) {
        res.statusCode = 403;
        res.end('Forbidden');
        return;
      }

      let targetPath = resolvedPath;
      if (!existsSync(targetPath)) {
        const htmlFallback = `${resolvedPath}.html`;
        const nestedIndexFallback = path.join(resolvedPath, 'index.html');
        if (existsSync(htmlFallback)) {
          targetPath = htmlFallback;
        } else if (existsSync(nestedIndexFallback)) {
          targetPath = nestedIndexFallback;
        } else {
          // Support legacy dynamic-like paths by walking up to nearest static index.
          let cursor = path.dirname(resolvedPath);
          let matched = '';
          while (cursor.startsWith(normalizedRoot)) {
            const candidate = path.join(cursor, 'index.html');
            if (existsSync(candidate)) {
              matched = candidate;
              break;
            }
            if (cursor === normalizedRoot) {
              break;
            }
            cursor = path.dirname(cursor);
          }
          targetPath = matched || path.join(normalizedRoot, 'index.html');
        }
      }

      const body = readFileSync(targetPath);
      res.statusCode = 200;
      res.setHeader('Content-Type', getContentType(targetPath));
      res.end(body);
    } catch (error) {
      console.error('[ekascribe-web] static request handling failed', error);
      res.statusCode = 500;
      res.end('Internal Server Error');
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(EKASCRIBE_WEB_PORT, EKASCRIBE_WEB_HOST, () => resolve());
  });

  ekascribeServer = server;
}

async function startNextServer(repoPath: string): Promise<void> {
  injectElectronEnv();

  const requireFromEkascribe = createRequire(path.join(repoPath, 'package.json'));
  const nextModule = requireFromEkascribe('next') as (opts: {
    dev: boolean;
    dir: string;
    hostname: string;
    port: number;
  }) => NextAppLike;

  const nextApp = nextModule({
    // Packaged desktop app must run Next in production mode.
    dev: app.isPackaged ? false : process.env.NODE_ENV !== 'production',
    dir: repoPath,
    hostname: EKASCRIBE_WEB_HOST,
    port: EKASCRIBE_WEB_PORT,
  });

  await nextApp.prepare();
  const handler = nextApp.getRequestHandler();

  const server = createServer((req, res) => {
    void Promise.resolve(handler(req, res)).catch((error) => {
      console.error('[ekascribe-web] request handling failed', error);
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      res.end('Internal Server Error');
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(EKASCRIBE_WEB_PORT, EKASCRIBE_WEB_HOST, () => resolve());
  });

  ekascribeNextApp = nextApp;
  ekascribeServer = server;
}

function appRootPath(): string {
  return app.getAppPath();
}

function loadEnvFile(filePath: string): Record<string, string> {
  if (!existsSync(filePath)) return {};
  const lines = readFileSync(filePath, 'utf-8').split('\n');
  const result: Record<string, string> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key) result[key] = value;
  }
  return result;
}

function injectElectronEnv(): void {
  const vars = loadEnvFile(path.join(appRootPath(), 'electron.env'));
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in process.env)) process.env[k] = v;
  }
}

function resolveEkascribeRepoPath(): string {
  const candidates = getEkascribeRepoCandidates();
  const existing = candidates.find((candidatePath) =>
    existsSync(path.join(candidatePath, 'package.json'))
  );

  if (existing) {
    return existing;
  }

  return candidates[0];
}

function getEkascribeRepoCandidates(): string[] {
  const appPath = appRootPath();
  const resourcesPath = process.resourcesPath;
  if (!app.isPackaged) {
    return [
      // Dev mode: always prefer the web workspace inside the monorepo submodule.
      path.join(appPath, 'external', 'ekascribe', 'apps', 'web'),
      // If appPath differs from workspace root, allow one-level-up fallback.
      path.join(appPath, '..', 'external', 'ekascribe', 'apps', 'web'),
      // Last resort in dev when prepackage already prepared runtime.
      ...runtimeAppDirs(path.join(appPath, 'external', 'ekascribe-runtime')),
    ];
  }
  return [
    // Builder runtime bundle inside app.asar.
    ...runtimeAppDirs(path.join(appPath, 'external', 'ekascribe-runtime')),
    // Forge extraResource: ['external/ekascribe-runtime'] -> resources/ekascribe-runtime
    ...runtimeAppDirs(path.join(resourcesPath, 'ekascribe-runtime')),
    // Builder runtime bundle copied to resources (fallback).
    ...runtimeAppDirs(path.join(resourcesPath, 'external', 'ekascribe-runtime')),
    // Unpacked submodule checkout, if a build ever ships one.
    path.join(appPath, 'external', 'ekascribe', 'apps', 'web'),
    path.join(resourcesPath, 'external', 'ekascribe', 'apps', 'web'),
  ];
}

/**
 * The Next standalone bundle mirrors the monorepo tree (`outputFileTracingRoot` is pinned
 * to the repo root), so `server.js` sits under `apps/web` rather than at the bundle root.
 * `scripts/prepare-ekascribe-runtime.cjs` records the real location in runtime-manifest.json;
 * fall back to the bundle root for a flat bundle.
 */
function runtimeAppDirs(runtimeRoot: string): string[] {
  const dirs: string[] = [];
  try {
    const manifestPath = path.join(runtimeRoot, 'runtime-manifest.json');
    if (existsSync(manifestPath)) {
      const { appDir } = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { appDir?: string };
      if (appDir) dirs.push(path.join(runtimeRoot, ...appDir.split('/')));
    }
  } catch (error) {
    console.error('[ekascribe-web] failed reading runtime manifest', error);
  }
  dirs.push(runtimeRoot);
  return dirs;
}

