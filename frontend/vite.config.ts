/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { frappeMock } from './dev/frappeMock';

/**
 * `vite build --mode frappe` (npm run build:frappe) builds the page served by the pmc_3d_progress
 * Frappe app: assets go to ../pmc_3d_progress/public/frontend (served at /assets/pmc_3d_progress/frontend)
 * and scripts/frappe-postbuild.mjs moves index.html to ../pmc_3d_progress/www/pmc-3d.html (the /pmc-3d page).
 */
const frappeCsrf = (): Plugin => ({
  name: 'pmc-frappe-csrf',
  // Jinja fills this in when Frappe renders the www page; API calls send it as X-Frappe-CSRF-Token.
  transformIndexHtml: (html) =>
    html
      .replace('<title>PMC 3D Progress — Local Demo</title>', '<title>PMC 3D Progress</title>')
      .replace('</head>', '    <script>window.csrf_token = "{{ csrf_token }}";</script>\n  </head>'),
});

export default defineConfig(({ mode }) => {
  const frappe = mode === 'frappe';
  return {
    // 'frappe-mock' (npm run dev:frappe-mock): the Frappe build of the UI against a dev-only stand-in API.
    plugins: frappe ? [react(), frappeCsrf()] : mode === 'frappe-mock' ? [react(), frappeMock()] : [react()],
    base: frappe ? '/assets/pmc_3d_progress/frontend/' : '/',
    server: { port: 5183, strictPort: true },
    preview: { port: 5184, strictPort: true },
    build: {
      chunkSizeWarningLimit: 1600, // three.js + Anthropic SDK; one local bundle on purpose
      ...(frappe ? { outDir: '../pmc_3d_progress/public/frontend', emptyOutDir: true } : {}),
    },
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts'],
    },
  };
});
