// Builds the whole app into ONE self-contained HTML file (all JS, CSS and sample models inlined)
// that opens by double-click from disk (file://) — no server, no internet needed.
// Run: npm run build:standalone  →  standalone/PMC-3D-Progress.html
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  base: './',
  build: {
    outDir: 'standalone',
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
  },
});
