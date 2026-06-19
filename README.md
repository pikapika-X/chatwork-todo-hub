# Chatwork TODO Hub (static + Worker)

Chatwork のタスクを一覧・整理するダッシュボード。

- **フロント** … `index.html` ほか静的ファイル。GitHub Pages で配信（Google ログイン不要・どのブラウザでも同じに動く）。
- **バックエンド** … `worker/worker.js`（Cloudflare Worker）。Chatwork API のプロキシ + 設定同期(KV)。

ユーザーは自分の Chatwork API トークンを貼るだけ。トークンは保存しない（保存キーは SHA-256 ダイジェスト）。

## デプロイ手順

### 1. Cloudflare Worker
```
cd worker
npx wrangler login                       # ブラウザで Cloudflare にログイン
npx wrangler kv namespace create SETTINGS # 出力された id を wrangler.toml に記入
npx wrangler deploy                       # → https://chatwork-todo-hub.<sub>.workers.dev
```

### 2. フロント
`index.html` の `WORKER_URL`（`___WORKER_URL___`）を、上で出た Worker の URL に置換。

### 3. GitHub Pages
リポジトリにこのフォルダを push し、Settings → Pages → Branch: main / root を有効化。
公開URL（`https://<user>.github.io/<repo>/`）を配布する。
