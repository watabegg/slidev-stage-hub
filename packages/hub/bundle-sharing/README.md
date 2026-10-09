# バンドル共通化

4つのMarkdownを独立した資料として扱い、標準の個別ビルドと共通ランタイムの容量・読み込みを比較する。

## 基準ビルド

リポジトリ直下で `pnpm install --frozen-lockfile` を一度実行し、4資料を個別にビルドして計測する。

```sh
pnpm --filter @slidev-stage-hub/hub baseline
```

公開成果物は `packages/hub/bundle-sharing/artifacts/baseline/{aaa/aaa1,aaa/aaa2,bbb/bbb1,bbb/bbb2}/`、計測は `packages/hub/bundle-sharing/results/` に出力する。入力資料は `examples/fixtures/`、テーマは既定で `/home/watabegg/slidev-watabegg` を使い、`SLIDEV_THEME_PATH` で切り替えられる。

各資料は3ページ、クリック段階は `[0, 2, 0]`。`--without-notes` を使い、ビルド後に各資料の `PRIVATE_NOTE_<id>` が出力に残っていないことを確認する。
