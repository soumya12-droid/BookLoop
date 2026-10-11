import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

// In development the browser talks to the SAME origin (/api) and Vite forwards to the backend.
// This keeps the backend's CORS policy closed (it allows no browser origin by default) and means no
// server configuration has to change. The target comes from VITE_API_BASE_URL (a public address,
// never a secret). In a production build the client calls VITE_API_BASE_URL directly, which then
// requires that origin to be listed in the backend's CORS_ORIGINS.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const target = env.VITE_API_BASE_URL || 'http://127.0.0.1:4000';
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: { '/api': { target, changeOrigin: true } },
    },
    preview: { port: 4173, proxy: { '/api': { target, changeOrigin: true } } },
    test: { environment: 'node', include: ['src/**/*.test.{ts,tsx}'] },
  };
});
