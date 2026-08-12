import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    sourcemap: true,
    rollupOptions: {
      // Resolved from node_modules at runtime instead of bundled: both packages rely on
      // dynamic requires that Rollup can't statically analyse.
      external: ['@whiskeysockets/baileys', 'express'],
    },
  },
});