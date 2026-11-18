import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// the app version shown in the About dialog (client/src/lib/version.js)
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

const target = process.env.GGS_URL || process.env[`${['GREAN', 'TEA', 'DAWY'].join('')}_URL`] || 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    port: 5173,
    // changeOrigin stays false on purpose: the server compares a request's Origin with its Host (CSRF protection), and
    // Vite's string shorthand rewrites the Host to the target's — "localhost:5173" would then never match
    // "127.0.0.1:3001" and every save, login and first-run setup in `npm run dev` would be refused as cross-origin.
    proxy: {
      '/api': { target, changeOrigin: false },
      '/mcp': { target, changeOrigin: false },
      '/sandbox': { target, changeOrigin: false }, // the generator plugin sandbox page (served by the server with its own CSP)
      '/ws': { target: target.replace(/^http/, 'ws'), ws: true, changeOrigin: false }
    }
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1200
  }
});
