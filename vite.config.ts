/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5183, strictPort: true },
  preview: { port: 5184, strictPort: true },
  build: {
    chunkSizeWarningLimit: 1600, // three.js + Anthropic SDK; one local bundle on purpose
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
