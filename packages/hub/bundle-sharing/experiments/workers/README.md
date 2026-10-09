# Workersでの資料生成PoC

現在の既定ランタイムは公式defaultテーマです。開発環境は [開発ガイド](../../../../../docs/DEVELOPMENT.md) を参照。以下のresultsは過去のwatabegg固定ランタイムによる記録を含みます。

実クラウドの公開先・測定結果・再現手順は [Cloudflare検証](results/cloud.md) を参照。

対応構文・失敗例は [追加実験](results/expansion.md)、初回の構成と手順は [初回PoC](results/poc.md) を参照。

```sh
pnpm install --frozen-lockfile
pnpm build:runtime
pnpm test
pnpm verify
pnpm dev
```

別ターミナルで同じディレクトリから実行：

```sh
node publish.mjs http://127.0.0.1:4180 poc/demo fixtures/deck.md fixtures/assets.json
node local-thumbnail.mjs http://127.0.0.1:4180 poc/demo
node verify-thumbnail.mjs http://127.0.0.1:4180
```

閲覧: <http://127.0.0.1:4180/>。`wrangler.jsonc` は本番デプロイ用の完成設定ではない。

追加検証（各スクリプトは独立したローカル環境で実行）：

```sh
pnpm verify:stress
pnpm verify:browser
pnpm verify:fixtures
pnpm verify:compatibility
pnpm verify:thumbnail
```

`pnpm dev` 起動後、別端末で `pnpm demo` を実行すると5資料とサムネイルを用意する。既存4資料は、未対応のMermaidを含む3ページ目を除いた先頭2ページ版。
