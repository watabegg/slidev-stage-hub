# Hub の実装規約

- Node ビルドは `src/node/`、ブラウザーの取得・表示は `src/client/` と `src/frontend/` に置き、責務を混ぜない。
- ブラウザー向けコードから Node 組み込み API を参照しない。Slidev 固有処理は`packages/slidev-adapter/` の境界を越えて無断で広げない。
- カタログ、オフライン成果物、サムネイルの変更では既存の出力と検証手順を保ち、未実測の互換性や性能を主張しない。
- ルートから Hub の型・テストは `pnpm --filter @slidev-stage-hub/hub typecheck` と `test`、ブラウザー確認は `pnpm verify:hub` を使う。

- ブラウザーの取得処理は `src/client/`、Vue 表示は `src/frontend/`。frontend から client は公開 export を参照し、src/dist の二重読み込みによるエラー型の分裂を防ぐ。CSS は明示 import とし、公開 frontend の import だけでは mount しない。
