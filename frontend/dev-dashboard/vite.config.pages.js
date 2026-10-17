// GitHub Pages 用。既存のローカル開発設定を引き継ぎ、プロジェクトサイトの base だけを追加する。
import { defineConfig, mergeConfig } from 'vite';
import localConfig from './vite.config.js';

function repositoryName() {
  // GitHub Actions では owner/repository が設定される。ローカル確認時は sp_2601 を使う。
  const repository = process.env.GITHUB_REPOSITORY?.split('/').at(-1);
  return repository || 'sp_2601';
}

export default defineConfig(() => mergeConfig(localConfig(), {
  base: `/${repositoryName()}/dev-dashboard/`,
}));
