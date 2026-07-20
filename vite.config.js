import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    proxy: {
      '/api-jambase': {
        target: 'https://www.jambase.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api-jambase/, ''),
      },
    },
  },
});
