import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // Cloudflare Pages serves at root. Deliberately NOT env-gated (framework
  // integration-guide deploy gotcha: env-gated base → blank page on manual
  // deploys without .env).
  base: '/',
  resolve: {
    // Framework hooks crash with two React copies (integration-guide gotcha).
    dedupe: ['react', 'react-dom'],
  },
});
