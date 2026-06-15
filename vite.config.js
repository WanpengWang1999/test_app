import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiTarget = process.env.VITE_DEV_API_TARGET || 'http://127.0.0.1:3001';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      '/api': apiTarget,
      '/exports': apiTarget,
      '/uploads': apiTarget,
      '/ws': {
        target: apiTarget.replace(/^http/, 'ws'),
        ws: true
      }
    }
  },
  build: {
    outDir: 'dist'
  }
});
