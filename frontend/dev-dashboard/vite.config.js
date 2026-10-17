// RUNWAVE 動作確認ダッシュボードの Vite 設定
// - dev サーバーは 127.0.0.1 だけで待ち受ける（LAN・インターネットへは公開しない）
// - server.fs.allow は「ダッシュボード自身」と「リポジトリの core/」だけ（ドライブ全体・リポジトリ全体は公開しない）
// - ビルド時に Git SHA を埋め込む。.git の中のファイルを「読むだけ」で、git コマンドは実行しない
import { defineConfig } from 'vite';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dashboardDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(dashboardDir, '..', '..');
const coreDir = resolve(repoRoot, 'core');

function readText(path) {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

// .git/HEAD → 参照先 ref ファイル（無ければ packed-refs）から SHA を取る。取れなければ null
export function readGitMeta(root = repoRoot) {
  const meta = { gitSha: null, gitBranch: null };
  try {
    let gitDir = join(root, '.git');
    let commonDir = gitDir;
    if (existsSync(gitDir) && statSync(gitDir).isFile()) {
      // worktree: ".git" がファイルで "gitdir: <path>" と書かれている
      const line = readText(gitDir);
      const m = line && /^gitdir:\s*(.+)$/.exec(line);
      if (!m) return meta;
      gitDir = isAbsolute(m[1]) ? m[1] : resolve(root, m[1]);
      const common = readText(join(gitDir, 'commondir'));
      commonDir = common ? (isAbsolute(common) ? common : resolve(gitDir, common)) : gitDir;
    }
    const head = readText(join(gitDir, 'HEAD'));
    if (!head) return meta;
    const ref = /^ref:\s*(.+)$/.exec(head);
    if (!ref) {
      if (/^[0-9a-f]{40}$/i.test(head)) meta.gitSha = head; // detached HEAD
      return meta;
    }
    const refName = ref[1].trim();
    meta.gitBranch = refName.replace(/^refs\/heads\//, '');
    let sha = readText(join(commonDir, refName)) ?? readText(join(gitDir, refName));
    if (!sha) {
      const packed = readText(join(commonDir, 'packed-refs'));
      const line = packed?.split(/\r?\n/).find((l) => l.endsWith(` ${refName}`));
      sha = line ? line.split(' ')[0] : null;
    }
    if (sha && /^[0-9a-f]{40}$/i.test(sha)) meta.gitSha = sha;
  } catch {
    // 読めなければ null のまま（画面では「不明」と表示する）
  }
  return meta;
}

export default defineConfig(() => ({
  root: dashboardDir,
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
    fs: { allow: [dashboardDir, coreDir] },
  },
  preview: { host: '127.0.0.1', port: 4173 },
  define: {
    __RUNWAVE_META__: JSON.stringify({ ...readGitMeta(), builtAt: new Date().toISOString() }),
  },
  build: { outDir: 'dist', emptyOutDir: true },
}));
