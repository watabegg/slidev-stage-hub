# 同一モジュールグラフ実験

```sh
node bundle-sharing/experiments/module-graph/build.mjs
node bundle-sharing/experiments/module-graph/serve.mjs
CHROMIUM_EXECUTABLE=/usr/bin/google-chrome node bundle-sharing/scripts/browser-experiment.mjs http://127.0.0.1:4310 artifacts/module-graph/browser
node bundle-sharing/experiments/module-graph/inspect.mjs artifacts/module-graph/browser/result.json
```

出力はリポジトリ直下の `artifacts/module-graph/site/`。serve は別ターミナルで起動する。サーバーは `http://127.0.0.1:4310` で site 全体を配信し、deck パスを `index.html` にフォールバックする。
依存の既定参照先は読み取り専用のローカルテーマ。比較環境を揃える場合は `SLIDEV_LAB_DEPENDENCY_ROOT=/home/watabegg/slidev-stage-hub` を指定する。テーマ参照先は `SLIDEV_LAB_THEME` で変更できる。

`manifest.json` は schemaVersion 1。`commonAssets` は共有ファイル、各 deck の `assets` はその資料の JS・CSS・画像（すべて site からの相対パス）。`runtimeVersion` は 53.0.0、`entry` は `/aaa/aaa1/1` 等の閲覧 URL。`revision` は公開用にノートを除いた内容・frontmatter の SHA256、`sourcePath` は元資料のリポジトリ相対パスである。

deck ごとの Markdown は結合しない。URL から configs と slides を動的 import し、読み込み結果を同期参照する facade に渡してから標準の Slidev client を起動する。生成モジュールに top-level await を残さない。deck 間移動は文書単位の navigation とし、同じ client/theme ファイルを HTTP キャッシュで再利用する。ページ送り・クリック・テーマの layout/component/setup は標準実装を通す。同期チャンネルはタイトルではなく deck ID を使う。

Slidev 53.0.0 の内部 plugin 名・仮想 ID に依存する実験である。CLI/client バージョンとパッチ対象の文字列を確認し、合わなければ停止する。build target は esnext。資料固有の component/setup、異なる compile-time feature 設定、SEO metadata、Windows は未検証。HTML コメントも公開資料から除去する。CSS は標準の minifier を使用する。WebKitGTK 2.52.6 はフォントをローカル化した複製で確認した。

`SLIDEV_LAB_BOOTSTRAP=tla` は WebKit で3ページ目が表示されなかった旧方式を再現し、既定で `artifacts/module-graph-tla/site/` に出力する。実験を別ディレクトリへ保存するには `SLIDEV_LAB_ARTIFACT_NAME` を指定する（serve/inspect にも同じ値を指定）。フォントのオフライン化は lead の postprocessor で複製側に行う。
