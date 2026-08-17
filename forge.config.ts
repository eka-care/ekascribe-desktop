import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerZIP } from '@electron-forge/maker-zip';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';

// Force the embedded ekascribe-web (Next.js) to compile for the desktop platform family.
// Set here — before Electron is spawned — so the main process, and the Next dev server it
// runs, inherit it from launch. A runtime `process.env` mutation later (in the web manager)
// is not reliably picked up by Next's webpack, which is why dev was compiling the `web`
// family and falling back to the website login. Respects an explicit override if present.
if (!process.env.NEXT_PUBLIC_APP_SOURCE) {
  process.env.NEXT_PUBLIC_APP_SOURCE =
    process.platform === 'win32' ? 'electron-windows' : 'electron-mac';
}

// The embedded web app ships as the Next static export; electron-builder maps it to
// resources/ekascribe-web/out, which is where ekascribeWebManager looks when packaged.
const extraResources = [
  'external/ekascribe/apps/web/out',
  ...(process.platform === 'win32'
    ? ['windows/EkaDeskDocHelper/EkaDeskDocHelper/bin/Release/net10.0-windows']
    : []),
];

const ignoredPaths = [
  /^\/external($|\/)/,
  /^\/windows($|\/)/,
  /^\/mac($|\/)/,
  /^\/out($|\/)/,
  /^\/certs($|\/)/,
  /^\/scripts($|\/)/,
  /^\/\.cursor($|\/)/,
  /^\/\.vscode($|\/)/,
  /^\/\.git($|\/)/,
  /^\/asar-list\.txt$/,
  /^\/tmp-asar($|\/)/,
];

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    prune: true,
    // Keep the packaged app lean while never excluding Vite build output.
    ignore: (file: string) => {
      if (!file) return false;
      if (file.startsWith('/.vite')) return false;
      return ignoredPaths.some((pattern) => pattern.test(file));
    },
    // Always ship runtime; include Windows helper only on Windows builds.
    icon: "build/icons/icon",
    extraResource: extraResources,
    extendInfo: {
      NSMicrophoneUsageDescription: 'Please allow microphone access to use the Eka Scribe feature.',
      NSAudioCaptureUsageDescription:
        'Please allow system audio capture to include system sound in Eka Scribe recordings.',
    },
  },
  rebuildConfig: {},
  makers: [
    new MakerZIP({}, ['win32', 'darwin']),
    new MakerRpm({}),
    new MakerDeb({}),
  ],
  plugins: [
    new VitePlugin({
      // `build` can specify multiple entry builds, which can be Main process, Preload scripts, Worker process, etc.
      // If you are familiar with Vite configuration, it will look really familiar.
      build: [
        {
          // `entry` is just an alias for `build.lib.entry` in the corresponding file of `config`.
          entry: 'src/main/main.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/preload.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};

export default config;
