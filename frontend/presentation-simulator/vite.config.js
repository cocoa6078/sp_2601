// RUNWAVE 発表用シミュレーターの Vite 設定（frontend/dev-dashboard/vite.config.js に倣う）
// - dev サーバーは 127.0.0.1 だけで待ち受ける
// - server.fs.allow は「このアプリ自身」と「リポジトリの core/」だけ
import { defineConfig } from 'vite';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(appDir, '..', '..');
const coreDir = resolve(repoRoot, 'core');

export default defineConfig(() => ({
  root: appDir,
  server: {
    host: '127.0.0.1',
    port: 5175,
    strictPort: false,
    fs: { allow: [appDir, coreDir] },
  },
  preview: { host: '127.0.0.1', port: 4175 },
  build: { outDir: 'dist', emptyOutDir: true },
}));
