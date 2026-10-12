# Slidock Worker

`src/` は Edge コンパイラ・R2・Durable Objects、`runtime/` はブラウザ、`scripts/` は Node のビルド・検証です。

ルートで `pnpm build:workers` → `pnpm dev:workers`。検証は `pnpm verify:workers`、Slive との実機接続は Linux SDK と画面のある環境で `pnpm verify:workers-slive`。

公開 CLI、認証、互換性、ローカルサンプルは [Workers ガイド](../../docs/guides/workers.md) を参照してください。これらの検証コマンドはクラウドへデプロイしません。
