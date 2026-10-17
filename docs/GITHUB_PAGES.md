# GitHub Pages で Web アプリを公開する

このリポジトリには、GitHub Pages 向けの Vite 設定を別ファイルとして用意しています。ローカル開発用の `vite.config.js` はそのままです。

## 公開されるページ

- Web シミュレーター: `https://<owner>.github.io/<repository>/web-simulator/`
- 開発ダッシュボード: `https://<owner>.github.io/<repository>/dev-dashboard/`

GitHub Actions は `main` への push または Actions の `workflow_dispatch` で両方をビルドし、同じ Pages サイトの別パスに配置します。ワークフローが `GITHUB_REPOSITORY` からリポジトリ名を取得し、Vite の `base` に反映します。手元で Pages 用ビルドだけ確認する場合は、各アプリのディレクトリで次を実行します。

```sh
npm ci
npm run build -- --config vite.config.pages.js
```

ローカルビルド時の base は `/sp_2601/<アプリ名>/` です。別のリポジトリ名を使うローカル確認では、`vite.config.pages.js` の `repositoryName()` のフォールバックを一時的に合わせてください。

## GitHub 側の設定

リポジトリの **Settings → Pages → Build and deployment → Source** を **GitHub Actions** に設定してください。`main` ブランチへの push 後、Actions の `Deploy web apps to GitHub Pages` が成功すると公開されます。

## API 接続

API の既定 URL は `https://sp2601.vercel.app` です。公開先ブラウザーから API を呼べるには、Vercel 側が Pages のオリジンからの CORS リクエストを許可している必要があります。許可設定と公開後の実通信は未確認です。
