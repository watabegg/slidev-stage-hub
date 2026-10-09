# 複数テーマ・Slidevバージョンのローカル実験

CLI/clientの正確な組、テーマの内容、setup roots、コンパイル設定が一致する資料だけを同じグラフで作る。互換グループごとに子プロセスを起動し、Vite自身が `/_profiles/<group>/` のURLを出力する。hash付きJS/CSSの書き換えや、異なるグループ間の共有は行わない。

設定例は [config.json](config.json)。`fixturesRoot`、各profileの `dependencyRoot` / `theme` は設定ファイルからの相対パス、または絶対パス。`decks` は探索された全IDからprofile名への対応。設定なしの場合は従来の4資料ビルドを維持する。

リポジトリのルートから実行する。

```sh
node bundle-sharing/experiments/multi-profile/scripts/prepare.mjs
node bundle-sharing/experiments/multi-profile/scripts/compare.mjs
node bundle-sharing/experiments/multi-profile/scripts/browser.mjs
node bundle-sharing/experiments/multi-profile/scripts/broken-co-load.mjs
```

任意の設定を使う場合は `SLIDEV_LAB_CONFIG=<JSONのパス> SLIDEV_LAB_ARTIFACT_NAME=<出力名> node bundle-sharing/experiments/module-graph/build.mjs`。出力は `artifacts/<出力名>/site`。公開manifest/catalogの各資料には `runtimeVersion`、`theme`、`profile` が付き、資料URLは引き続き `/<id>/1` になる。

検証した組は52.15.2と53.0.0のみ。52は既存のローカルテーマのpnpm storeを読み取り、`artifacts/dependencies/slidev52` に参照を作る。`store-provenance.json` に元パス・package hash・元lock hashを残す。これは移植可能なインストーラーではない。既存のwatabeggテーマは読み取り専用で、52の試験には合成テーマを使う。

資料側のsetup/components/layouts/styles、Vite/Uno設定、addonsはこのPoCでは明示的に拒否する。共有の拡張は宣言したテーマに置く。通常のブラウザではテーマのキー処理を維持し、ネイティブの既知キーはRust側の入力処理が優先する。

結果は [results/experiment.md](results/experiment.md)。
