import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  define: {
    // Build stamp for the footer + bug reports. Vite injects at build time —
    // the ENGINE never reads it (no Date.now in src/engine).
    __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
  },
  // Cloudflare Pages serves at root. Deliberately NOT env-gated (framework
  // integration-guide deploy gotcha: env-gated base → blank page on manual
  // deploys without .env).
  base: '/',
  resolve: {
    // Framework hooks crash with two React copies (integration-guide gotcha).
    dedupe: ['react', 'react-dom'],
  },
  server: {
    // Local dev drives the PRODUCTION API (there is no Node-local GameServer;
    // the store is Workers/Supabase). Fine for UI work; mind that games you
    // create are real rows.
    proxy: { '/api': { target: 'https://impulse-ts.pages.dev', changeOrigin: true } },
  },
});
