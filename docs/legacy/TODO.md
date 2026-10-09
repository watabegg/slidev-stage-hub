# TodoList

進捗の正本。初期項目は [PLAN.md](PLAN.md) から抽出。実験結果に合わせて更新する。

- [x] 実行環境および依存バージョンの記録（`scripts/environment.mjs`、`artifacts/environment-before.json`）
- [x] 4つの検証用スライド作成と個別ビルドの基準値測定（`bundle-sharing/results/baseline.md`）
- [x] バンドル共有候補の比較測定（同期bootstrap採用、TLA・hardlink方式不採用）
- [x] 共有モジュールグラフによる独立ルーティングの構築（`artifacts/browser-shared-final/result.json`）
- [x] Tauriによるローカル描画と同一物理画面上の2ウィンドウ表示（条件付き、下記参照）
- [x] Rust側のクリック状態管理と発表者UI操作性の検証（実WebView 18項目、`native-app/artifacts/runtime-lead-final.json`）
- [x] 発表者ノートのローカル保存・Git差分およびオフライン成果物の検証（保存後mapping再読込、元ソース復元も確認）
- [x] 同一成果物を用いた統合検証レポート作成と引継ぎ（`results/integration.md`、`results/verification.md`。未検証事項は下記）

## 実験結果（2026-10-08）

- 今回の依頼により計画段階から実装・ローカル実験へ移行。外部公開、push、OS設定変更は対象外。
- Luna/max: 4資料・標準ビルド・計測スクリプト。
- GPT-6.1-sol/high: Tauri実機PoC、別agentで共有モジュールグラフの調査。
- Lead: 方針選定、統合、独立検証。テーマは読み取り専用。開始時の内容ハッシュを記録済み。
- 共有版: raw 30,287,165 → 7,626,672 bytes（74.82%削減）。別資料専用chunk取得0、次資料57リソースをキャッシュ再利用。比較画像12枚はpixel一致。
- 初期TLA版: Chromiumでは成功したがWebKitの3頁目で停止。同期bootstrapへ変更し解消。
- 標準個別ビルド: 表示・操作は成功するが画像先読み404が18件。共有アダプターで修正済み。
- Tauri: `NO_AT_BRIDGE=1` の条件で実描画・同期・保存を確認。Rust 6テスト合格。テーマソースの前後ハッシュ一致。

## 残る実機検証・制約

- [ ] 物理2画面、接続解除・再接続、高DPI（検出は1台1920×1080/scale1。配置APIの受理だけでは実移動を証明しない）
- [ ] AT-SPI有効時の起動クラッシュ解消、アクセシビリティ検証
- [ ] 聴講者ウィンドウの黒いsnapshot問題、iframe wake-lock拒否の解消（DOM同期と一部描画は確認）
- [ ] Windows/WebView2、Cloudflare公開、配布用署名・更新（今回対象外）
- [ ] ノートがないページへの新規追加、非協調的な外部writerとのrename直前の競合解消
- [x] offline加工後のJS/CSS参照をsnapshot hashで更新（4174の古いCSSキャッシュによる白画面を修正）
- Google Fontsの応答は取得ごとに変わり得る。offline容量は各snapshotの計測値であり固定値ではない。
- 最終offline版は基準画像と文字周辺にpixel差あり（機能・レイアウト確認済）。通常の共有版は12/12 pixel一致。fonts snapshotの固定は今後の課題。

## ブラウザの資料ライブラリ（追加依頼）

- [x] Vueで差し替え可能なホームとカテゴリ一覧
- [x] fixtures再帰探索・公開用frontmatter・先頭スライドPNGの標準出力
- [x] スライド常設ホームリンクと操作パネル内のホームリンク
- [x] ブラウザ実操作、埋め込み表示、既存スライドの回帰確認

- 追加結果：[ブラウザ資料ライブラリ](frontend/results/library.md)。ブラウザ15項目、catalog 7テスト、既存4資料回帰、Tauri実機18項目が合格。

## リポジトリ保存

- ユーザーの追加依頼により、GitHub `watabegg/slidev-lab` をprivateで作成してpushする。上記の「push対象外」は当初の実験範囲の記録。

## 資料別ランタイム・テーマ／Native描画（追加PoC）

