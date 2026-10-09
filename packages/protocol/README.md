# Shared protocol

`src/contracts/` はCatalog・Discovery v1/v2・iframe bridgeの型とバリデータを提供する。公開入口は `@slidev-stage-hub/protocol` と `/contracts`。NodeやSlidevの実行時依存を持たない。

`pnpm build:packages` でESM契約とclassic bridge（`dist/deck-bridge.js`、`/bridge`）を生成する。`/build` はNode専用のビルドツール。Stageの私有型は `apps/stage/src/types/`、資料解析とmanifest生成は `@slidev-stage-hub/slidev-adapter` に移動した。

検証はルートの `pnpm test:contracts`。詳細は [開発ガイド](../../docs/DEVELOPMENT.md) を参照。
