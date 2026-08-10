import { defineConfig } from 'vite';

/** Strip "use client" from node_modules so Rollup doesn't warn when bundling (e.g. react-router). */
function stripUseClient() {
  return {
    name: 'strip-use-client',
    transform(code: string, id: string) {
      if (id.includes('node_modules') && /["']use client["']/.test(code)) {
        return { code: code.replace(/^["']use client["'];?\s*\n?/m, ''), map: null };
      }
    },
  };
}

// https://vitejs.dev/config
export default defineConfig({
  root: '.',
  base: './',
  plugins: [stripUseClient()],
  build: {
    rollupOptions: {
      input: ['index.html'],
    },
  },
});