- [x] 互換グループ単位のSlidev・テーマ分離と共有ビルド
- [x] 衝突するショートカット・CSS・同名資料を使った再現と隔離検証
- [x] 異なるSlidev実バージョンでの実描画と容量比較
- [x] Native再読込の基準計測、同一資料の文書維持、資料変更時の描画待ち切替
- [x] 連打・戻る・クリック・先読み・発表者ノートの回帰検証
- [x] 小さなローカル実験と実機確認、採否・制約の記録（ユーザー指定により正式レビュー・QA手順は使わない）

新依頼により固定テーマの当初制約を実験用テーマ・資料別profileへ拡張する。既存のローカルテーマ作業ツリーは引き続き変更しない。比較はローカルで行う。

- 8資料・4互換グループでraw48.43%／gzip48.02%削減（個別8グラフ比）。52.15.2と53.0.0、衝突する2テーマで確認。
- Nativeの同一資料4操作は再読込4→0、空DOMフレーム30→0（Chromium実験）。実WebKitの既存18項目・混在profile24項目合格。今回の聴講者snapshotは正常。AT-SPI条件・物理2画面などの制約は継続。
- 再現手順・採否：[互換グループ実験](bundle-sharing/experiments/multi-profile/results/experiment.md)、[Nativeちらつき実験](native-app/results/flicker.md)。既存ホーム15項目、旧4資料の回帰、ソース元テーマのハッシュ一致も確認。

## 4174の白画面修正

- [x] 実ブラウザの古いCSSと削除済みfont CSSの不整合を特定、参照URL変更で利用者の復旧を確認
- [x] offline加工後のsnapshot fingerprintと起動失敗時の復帰UIを追加
- [x] キャッシュを保持した更新の再現／修正テスト、hash処理4テスト、ライブラリ15項目を確認
- 記録：[offline cache](frontend/results/offline-cache.md)。診断サーバーを撤去し、4174は修正版の通常配信へ復帰。

## VueのTypeScript移行

- [x] Home.vueをscript setup lang="ts"へ移行し、catalog／frontmatter／カテゴリの型を定義
- [x] frontendの起動・ナビゲーション・起動エラー処理を.tsへ移行し、共有ビルドの参照を更新
- [x] pnpm typecheck（strict＋Vueテンプレート）、共有ビルド、ブラウザ15項目を確認
- 記録：[TypeScript移行](frontend/results/typescript.md)。Nativeの素のJavaScriptとNodeの実験スクリプトは今回のVue移行対象外。

## ホスティング済みURL・別localhostへのNative接続PoC

- [x] Webビルドに静的native-player.jsonと埋め込み時のみ有効な連携コードを追加
- [x] HTTPS／HTTP loopbackへの接続設定、資料検証、リモート時のノート編集無効化
- [x] HTTP・HTTPSのブラウザ検証（固定テーマ各31項目／混在profile各47項目）
- [x] 実TauriでHTTP固定17項目、HTTP混在33項目、localhost証明書限定許可でHTTPS混在33項目を確認
- [x] 従来ローカル配信の実Tauri18項目・通常Web15項目の回帰確認。接続設定は元のローカル方式へ復元
- [ ] 公開HTTPSホストの信頼済み証明書での実機検証（今回は手元で検証する指定）
- 記録：[Remote player](native-app/results/remote-player.md)。静的サイトのルートURLのみ。リモート元Markdownへのノート保存や認証付きホストは対象外。

## 外部接続のローカルノート・汎用認証ヘッダー

- [x] 元のorigin＋資料パス＋ページ番号に対応する端末内JSONノート、再起動・資料版変更時の保持
- [x] origin指定の私有ヘッダーファイルとNativeの読み取り専用proxy（Bearer／CF Access形式のヘッダーを模擬）
- [x] HTTP認証36項目、再起動36項目、版変更警告37項目、HTTPS認証36項目、認証なし外部36項目、従来ローカル18項目の実WebKit確認
- [x] Rust core13＋認証13テスト、Node接続・認証18テスト
- [ ] 実Cloudflare Access Service Authでの公開HTTPS検証（実アカウント・資格情報は未使用）
- 記録：[認証とローカルノート](native-app/results/auth-notes.md)。証明書CA指定によるHTTPS失敗と修正も記録。対話的SSO・mTLS・トークン自動更新は未対応。

## 現行仕様の整理

