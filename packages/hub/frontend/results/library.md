# ブラウザ資料ライブラリ — 2026-10-08

- 仮説：fixturesの階層と公開用メタデータをビルド時に集めれば、Slidev本体を起動せずVueでホームをカスタムできる。
- 採用：`frontend/Home.vue`、`catalog.json`、実描画の先頭ページPNG。常設リンクとテーマ既存の操作パネルリンクを併用。iframeでは両方を隠す。
- 再現：`node bundle-sharing/experiments/module-graph/build.mjs` → `node scripts/verify-library.mjs`。
- 計測：4資料、ビルド7,116ms（PNG生成込み）、raw 8,604,736 bytes、gzip 3,848,546 bytes、235 files。この実行の値。
- 検証：catalog 7テスト、ブラウザ15項目合格。デスクトップ・スマホ画像は `artifacts/browser-library/`。ホームの依存先にSlidev/client・資料モジュールなし。
- 回帰：外部通信を遮断した既存4資料テスト合格（`artifacts/browser-library-regression/result.json`）。Tauri実機18項目合格、ノート元ソース復元（`native-app/artifacts/runtime-library.json`）。テーマの開始時ハッシュ一致。
- 追加実験：root `slides.md`、`a.md` と `a/b.md`、日本語・空白・ドットを含む名前でビルド／PNG生成成功。初回に親子IDのprefix衝突を検出し、最長一致へ修正。資料ID重複・空のfixturesはエラー。
- 制約：Tauriは引き続き `NO_AT_BRIDGE=1` が必要。AT-SPI有効時の停止点は `libatk-bridge`、根本原因は未確定。PNG生成はChromiumとフォント取得環境に依存する。
- 次の実験：フォントsnapshot固定とサムネイルの差分再生成。Windows・物理2画面は未検証。
