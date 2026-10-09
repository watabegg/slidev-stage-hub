> 初回PoC時点の記録。named slotsの追加対応など、その後の変更は [追加実験](expansion.md) を参照。

# 目的

Markdown と小規模な画像アセットの追加・更新ごとに Web サイト全体を再ビルド・再デプロイせず、事前ビルド済みテーマを再利用して差分反映を高速化する。コンテナ環境の維持や閲覧ブラウザでのコンパイル負荷を排除し、Worker 上で変換処理を完結させる構成の成立性を検証した。検証対象はローカルの workerd 実行（実装場所: `bundle-sharing/experiments/workers`）であり、Cloudflare 実環境へのデプロイは行っていない。

# 構成

事前ビルドした共通ランタイム、Worker 内のオンデマンドコンパイラ、世代管理、サムネイル生成で構成する。

- **ランタイム共有**: Slidev v53 とローカルの watabegg テーマを Vite で1回事前ビルドし、Vue は runtime-only 構成とした。動的資料は公開 ESM（`/_runtime/vue.js`、`/_runtime/bridge.js`）を通じて同一ランタイムを参照する。テーマは固定プロファイルの読み取り専用であり、新テーマや新コンポーネントの追加、Slidev 本体の更新にはランタイムの再ビルドを要する。
- **Worker コンパイラと保存**: Worker 内に `@slidev/parser`、`markdown-exit`、Vue SFC compiler、UnoCSS を組み込み、コンパイル処理を Worker 側へ集約した。生成したページ ESM、CSS、manifest はローカル R2 に保存する。1資料あたり最大100ページかつ 512KiB まで、アセットは SVG、TXT、CSS の文字列のみ受け付ける。任意スクリプト、src include、named slots、Mermaid、Monaco、Twoslash、Magic Move 等は非対応として拒否し、通常コードブロックは未ハイライトで警告するため、Slidev 完全互換ではない。
- **世代管理と更新制御**: Markdown、アセット、ランタイム/コンパイラプロファイルのハッシュから revision を算出する。Durable Objects で世代を比較して遅延した古い処理の公開を阻止し、URL で revision を固定して過去の資料を残す。ただし、この旧版保持動作が確認されているのは同一ランタイムプロファイル内に限られ、ランタイム再ビルドを跨いだ互換性は未検証かつ未保証である。同一入力は既存成果物を再利用する。更新トリガーは `publish.mjs` が POST するローカル専用 API のみで、R2 への直接アップロードを起点とする Event Notifications や Queues は未配線である。本番認証も未実装で、wrangler 設定は `LOCAL_MUTATIONS=false` のためデプロイ準備は完了していない。
- **サムネイル生成**: 2026-10-09 公式の Browser Run 料金（[Browser Rendering Pricing](https://developers.cloudflare.com/browser-run/pricing/)、Free は 10 browser minutes/day、同時3セッション、分数制で枚数保証なし）を踏まえ、Worker binding の `quickAction` スクリーンショットに対応した。1枚目のスライドを 1200x675 PNG として revision ごとに保存・再利用し、使用量として JSON で `usedMs`（内部で `X-Browser-Ms-Used` を取得）を返す。実クラウドの Browser Run は未実行で API 形状と異常系のみ単体テスト済みである。binding 未設定時は 503（explicit unavailable）を返す。代替として管理者 PC の Chrome で生成済みスライドを撮影・PUT 保存する `local-thumbnail.mjs` を用意した（閲覧ブラウザでのコンパイルではない）。

# 再現

前提条件としてローカルテーマの `node_modules` と `/usr/bin/google-chrome` が必要である。環境変数による代替はコマンドごとに異なり、`build-runtime.mjs` では `SLIDEV_LAB_THEME` と `SLIDEV_LAB_DEPENDENCY_ROOT`、`local-thumbnail.mjs` および `verify-thumbnail.mjs` では `SLIDEV_THEME_PATH` と `CHROMIUM_EXECUTABLE` を使用する。なお、統合検証の `verify.mjs` はローカルテーマパス `/home/watabegg/slidev-watabegg` を固定で前提とするが、Chrome 実行バイナリは `CHROMIUM_EXECUTABLE` で指定できる。Miniflare 5 alpha の変換 API で workerd を使用するため、Cloudflare アカウントは不要である。作業場所は `bundle-sharing/experiments/workers` とする。

| 順序 | 実行コマンド | 説明 |
| :--- | :--- | :--- |
| 1 | `pnpm install --frozen-lockfile` | 依存関係の厳格インストール |
| 2 | `pnpm build:runtime` | Slidev とテーマのランタイム事前ビルド |
| 3 | `pnpm test` | 単体テストの実行 |
| 4 | `pnpm verify` | 統合検証テストの実行 |
| 5 | `node benchmark.mjs` | コンパイル時間のベンチマーク計測 |
| 6 | `pnpm dev` | workerd サーバー起動（127.0.0.1:4180、別ターミナル） |
| 7 | `node publish.mjs http://127.0.0.1:4180 poc/demo fixtures/deck.md fixtures/assets.json` | スライド資料のローカル発行 |
| 8 | `node local-thumbnail.mjs http://127.0.0.1:4180 poc/demo` | ローカル Chrome によるサムネイル撮影と保存 |
| 9 | `node verify-thumbnail.mjs http://127.0.0.1:4180` | 生成サムネイルの整合性確認 |

実装過程では、Miniflare 5 の API 変更に伴う `modulesRoot` 指定漏れを修正した。また初回 Vite ビルド時に動的スライド用の公開 ESM 関数が tree-shaking で消滅したため、`preserveEntrySignatures: 'strict'` 設定と export 検証を追加した。さらに Slidev 画像 preload が URL 配列を要求する仕様に合わせて構造化 frontmatter から分離してマップし、Vue setup の予約名仕様で `$frontmatter` が未定義となる問題を `bindingMetadata` を用いたコード生成へ是正した。section レイアウト用の `slide.title` 保持も含め、ブラウザ上で回帰確認を完了している。

# 検証と制約

単体テスト21項目、workerd API と実 Chrome を組み合わせた統合テスト32項目がすべて通過した。確認項目は以下の通りである。

- スライド表現: cover、section、FigureGrid、テーマ Enter、v-click、UnoCSS、scoped CSS
- 運用・整合性: Markdown 更新、画像のみ更新、新規資料追加、旧版保持、失敗時の旧版保持、公開世代競合の抑止、閲覧ブラウザ側のコンパイラ不在、ランタイムファイルハッシュ不変

合成データ（見出し、リスト、v-click）によるローカル HTTP wall time の実測値は、5ページで 65ms、50ページで 128ms、100ページで 209ms、同一資料の再利用時は 5〜7ms であった（クラウドの CPU 時間ではない）。Worker サイズは esbuild 計測値で raw 2,209,827 bytes、gzip 492,999 bytes である（wrangler 出力とは異なる）。
実 Chrome による先頭ページ PNG（1200x675、253,647 bytes）の生成とローカル R2 保存を確認し、カタログ表示（catalogVisible: true）およびホームへの復帰（homeReturn: true）も検証した。所要時間は Chrome 起動・撮影・保存を含め初回 CLI 全体で 1288ms、キャッシュ利用の再検証時で 1028ms であった（Browser Run の課金時間ではない）。画像は目視でも確認している。ローカルパッケージングを確認する `wrangler deploy --dry-run` も成功した。検証結果の要約は git 管理対象の `results/measurements.json`（単体21件、統合32件、ベンチマーク、サムネイル結果）に記録し、詳細な証跡は git 対象外の `artifacts/workers/verification.json`、`benchmark.json`、`site/runtime-manifest.json`、PNG に保存した。

制約として、Cloudflare 実環境での CPU 時間、最大メモリ使用量、起動時間、課金影響、実 Browser Run による撮影は未検証である。HTTP wall 時間は CPU 時間ではないため、Workers Free 枠内でコンパイル可能とは保証しない。また、R2 イベント通知から Queue を経由した自動変換・サムネイル撮影のパイプライン化、既存 Web アプリ（Vue 製ホーム画面）との統合、Native protocol 接続は未実装である。既存システム本体は変更せず、分離した PoC として成立性を確認した段階にとどまる。

# 採否

コンパイル処理を Worker 側へ分離し、事前ビルド済みランタイムを共有するアーキテクチャ方式は有効と判断し、継続検証とする。次はリモート環境での CPU 時間とメモリ使用量を計測した上で、Queue 通知による変換パイプライン接続と許容 Slidev 構文の拡大を進める。
