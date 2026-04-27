import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    host: process.env.VITE_DEV_HOST ?? '127.0.0.1',
    port: 5174,
    proxy: {
      '/api': process.env.VITE_API_TARGET ?? 'http://127.0.0.1:8734',
    },
  },
});
