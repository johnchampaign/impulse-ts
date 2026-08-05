import { createReadStream, existsSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// Dev-server-only: serve a local .vmod at /dev-only/module.vmod so an
// automated browser check can load card art without driving a native file
// picker. `configureServer` runs ONLY under `vite dev` — it cannot put the
// module (which is copyrighted publisher art) into a built bundle. Off unless
// DEV_VMOD points at a file.
function devVmodRoute(): Plugin {
  return {
    name: 'impulse-dev-vmod',
    apply: 'serve',
    configureServer(server) {
      const path = process.env['DEV_VMOD'];
      if (!path || !existsSync(path)) return;
      server.middlewares.use('/dev-only/module.vmod', (_req, res) => {
        res.setHeader('content-type', 'application/octet-stream');
        createReadStream(path).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), devVmodRoute()],
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
