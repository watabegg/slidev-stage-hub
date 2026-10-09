> Step 7 までの履歴資料です。文中のパス・コマンドは記録当時のものです。現在の入口は [HANDOFF](../HANDOFF.md) を参照してください。

# 開発引き継ぎ書 (docs/HANDOFF.md)

> 本文は移植時点の記録です。以後の環境依存解消・公式defaultテーマへの切り替え・watabegg 1.2.1 exampleは [開発ガイド](DEVELOPMENT.md) と [最新の検証記録](results/portability.json) を参照してください。ローカルテーマ必須という本文中の前提は解消済みです。

## 現行実装の補足

- Workers の現行コードは `apps/hub-worker/`。旧配置は履歴用の README・results のみです。
- `hub publish`、共通カタログ、native-player v2 の接続手順は [Workers ガイド](guides/workers.md) を参照してください。
- Step 7 の進捗は [進捗台帳](plans/productization-todo.md) を正本とします。

## 目的と引き継ぎの前提

- **目的**: 本書は、過去のチャットログを参照せずに新しい担当エージェントが自律的に開発を再開できるようにするための引き継ぎ資料である。READMEのような概要紹介ではなく、開発再開に必要な現状、未完了事項、再現コマンド、意思決定理由を明記する。
- **検証結果の正本**: 実測や動作確認の最新正本は [migration/verification.json](migration/verification.json)（作成済み、status: passed）である。ローカル環境での依存解決、型チェック、単体テスト（Node 62件、Rust core/auth 26件）、Hub（ビルド、サムネイル4件、ブラウザ15件）、Workers（ビルド、workerd/Chrome 32件）、Stage（ビルド147秒、4資料準備、WebKit/HTTP/HTTPS 80件）の合格が記録されている。一方、Windows環境、物理2画面、実際のCloudflare Access、新リポジトリからのクラウドデプロイ、独立環境での配布は未検証である。各検証の詳細は同ファイルを参照すること。
- **作業ディレクトリ**: 新作業ディレクトリは `/home/watabegg/slidev-stage-hub` である。旧作業ディレクトリ `/home/watabegg/slidev-lab` は参照用として保存する。今回の作業目的はソースコードの移植と引き継ぎ環境の確立であり、本番運用に向けた品質完成宣言ではない。

## プロジェクト方針と開発体制

- **製品化の方針**: 旧PoC実装を基盤として、独立したSlidev周辺製品を正式に開発する。
  - デスクトップ環境向けネイティブ再生・発表製品: **Slidev Stage**
  - 複数資料の配信・閲覧ウェブ基盤: **Slidev Hub**
  - 単一リポジトリ（モノレポ）で開発を進め、将来的に別製品として独立配布することを目指す。
- **未決定・未完了事項**: 製品名および配布用パッケージ名の利用可能性（空き状況）の確認、正式なソフトウェアライセンスの選定は未完了である。
- **開発方針と役割分担**:
  - 許可された範囲内での自走を基本とし、非自明な実装を行う場合は必ず根拠を確認する。過剰設計を避け、実際に動く検証を優先する。
  - Luna等の独立エージェントに個別の調査や実装を任せ、リード担当が判断・統合・評価を行う。ユーザー指定によりcodex-implの重い確認フローは不要とする。
  - 長文ドキュメントはagy-writerを活用して内容の妥当性と整合性を確認する。

## 移行状況と履歴の境界

- **ソースコードの由来**: 旧リポジトリのコミット `543fc50`（origin/mainへpush済み）をベースとし、その後に実施されたNative TypeScript移行に伴う未コミット差分も新リポジトリへ取り込んだ。旧リポジトリ側の差分はそのまま残されている。
- **Git管理方針**: 新リポジトリはローカルの `main` ブランチに作成された初期コミットを開始点として開発を進め、旧リポジトリのGitコミット履歴は取り込まない。また、GitHub remoteは作成・設定せず、外部へのpushや一般公開は行わない。
- **移行記録と過去資産**:
  - ソースの由来は [migration/source.json](migration/source.json)、ファイル移動の対応関係は [migration/file-map.json](migration/file-map.json) に記録されている。
  - 過去の計画書、仕様書、タスク一覧、README、および全体実験結果は [legacy/](legacy/) に保持されている。各パッケージ内の過去の失敗結果を含む実験記録もそのまま維持している。
  - 過去ドキュメント内の絶対パスやコマンドは旧配置のものであるため、現行リポジトリのREADMEを優先して参照すること。
