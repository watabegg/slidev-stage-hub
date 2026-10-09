# Slidev adapter

Node専用のSlidev依存境界。`/inspect-deck`、`/native-manifest`、`/runtime`、`/static-runtime` を公開し、ブラウザーやWorker runtimeからは使用しない。

CLI/clientの対応組み合わせは52.15.2と53.0.0。ルートの `pnpm build:packages` で生成し、`pnpm test:contracts` でパーサー・ノートのUTF-8位置・ソースパッチを検証する。詳細は [開発ガイド](../../docs/DEVELOPMENT.md) を参照。
