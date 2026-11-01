import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

const API = 'http://127.0.0.1:4477';

export default defineConfig({
  plugins: [preact()],
  root: 'src/ui',
  build: { outDir: '../../dist', emptyOutDir: true },
  server: { proxy: { '/api': API, '/thumb': API } },
});