- [x] Web・共有ビルド・Native・ノート・認証・起動手順・検証範囲を [SPEC.md](SPEC.md) に統合（2026-10-09時点の作業ツリー）
- [x] READMEから仕様書へのリンクを追加

## R2へのMarkdownアップロードによる自動公開の調査

- [x] 現行の静的import生成、Slidevコンパイル、R2通知・Queues・生成環境を調査し、[方式比較と版管理案](bundle-sharing/results/dynamic-publishing.md) を記録
- 調査のみ。実装・PoC・ビルド・デプロイ・性能計測は未実施。推奨はアップロード時のサーバー側生成と版別配信。まずグループビルドの自動化、その後に共通ランタイムと資料単位の生成の分離を検証する案。
- [x] 追加希望「Containerとブラウザ変換を避ける」を受け、[Workersでの変換処理の分離](bundle-sharing/results/workers-compilation.md) を調査。第一候補をWorkersによる資料コンパイルへ変更。Vueの動的評価経路、Slidevの内部変換、共通ランタイム参照、別途必要なサムネイル撮影を確認。Workers上の実行・性能・完全互換は未検証。

## WorkersコンパイルのローカルPoC

- [x] workerdでMarkdown→Vue ESM／UnoCSS生成、R2保存・版更新を検証
- [x] 事前ビルドした実テーマ／Slidevランタイムへの接続とブラウザ表示・クリックを確認
- [x] Browser Run無料枠とサムネイル撮影経路を確認し、利用不能時の代替を用意
- [x] 再現コマンド・測定結果・失敗・対応範囲をresultsに記録（公開デプロイは別作業）

- 記録：[Workers PoC結果](bundle-sharing/experiments/workers/results/poc.md)。単体21件・workerd/Chrome統合32件が通過。先頭PNG生成・一覧表示・保存画像再利用を確認。Browser Runは無料10分/日を確認しbinding経路を用意したが、実クラウド撮影は未実施。R2通知/Queues接続・既存Web/Nativeへの統合は今後。

## Workers PoCの追加実験

- [x] 既存4資料＋テーマexampleと構文20ケースで互換性を分類
- [x] コード中のVue式の誤評価を修正、named slotsを追加、未対応数式に警告
- [x] 同時更新・再送・24資料・再起動・同名画像の分離を検証
- [x] 2タブの非干渉・CSS遅延/失敗・旧新版を検証し、読み込み失敗時の復帰UIを追加
- [x] サムネイルの遅延・壊れ画像・不正PNG・版固定・再PUTを検証し、壊れ画像の成功扱いを修正
- [x] 4資料の先頭2ページを実workerd/Chromeで確認（全文はMermaidが未対応）
- [x] 追加実験の記録・再現手順をresultsへ保存

- 記録：[追加実験結果](bundle-sharing/experiments/workers/results/expansion.md)。単体27件＋統合85項目、構文20ケース、全文5資料の対応限界とサムネイル異常系を確認。実クラウド未検証。


## Workers PoCの実Cloudflare検証

- [x] 専用Worker／R2／SQLite DO／Browser Run／Assetsを作成し、HTTPSへデプロイ
- [x] 更新APIのBearer認証、公開閲覧、Markdown版更新・旧版保持を確認
- [x] 5／50／100ページを実測し、R2保存を6件並列化（100ページ約61秒→14秒）
- [x] Browser RunのPNGサイズ不一致を固定viewport撮影へ変更し、実クラウドで再確認
- [ ] R2直接アップロードのイベント処理・Queues接続、既存Web／Nativeへの統合

- 記録：[実Cloudflare検証](bundle-sharing/experiments/workers/results/cloud.md)。公開先は https://slidev-lab-poc.watabegg.workers.dev 。無料枠での稼働保証・課金額・高負荷性能は未確認。

## Native UIのTypeScript移行

- [x] UI・frame controller・注入bridge・実機QAの4本をstrict TypeScriptへ移行
- [x] Cargo desktopビルドへの型チェック・JS生成の自動組み込み
- [x] 型エラーでのCargo停止、変更なし再ビルド、実Tauri18項目・外部HTTP/HTTPS各31項目を確認
- 記録：[Native TypeScript](native-app/results/typescript.md)。変換は約1.16秒、変更なしのCargo buildは約0.221秒。Nodeの補助スクリプトはmjsを維持。
