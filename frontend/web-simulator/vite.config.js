// RUNWAVE Web シミュレーターの Vite 設定
// - dev は 127.0.0.1:5174、preview は 127.0.0.1:4174（dev-dashboard の 5173/4173 とは別）
// - server.fs.allow は「このアプリ」「core/」「直接 import する dev-dashboard/src」だけ
// - ビルド時に Git SHA を埋め込む（.git の中を読むだけ。git コマンドは実行しない）
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(appDir, '..', '..');
const coreDir = resolve(repoRoot, 'core');
const dashboardSrc = resolve(repoRoot, 'frontend', 'dev-dashboard', 'src');

const readText = (p) => {
  try { return readFileSync(p, 'utf8').trim(); } catch { return null; }
};

function readGitMeta() {
  const meta = { gitSha: null, gitBranch: null };
  try {
    const gitDir = join(repoRoot, '.git');
    const head = readText(join(gitDir, 'HEAD'));
    if (!head) return meta;
    const ref = /^ref:\s*(.+)$/.exec(head);
    if (!ref) {
      if (/^[0-9a-f]{40}$/i.test(head)) meta.gitSha = head;
      return meta;
    }
    meta.gitBranch = ref[1].trim().replace(/^refs\/heads\//, '');
    let sha = readText(join(gitDir, ref[1].trim()));
    if (!sha) {
      const line = readText(join(gitDir, 'packed-refs'))?.split(/\r?\n/).find((l) => l.endsWith(` ${ref[1].trim()}`));
      sha = line ? line.split(' ')[0] : null;
    }
    if (sha && /^[0-9a-f]{40}$/i.test(sha)) meta.gitSha = sha;
  } catch {
    // 読めなければ null（画面では「不明」と表示）
  }
  return meta;
}

export default defineConfig(() => ({
  root: appDir,
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
    fs: { allow: [appDir, coreDir, dashboardSrc] },
  },
  preview: { host: '127.0.0.1', port: 4174 },
  define: {
    __RUNWAVE_META__: JSON.stringify({ ...readGitMeta(), builtAt: new Date().toISOString() }),
  },
  build: { outDir: 'dist', emptyOutDir: true },
}));
