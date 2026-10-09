# Hub の実装規約

- Node ビルド、ブラウザー UI、`bundle-sharing/experiments/` の実験コードの責務を混ぜない。実験コードを製品入口として扱わない。
- ブラウザー向けコードから Node 組み込み API を参照しない。Slidev 固有処理は計画中の adapter 境界を越えて無断で広げない。
- カタログ、オフライン成果物、サムネイルの変更では既存の出力と検証手順を保ち、未実測の互換性や性能を主張しない。
- ルートから Hub の型・テストは `pnpm --filter @slidev-stage-hub/hub typecheck` と `test`、ブラウザー確認は `pnpm verify:hub` を使う。

- ブラウザーの取得処理は `src/client/`、Vue 表示は `src/frontend/`。frontend から client は公開 export を参照し、src/dist の二重読み込みによるエラー型の分裂を防ぐ。CSS は明示 import とし、公開 frontend の import だけでは mount しない。
