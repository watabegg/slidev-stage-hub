# Slidev Lab

Slidevのバンドル共通化と、Rust / Tauriを第一候補にした発表アプリの実験用リポジトリ。

現在の機能・接続方法・保存先・検証範囲は [現行仕様](SPEC.md) にまとめている。

まず [PLAN.md](PLAN.md) を読み、[TODO.md](TODO.md) を更新しながら、小さなPoCで方法を比較する。
最初の到達点は、このPCでローカルの `slidev-theme-watabegg` を使って動くこと。

| 作業場所 | 目的 |
| --- | --- |
| [bundle-sharing/](bundle-sharing/) | 独立した複数資料の共通バンドル化・一覧閲覧 |
| [native-app/](native-app/) | Rust / WebViewによる発表操作・2画面表示 |

テーマのローカル参照先: `/home/watabegg/slidev-watabegg`。
採否と制約は [統合結果](results/integration.md)、独立再検証は [検証記録](results/verification.md) にまとめた。生成物・スクリーンショットはGit対象外の `artifacts/` にある。

共有版をこのPCで起動する（リポジトリ直下で実行）:

```sh
pnpm install --frozen-lockfile
node bundle-sharing/experiments/module-graph/build.mjs
node scripts/prepare-offline.mjs
node scripts/serve.mjs artifacts/module-graph-offline/site 4174
```

閲覧先は <http://127.0.0.1:4174/>。テーマ側のインストール済みSlidev 53.0.0を参照する。ネイティブ版の手順・実機制約は [native-app/README.md](native-app/README.md) を参照。

ホームは [frontend/Home.vue](frontend/Home.vue) でカスタムできる。fixturesの階層・公開用frontmatter・先頭ページPNGを標準で提供する。[カスタマイズ方法](frontend/README.md)、[実験結果](frontend/results/library.md) を参照。

資料別にSlidev・テーマを変える実験は [multi-profile](bundle-sharing/experiments/multi-profile/) にある。同じ互換グループ内でバンドルを共有し、異なるグループは文書とビルドを分離する。Nativeの文書維持・描画待ち切替の計測は [flicker.md](native-app/results/flicker.md) を参照。

NativeからHTTPS／別localhostの資料を開くPoCは [remote-player](native-app/results/remote-player.md) を参照。Web側は静的な資料APIと埋め込み連携コードを生成する。

MD更新時の再ビルドを避ける実験は [WorkersコンパイルPoC](bundle-sharing/experiments/workers/) にある。既存アプリとは分離し、workerdでの生成・版管理・サムネイル保存をローカルで検証している。