- **移植対象外の資産**:
  - 依存パッケージ、SDK、ビルド成果物、認証情報、トークン、targetディレクトリ、Gitメタデータはソース移植対象外である。
  - 当該PC環境での検証に必要なSDKのみ、新Stageの無視対象ディレクトリ（ignored artifacts）へコピーした。
  - 認証トークン、ユーザー作成ノート、個人設定（config）は移植していない。

## 構成とコンポーネント境界

- [../apps/stage](../apps/stage)（旧native-app）:
  - RustコアおよびTauri 2で構成され、UIは厳格なTypeScript（strict TS）による3系統（`app`, `frame-controller`, `qa`）を持つCargoワークスペースである。
  - `src-tauri/build.rs` はデスクトップビルド時のみTypeScriptのUIをビルドしてdistを同梱する。ルートにはCargo.tomlが存在しないため単体の `cargo run` は実行できず、通常起動時はルートから `NO_AT_BRIDGE=1 pnpm stage`（`desktop-env` を読み込み `--features desktop` を付与して実行）を使用する。UI単体ビルド時は `pnpm build:stage-ui` を使用する。
  - Rustのクレート名（`slidev-native-core`, `slidev-native-poc`）およびbundle identifier（`local.slidev.lab`）は移植時にも維持している。名称やデータ保存領域の変更は、既存ノートの移行を考慮して後日判断する。
- [../packages/hub](../packages/hub)（旧Webフロントエンド）:
  - Vue 3 / TypeScript、配信スクリプト、共有バンドル実験コードを移植した。
  - 既存のmodule-graphビルド、マルチプロファイル、Workers実験は内部ディレクトリ構造を維持している（将来の整理対象）。
  - 資料別テーマおよびSlidev互換グループごとにランタイムを共有する。CLIの製品向け公開APIは未固定である。
- [../packages/protocol](../packages/protocol):
  - `native-player.json` マニフェスト生成機能を提供する。
  - 資料ソース解析（`inspectDeckSource`: スライド総数、単純なv-click解析、私有ノート位置の特定）を担当する。
  - 共通のブリッジスクリプト（`deck-bridge.ts`）および型定義（`globals.d.ts`）を提供する。StageとHubの双方が参照することで、HubがStageの内部実装に依存することを排除している。
  - protocolのビルド時にブリッジ成果物をdistへ生成し、Stage側へもコピーして配置する。
- [../examples/fixtures](../examples/fixtures):
  - 共通の検証用4資料を配置している。
  - Hubが出力する `manifest.sourcePath` は `packages/hub` を基点として解決されるが、Stage側が許可する承認済みソースルートは既定で `examples/fixtures`（`--fixtures-root` で変更可能）であり、指定された境界外を参照するパスは拒否される。
- [../examples/legacy-native-baseline](../examples/legacy-native-baseline):
  - 旧コミット `3d8c6a6` におけるページリロード型実装（4ファイル）。
  - 画面遷移時のちらつき防止効果を比較するための専用コードであり、現行の製品コードではない。新リポジトリに旧Git履歴がなくても動作比較ができるように保持している。
- **ツールチェーンとルート環境**:
  - ルートのpnpmワークスペースは5プロジェクト（root, Stage, Hub, protocol, nested Workers）で構成し、単一のlockfileで管理する。
  - 主要バージョン: pnpm 12.3.4, TypeScript 6.0.3, Vue 3.5.43, vue-tsc 3.3.12。
  - Workers環境: `@slidev/parser` 53.0.0, Vue compiler, UnoCSS, wrangler等は既存のピン留めバージョンを維持している。
  - すべてのパッケージは `private: true` と設定されており、現時点でnpm等への外部公開は行わない。

## 現行機能と動作境界

- **Slidev Hub**:
  - Vue製のカスタムホーム画面を提供し、ディレクトリ構造に基づくカテゴリ分類、frontmatterのタイトル表示、先頭スライドのサムネイル、一覧への戻る導線、独立した各資料URLを備える。
  - 互換グループ単位でのランタイム共有、オフライン利用を想定したアセットおよびフォントのローカル化、コンテンツフィンガープリントによるキャッシュ無効化を実装している。
  - 複数テーマ、およびSlidev 52と53の共存に関する実験記録を保持している。
- **Slidev Stage**:
  - Rustコアを状態の正本とし、発表者ウィンドウと聴衆ウィンドウの2画面同期、入力イベントの重複排除を行う。
  - 同一資料内のページ遷移はDOMドキュメントを保持したルーター移動で行い、別資料への切り替え時は予備iframeに描画した後に差し替えることで画面のちらつきを抑制する。
  - 発表者ノートの編集・競合検知、タイマー表示、画面暗転、次ページプレビュー、外部ディスプレイ制御を備える。
