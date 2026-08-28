import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/api/auth': { target: process.env.AUTH_DEV_SERVER || 'http://localhost:3000', changeOrigin: true },
      '/api-jambase': {
        target: 'https://www.jambase.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-jambase/, ''),
      },
    },
  },
});