- **発表者ノートの保存仕様**:
  - ローカル資料: 承認済みソース内の既存HTMLコメントを直接編集・更新する。
  - 外部接続時（HTTPS / HTTP loopback）: 接続元オリジン、資料パス、ページ番号をキーとして、端末内のローカルストレージ（サイドカーJSON）に保存する。資料の更新時は差分警告を表示し、元ホストへはノートを送信しない。
- **外部接続と認証の制約**:
  - 接続対象は、ルートに `/native-player.json`（schemaVersion 1 / protocolVersion 1）を配置し、opt-in bridgeを組み込んだサイトに限定される。任意の素のSlidevサイトへ無条件に接続する機能ではない。
  - 認証は `--headers-file` にオリジン指定の非公開JSON（Unix権限0600）を渡す方式を採用。Rustプロキシが同一オリジン宛てのGET/HEADリクエストにのみBearerやCloudflare Access形式のヘッダーを付与する。認証トークンはWebView内のJavaScriptへは渡さない。
  - 対話的SSO、mTLS、トークンの自動更新には未対応である。また、実際のCloudflare Access環境での実機検証は未実施である。

## Workers実験環境の仕様と制約

- **アーキテクチャ構成**:
  - [../packages/hub/bundle-sharing/experiments/workers](../packages/hub/bundle-sharing/experiments/workers) で管理されている。
  - Cloudflare Workers / workerd 上でMarkdownをVue ESMおよびUnoCSSへ変換する。
  - 不変リビジョンをCloudflare R2に格納し、SQLite Durable Objectsで最新リビジョン番号を管理する。
  - 事前ビルド済みのSlidev 53および固定ランタイム（watabegg）を配信するため、ブラウザ側での動的変換やコンテナ実行を必要としない。
- **旧クラウド環境との関係**:
  - 旧PoC環境（URL: `https://slidev-lab-poc.watabegg.workers.dev`、Worker名: `slidev-lab-poc`、R2バケット: `slidev-lab-poc-20261009`）は、ユーザーのアカウント（watabegg@gmail.com）で専用作成されたものであり、既存契約の変更はない。
  - 新リポジトリからのデプロイは未実施である。
  - 更新APIは専用Bearerトークンで保護され、閲覧（GET）は公開設定である。トークン値は旧リポジトリの `artifacts/workers/publish-token` および `cloud-secrets.json` にのみ存在し、新リポジトリには移行せず、ログ等にも印字しない。
  - リポジトリ内の `cloud-config.mjs` および `wrangler.cloud.json` は旧専用環境の設定を引き継いだものであり、新しい本番環境の設定ではない。
- **性能実測値と無料枠の検証状況**:
  - 旧環境での実測値: 100ページの変換において、6並列R2保存により処理時間を61.065秒から14.018秒へ短縮（変換後CPU時間178ms）。
  - Browser Runによる先頭スライドPNG（1200x675）の撮影時間は新規撮影時で約9.5秒（初回リビジョン）および約7.2秒（更新リビジョン）であり、同一リビジョンの画像再利用は別のキャッシュ検証で確認されている。
  - Browser Runのスクリーンショット応答メタデータにおいて `usedMs` がnull値であったため、Browser Runの利用時間や無料枠消費状況は未確認である（WorkerのCPU時間は178msと実測済み）。単に実行が成功したことのみをもって、Workers Free枠やBrowser Rendering無料枠への適合を保証しない。
- **統合状況と非対応仕様**:
  - Workers実験コードは既存のHubおよびStageとはまだ統合されていない。
  - R2へのMarkdown配置を検知して自動変換する仕組み（R2イベントやQueues）は未実装であり、現在は公開APIへのPOSTリクエストでのみ変換を行う。
  - 構文の互換性: 完全なSlidev互換性はない。Mermaid図、素のVueテンプレート、include構文、資料固有スクリプト等を含む資料は明示的に変換を拒否する。一方で、数式構文や通常のコードブロックは拒否せず、警告を出した上でプレーンテキストとして簡略表示する。
  - 新たなランタイムやテーマを追加する場合は、事前のビルドとデプロイ作業が必要となる。

## 環境要件と再現コマンド

- **開発環境の前提と制約**:
  - Node.jsのみでHubの開発が可能である。Stageのデスクトップ環境を実行する場合のみ、Rust、GTK、WebKitが必要となる（rootおよび共有protocolのビルドにはRust不要）。
  - テーマ参照: 当PC上の `/home/watabegg/slidev-watabegg` を読み取り専用（dirty状態のまま）で参照している。シンボリックリンク、絶対パス、Slidev内部APIへの依存が残存しているため、このマシンで動作することが一般配布可能であることを意味しない。環境変数 `SLIDEV_LAB_THEME`, `SLIDEV_LAB_DEPENDENCY_ROOT`、およびStageパーサーの `SLIDEV_THEME_DIR` を経由する既存経路が存在する。
  - Wayland環境での実行: 当該PCにおいてAT-SPI起因のクラッシュを回避するために `NO_AT_BRIDGE=1` を設定している（すべてのWayland環境での必須要件として検証したものではない）。これはアクセシビリティ対応、Windows環境、物理2画面、実際の認証クラウドでの合格を意味するものではない。
- **再現手順**:
  - 各コマンドの検証結果は、作成済みの [migration/verification.json](migration/verification.json) を参照して確認すること。

```bash
# 依存関係のインストールと基本チェック
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test

# Hubのビルドと開発サーバー起動（4174番ポート。旧リポジトリのサーバー稼働時は競合注意）
pnpm build:hub
# サムネイル生成（build:hubとは独立）とブラウザ検証（Chrome: /usr/bin/google-chrome およびローカルテーマ側のPlaywrightが必要）
pnpm thumbnails:hub
pnpm verify:hub
pnpm dev:hub
# 任意ポート（例: 4194）で静的配信する場合:
# pnpm --filter @slidev-stage-hub/hub exec node scripts/serve.mjs artifacts/module-graph-offline/site 4194

# Stage UIの準備とビルド
pnpm stage:prepare
pnpm build:stage-ui

# StageデスクトップのSDK準備とビルド（SDK取得は必要な場合のみ実行、OS環境は変更しない）
python3 apps/stage/scripts/prepare-sdk.py
bash -c 'source apps/stage/scripts/desktop-env.sh; CARGO_BUILD_JOBS=2 cargo build --locked --manifest-path apps/stage/Cargo.toml -p slidev-native-poc --features desktop'
cargo test --locked --manifest-path apps/stage/Cargo.toml -p slidev-native-core

# Stageの起動と検証スクリプト実行（Waylandでのクラッシュ回避環境変数を付与）
NO_AT_BRIDGE=1 pnpm stage
NO_AT_BRIDGE=1 python3 apps/stage/scripts/verify.py

# 外部サイトへの接続テスト（対応するサイトルートのみ）
node apps/stage/scripts/connect.mjs https://example.com

# Workers実験環境のビルド・検証・開発サーバー起動（4180番ポート、旧サーバーとの競合注意）
pnpm build:workers
pnpm verify:workers
pnpm dev:workers
```

## 次期担当者の作業優先順位

1. **検証結果の確認とリポジトリ正本化**:
   - 作成済みの [migration/verification.json](migration/verification.json) およびREADMEに沿って起動確認を行う。新リポジトリを今後の開発における唯一の正本として扱い、旧リポジトリやローカルテーマを直接変更しない。
2. **パッケージ境界とプロトコルの固定**:
   - 安定したパッケージ境界およびCLI境界を確立し、対応するSlidevバージョン、テーマ選択方式、公開プロトコルの仕様書と互換性テストを固める。
   - 現在の `globals.d.ts` はStage周辺の内部型定義も混在した移植段階のものであるため、外部公開すべき型定義の選別と整理を行う。
3. **ローカル環境依存の解消と公開準備**:
   - ローカルテーマへのシンボリックリンクや絶対パス依存を解消し、クリーンな環境のCIを通過できるようにする。
   - 正式なライセンスの選定、npmパッケージ名やGitHubリポジトリ名の空き状況の確認、Stageのアプリケーション署名および配布戦略を決定してから外部公開を行う。
4. **Workers変換基盤の統合と実測**:
   - Workersによる変換出力をHubの資料カタログやStageのディスカバリー機能へ統合する。
   - R2イベントやQueuesを利用した変換自動化、サムネイル自動生成と再試行処理を実装する。
   - 本番相当の運用における費用および各種制限値を実測する。完全互換性を時期尚早に宣言しないこと。
5. **環境拡充と運用検証**:
   - Windows環境でのビルド・動作確認、物理的な2画面環境での表示検証を実施する。
   - 実際のCloudflare Access Service Tokenを用いた認証検証を行う。
   - 資料の更新・ロールバック機構、大量資料配置時のパフォーマンス検証を進める。
   - 開発チームの分離が不可欠になるまではモノレポ構成を継続するが、StageとHubがそれぞれ独立してリリース可能な状態を維持する。
