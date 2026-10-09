# 開発環境セットアップガイド

## 対象範囲と前提

本リポジトリは、過去の概念実証を取り込んで構成された非公開モノレポです。本稿は開発環境セットアップガイド（`docs/DEVELOPMENT.md`）であり、設計文書ではないため新たなアーキテクチャや API の決定は含みません。標準テーマには公開済みの公式 `@slidev/theme-default` 0.25.0 を採用し、`@slidev/cli` およびクライアントは 53.0.0 をワークスペースのロックファイルで固定しています。別ディレクトリの `examples/slidev52` は、既存の複数プロファイル実験専用として CLI とクライアントを 52.15.2 に固定しています。
追加サンプル用には公開済みの `slidev-theme-watabegg` 1.2.1 を明示的に指定して利用し、隣接リポジトリへのリンクや古い `slidev-lab`、`slidev-watabegg` の直接編集は行いません。環境依存の解消は完了しています。現在は再設計計画のStep 5（CLIの整理とパッケージ化）まで完了し、次はStep 6でWeb clientと表示のカスタマイズを整えます。npm への公開、リモートへの push、クラウドへの配備は実施していません。実際の検証結果は `docs/results/portability.json` に記録されており、クリーンなコンテナ環境での Node.js およびブラウザ検証と、ローカル環境でのネイティブ回帰試験を区別して管理しています（独立したネイティブ配布を保証するものではありません）。

## 環境構築と初期セットアップ

`package.json` の `engines` では Node.js 22.12 以上を指定していますが、実際に検証されているのは 24.15.0 です（CI 設定も 24.15.0 ですが、ホスト環境での CI は未実行です）。パッケージマネージャーには pnpm 12.3.4 を指定します。リポジトリルートから以下の手順を実行します。

```bash
pnpm install --frozen-lockfile
pnpm browser:install
pnpm check
```

`playwright-chromium` 1.63.0 はワークスペースの依存関係に含まれますが、意図しない自動ダウンロードを防ぐためインストールフックを明示的に無効化しています。そのため、`pnpm browser:install` を明示的に実行してブラウザを導入する必要があります。Linux 環境でシステムのブラウザライブラリが不足する場合は、`pnpm exec playwright install --with-deps chromium` を実行して OS 依存パッケージを導入するか、後述のコンテナを利用してください。
ブラウザは Chrome の絶対パスではなく完全な Chromium headless チャネルを使用し（参考: [Playwright公式ドキュメント](https://playwright.dev/docs/browsers#chromium-new-headless-mode) ）、必要に応じて `CHROMIUM_EXECUTABLE` で明示的に上書きできます。ルートでの Hub ビルドでは画面撮影のためにブラウザが必要となるほか、フォントのダウンロードとローカル配置のためにネットワーク接続が必要です。成果物のオフライン出力であっても、ビルドやインストールがオフラインで行えることを意味しません。
ツールチェーンの固定理由は以下のとおりです。厳密な依存関係の解決はロックファイルに委ねられており、広範な互換性を保証するものではありません。

- Vite 8.3.2: 移行後のアダプター基準
- PostCSS 8.5.28: 作業セッションにおいて 8.5.29 で CSS ビルドの失敗を確認したため
- markdown-it 14: Comark プライベートモジュールとの整合
- floating-vue 5.2.2: 以前の環境から引き継いだ Shiki の古い VMenu 形状を維持するため


## 開発チェックとフォーマット

### ベースラインと現状のステータス
2026年10月9日時点の検証状況および移行ステータスは以下のとおりです。

- **検証ベースライン**: 本日の実装変更前において、ルートディレクトリで `pnpm typecheck` を実行した後に `pnpm test` を実行した結果、いずれも終了コード 0 で完了しました。Node.js 環境でのテスト実行数は合計 64 件です（実行環境: Node.js 24.15.0、pnpm 12.3.4）。
- **ベースラインログ**: 実行ログはローカルの `artifacts/implementation/baseline-types.log` および `artifacts/implementation/baseline-tests.log` に出力されています。これらは生成された成果物であり、バージョン管理で追跡する文書資産には含めません。
- **インストール検証**: レジストリのメタデータが利用可能な状態で、新規の一時的な `node_modules` と既存の pnpm ストア（`--store-dir`）を使用した frozen-lockfile でのインストールが通過することを確認しました。なお、`baseline-browser-mapping` のキャッシュメタデータが存在せずオフラインでの再試行は失敗したため、オフラインでのインストール成功は確認できていません。
- **ゲート統合の状況**: 2026年10月9日にステップ 1 の検証ゲート G1 が確認され、`pnpm check` は終了コード 0 で通過しました。正式な根拠は `docs/results/development-foundation.json` に記録されています。Node.js のテストは合計 81 件（ルート 19、Hub 12、Stage 23、Workers 27）が通過し、境界検査では登録済みの移行例外が 19 件、未登録の境界違反は 0 件でした。なお、例外をゼロ件にすることが求められるのはステップ 8 です。
- **計画の進捗**: 全体計画は `docs/plans/productization-plan.html` に記載されています。ステップ 1〜2（T01〜T06）は完了し、次はステップ 3です。ステップ 3〜8は未着手です。

### 検証コマンドと対象範囲
開発時の検証を迅速に行うため、ルートの `package.json` に `pnpm lint`、`pnpm format`、`pnpm format:check`、`pnpm check:boundaries`、`pnpm check` のスクリプトを追加しています。

#### `pnpm check` の実行順序
統合検証コマンドである `pnpm check` は、軽量で高速な実行を維持するため、以下の順序で実行します。

1. `pnpm lint`
2. `pnpm format:check`
3. `pnpm typecheck`
4. `pnpm test`
5. `pnpm check:boundaries`

ブラウザ検証やフルビルドは処理に時間を要するため、この高速コマンドの対象外としています。

#### ツールの固定と型検査
ツールの挙動を揃えるため、バージョンを固定して運用します。

- **oxlint**: 1.87.0
- **oxfmt**: 0.72.0

型検査は、既存の `vue-tsc` による型検査を維持したうえで、Workers ランタイム向けの厳格な型検査を追加しています。なお、Oxlint は Vue の重複キーを検出できるものの、Vue スクリプト内の `no-unused-vars` は対象外であり、Vue テンプレート全般の静的解析カバレッジは保証されません（公式の互換性表: [oxc.rs/compatibility](https://oxc.rs/compatibility)）。

#### oxfmt の対象と除外設定
`oxfmt` によるコード整形は、既存の選定された TypeScript、ECMAScript モジュール（`.mjs`）、Vue、設定ファイル、スタイルファイルに適用します。

一方で、以下のファイルやパスは対象から除外します。

- **Markdown ファイル**: Slidev のスライド記述およびドキュメントを含むすべての `**/*.md`
- **パッケージ管理ファイル**: pnpm が管理するため、`pnpm-lock.yaml` は除外
- **除外・生成物・履歴パス**: `artifacts`、`dist`、`target`、`node_modules`、生成物（`generated`）、`results`、`docs/legacy`、`docs/reports`、`docs/plans`、`docs/migration`、`examples/legacy-native-baseline`
- **Rust 関連ファイル**: コード整形は Rust ツールで実施するため、すべての `**/*.toml` および `Cargo.lock` は oxfmt の対象外

### 境界検査と移行例外の管理
モジュール間の依存関係と境界を維持するため、`pnpm check:boundaries` による境界検査を実施します。ただし、現行の `scripts/check-boundaries.mjs` による静的解決は、外部 `node_modules` 内の依存関係解決、Vite の仮想 ID、外部テンプレートの内容、CSS の `url()` アセットを対象外としています。これらの解決経路はステップ 2 / ゲート G2 のバンドラ検証に委ねられます。また、既存コードの移行を円滑に進めるため、移行期間中に限って例外を許可します。

- **例外定義ファイル**: 例外は `scripts/boundary-exceptions.json` で管理します。
- **必須項目**: 各例外エントリは、厳密に `rule`、`file`、`specifier`、`owner`、`reason`、`removeStep` の 6 項目のみで構成します。
- **運用の制約**: 例外は移行専用の措置です。ステップ 8 が完了するまでは、境界例外がゼロ件であると主張してはなりません。

### コードとテストの規約
コードベースの品質と保守性を保つため、以下の規約に従います。

#### 設計および決定理由の記録
設計や判断の理由は、媒体ごとに役割を分担して記録します。これは記述上の規約であり、コメント行数などを機械的に検査するものではありません。

- **コード**: どのように動くか（How）を記述する。
- **テスト**: 何を検証・保証するか（What）を記述する。
- **コミット**: なぜその変更を行ったか（Why）を説明する。
- **コメント**: なぜ他の方法を採用しなかったか（Why not）を説明する。

#### 実装とテストの指針
- 実装の詳細に依存せず、振る舞いテストを優先します。
- 不要な抽象化は避けます。
- `any` 型や `@ts-ignore` を使用する場合は、必ず理由を明記します。

#### 実験環境の分離と保護
- 実験的なコードと本番コードは明確に区別します。
- `/home/watabegg/slidev-lab` および `/home/watabegg/slidev-watabegg` を編集してはなりません。
- 秘密情報、認証情報、トークン、生成された成果物は、バージョン管理の追跡対象に含めないでください。

## 共有契約とSlidev adapter

Step 2のG2は通過済みです（2026-10-09）。`pnpm check` 115件、Rust共通フィクスチャ、Hub/Stage HTTP・HTTPS連携66項目を確認しました。移行例外は16件です。詳細は [検証記録](results/protocol-adapter.json) を参照してください。

アプリケーション内部の状態すべてを公開APIとせず責務を分離するため、共有契約と処理系を整理しています。`packages/protocol/src/contracts`（ESM公開: `.`および`./contracts`）はCatalog、Discovery v1、iframeブリッジ通信の型、純粋なTypeScriptランタイム検証器を担当し、Node API非依存でブラウザやWorker環境と互換性を持ちます。Stage固有のセッション、Tauri、ウィンドウ、UIの型は`apps/stage/src/types`へ移設されました。また、`src/bridge`からビルドされる独立したクラシックスクリプト`dist/deck-bridge.js`は`./bridge`から提供されますが、`./build`はNodeビルド専用ツールでありブラウザ向け契約APIではありません。

Node専用の`packages/slidev-adapter`は`protocol`の型に一方向依存し、逆依存は持ちません。ここには`inspect-deck.ts`（パーサーとノートのバイトオフセット）、`native-manifest.ts`（ファイルシステムから読み込み、ソースパスや非公開ノートを除外する公開マニフェスト）、`runtime.ts`（CLIとクライアントの52.15.2および53.0.0完全一致バージョン解決）、`static-runtime.ts`（署名チェックで保護された非公開ソース向けパッチ適用）が配置されます。旧`protocol`の`./inspect-deck`と`./native-player`エクスポートは内部呼び出し元の移行に合わせて一括削除されたため、新アダプターのエクスポートを使用します。

ビルド時は`pnpm build:packages`で`protocol`、アダプターの順にdistエクスポートを準備します。通常のルートビルドやテストラッパー、`pnpm check`で自動構築されますが、Nodeスクリプトを直接実行する場合はインストール後やソース変更後に一度本ビルドを実行する必要があります。`pnpm test:contracts`はJS検証器、アダプターテスト、ブラウザ・Worker向けバンドル、共有フィクスチャ、Rustコア連携フィクスチャを実行します（全体のゲートは`pnpm check`が担います）。`tests/fixtures/native-player/v1`の共有JSONはTypeScriptのDiscovery検証とRust実DeckのserdeおよびControllerページ境界の検証のみを対象とします。Rustは完全なDiscoveryドキュメントを受け取らないため、バージョンやID、非対応デッキの判定方針はNode側でテストされ、Rustとの同等性は保証されません。

v1では未知の追加フィールドを許容し、capabilities契約やschema2は導入していません。オリジン、ウィンドウ、マウント、トークン、リビジョンの保護を維持しつつ、不正なブリッジフィールドや未対応ナビゲーションは拒否されます。なお、Hubのオーケストレーション移設はStep 3で完了し、Workersコンパイラ移設はStep 7で進めますが、既存Workersビルドに対応するためHubの`profile-runtime`ファサードは保持されており、実験的機能の全面撤去ではありません。

## Hub と Stage の実行と検証

Hub のビルドおよび開発サーバーの起動は以下のコマンドで行います。

```bash
pnpm build:hub
pnpm dev:hub
```

Hub は `localhost:4174` で起動し、`examples/fixtures` 内の 4 つの汎用スライドデックを使用して `packages/hub/artifacts/module-graph-offline/site` へ出力します。デフォルトテーマには公式テーマが適用されます。ブラウジングの確認は `pnpm verify:hub` で実行します。
Stage の準備と画面ビルドは以下のコマンドで行います。

```bash
pnpm stage:prepare
pnpm build:stage-ui
```

Node.js のみによる Stage の準備、UI、およびブラウザ通信プロトコルのテストは `node apps/stage/scripts/verify-remote.mjs` を実行します。これは Chromium 内で HTTP および HTTPS のテストホストを検証するものであり、テスト用証明書の例外処理を前提としています。実際の Cloudflare Access やネイティブ WebKit の検証ではありません。
デスクトップ版の実行には Linux 環境で Rust、GTK、WebKit が必要です。`apps/stage/README.md` には任意の SDK 抽出と、元の開発機固有の回避策である `NO_AT_BRIDGE=1` を記載しています。起動は `pnpm stage` で行います。ルートの Node.js 向け検証には Rust は不要です。Windows、物理ディスプレイ、独立したネイティブ配布の動作は Node.js テストスイートでは保証されません。

## 追加サンプルの実行

`examples/watabegg/demo/slides.md` には 3 枚のスライド（表紙、FigureGrid とローカル SVG、QuestionList をインポートした 2 カラム構成および 2 クリック操作、セクション）が含まれます。ルートパッケージ定義で公開版 1.2.1 を直接指定しており、テーマのローカル取り込みや変更は行いません。

```bash
pnpm build:example:watabegg
pnpm dev:example:watabegg
pnpm verify:example:watabegg
```

`localhost:4175` で提供され、成果物は `packages/hub/artifacts/example-watabegg-offline/site` に出力されます。デフォルトの 4 デックとは分離されており、標準テーマの切り替えも行いません。Stage 側でこのサンプルを準備する場合は以下を実行します。

```bash
node apps/stage/scripts/prepare.mjs --site packages/hub/artifacts/example-watabegg-offline/site --fixtures-root examples/watabegg
```

デフォルトの Stage データに戻すには `pnpm stage:prepare` を実行します。どちらの発表者ノートも非公開のまま保持されます。なお、`docs/results/portability.json` に記録されている本サンプルの検証範囲は Hub での描画、画像、クリック動作、および Stage への検出（10 項目）に限られ、ネイティブ環境でのサンプル実行検証は含まれていません（ネイティブ WebKit の 18 項目の検証は標準の 4 デックを対象としています）。

## 環境変数による上書き設定

`SLIDEV_THEME_PATH` に `package.json` を含むテーマディレクトリの絶対パスまたはカレントディレクトリ相対パスを指定することで、テーマの配置先を変更できます。テーマ自体に独自の CLI や Chromium の導入は不要ですが、テーマ自体の依存関係はインストールされている必要があります。代替の環境変数は `SLIDEV_LAB_THEME`、`SLIDEV_THEME_DIR` の順で適用されます。
標準の公式テーマはカレントディレクトリに依存せずワークスペースパッケージから解決されます。CLI の基準パスは通常リポジトリルートですが、実験的な特定バージョン固有のツールチェーンを利用する場合に限り `SLIDEV_LAB_DEPENDENCY_ROOT` で明示的に上書きできます。複数プロファイル用のパス設定は従来設計を維持しており、公開 API としての保証はありません。なお、テーマを変更した場合は再ビルドが必要です。

## Workers のローカル実験

Workers のビルドと検証は以下のコマンドで行います。

```bash
pnpm build:workers
pnpm verify:workers
pnpm dev:workers
```

これらはローカルでの実験のみを目的としています。実行時のテーマは公式テーマが標準ですが、ビルド時に環境変数で選択したテーマも使用できます。公開処理ではビルド済みテーマの別名または完全なパッケージ名のみを受け付け、任意の新しい実行時構成は受け付けません。スライド資料は独自の FigureGrid から標準の Markdown 画像記法へ変更されました。Mermaid などの制約は従来どおりです。
過去にクラウドへ配備された環境は旧テーマと古い実行時設定のままであり、今回の作業で配備は行っていません。過去の検証結果は `workers/results` に残り、最新の移植結果は別個の `docs/results/portability.json` に記録されます。


## 機能移行台帳

### 移行台帳の目的と運用方針

本台帳は、`docs/plans/productization-plan.html` のインベントリ（特にステップ 2、3、4、7）に基づき、各機能の現行実装、既存の検証手段、計画上の移行先、および移行進捗を一元管理して移行漏れやデグレードを防ぐことを目的としています。

台帳の解釈と運用にあたっては、以下の原則を適用します。

- **移行状況の定義**: `status` は本番向け移行作業自体の進捗を表し、現行コードでの動作可否を示すものではありません。移行が完了するまで、現行の移行元コードは現在の場所に維持します。
- **計画ステップの保留**: ステップ 1〜3は完了しています。後続のステップ 4〜8を未着手（`pending`）として記録します。
- **検証資産の保持**: 過去のベンチマークや比較用資産は検証・再現用として保持し、本番の実行時環境（ランタイム）にはインポートしません。

### 機能移行一覧

各機能の現行コード、検証手段、計画上の移行先、移行状況を以下に示す。

| feature | current source | test / verification | planned destination | status |
| --- | --- | --- | --- | --- |
| module-graph shared build | `packages/hub/src/node/build.ts`, `src/node/internal/graph.mjs` | `packages/hub/bundle-sharing/experiments/module-graph/catalog.test.mjs`; `pnpm verify:hub` | `packages/hub/src/node/build.ts` and associated `packages/hub/src/node/` (Step 3) | Step 3 complete |
| multi-profile resolution and process isolation | `packages/hub/src/node/internal/profiles.mjs`, `profile-probe.mjs`; `packages/hub/bundle-sharing/experiments/multi-profile/` | `packages/hub/bundle-sharing/experiments/multi-profile/scripts/browser.mjs`, `compare.mjs`; historical `packages/hub/bundle-sharing/experiments/multi-profile/results/experiment.md` | `packages/slidev-adapter/` isolation plus Hub profile service in `packages/hub/src/node/internal/profiles.mjs` (Steps 2–3) | Step 2 adapter complete; Step 3 complete |
| offline output and fingerprint cache | `packages/hub/src/node/offline.ts`, `src/node/internal/fingerprint-offline.mjs`, `packages/hub/frontend/` | `packages/hub/scripts/fingerprint-offline.test.mjs`; `pnpm verify:hub` | Integrated Hub build pipeline in `packages/hub/src/node/` (Step 3) | Step 3 complete |
| Hub thumbnail generation | `packages/hub/src/node/thumbnail.ts` | `pnpm thumbnails:hub`; `pnpm verify:hub` | `packages/hub/src/node/thumbnail.ts` (Step 3) | Step 3 complete |
| native bridge and shared wire types | `packages/protocol/src/contracts/`, `src/bridge/`; `packages/slidev-adapter/src/native-manifest.ts` | `apps/stage/scripts/verify-remote.mjs`; Stage tests | `packages/protocol/src/contracts/` and `src/bridge/` (Step 2) | Step 2 complete |
| Stage state, frame control, notes, auth | `apps/stage/core/`, `apps/stage/src/`, `apps/stage/src-tauri/`, `apps/stage/scripts/` | `pnpm --filter @slidev-stage-hub/stage test`; `cargo test --locked --manifest-path apps/stage/Cargo.toml -p slidev-native-core`; `node apps/stage/scripts/verify-remote.mjs` | `packages/stage-tools/src/` for prepare/connect plus modular `apps/stage/src-tauri/` (Step 4); UI and Rust core stay in Stage | Step 4 complete |
| CLI commands and private installation | `packages/cli/`, `scripts/pack-cli.mjs` | `pnpm test:cli`; `pnpm verify:packed-cli` | thin adapters over Hub / Stage tools (Step 5) | Step 5 complete |
| Workers compile, publish, and revision lifecycle | `packages/hub/bundle-sharing/experiments/workers/{compiler.mjs,worker.mjs,publish.mjs,runtime/}` | `compiler.test.mjs`; `pnpm verify:workers` | `apps/hub-worker/src/{worker,compiler,storage,versions,native-player}.ts` and `apps/hub-worker/runtime/` (Step 7) | Step 7 pending |
| Workers thumbnails | `packages/hub/bundle-sharing/experiments/workers/{thumbnail.mjs,local-thumbnail.mjs,verify-thumbnail.mjs}` | `thumbnail.test.mjs`; `verify-thumbnail.mjs`; `pnpm verify:workers` | `apps/hub-worker/` thumbnail/cache path, preserving current cached-response and uncached-503 behavior (Step 7) | Step 7 pending |
| Historical benchmark and comparison assets | `packages/hub/bundle-sharing/experiments/`, package `results/`, `docs/results/` | Existing result files and documented reproduction commands | Preserve as test/verification assets; never import into production runtime | Retained; no migration |

## クリーン環境での検証とCI

全体の検証シーケンスは以下の統合コマンドで実行します。

```bash
pnpm verify:portable
```

このコマンドは、型検査、単体テスト、Slidev 52 の解決、Hub のビルドとブラウザ検証、Stage と UI の準備、HTTP/HTTPS ブラウザテスト、追加サンプルのビルドと検証、Workers のビルドと検証（4 つのスライドの先頭 2 ページ）を順次実行します。実行時に既存の `SLIDEV_*`、`CHROMIUM_EXECUTABLE`、`NODE_PATH` を解除し、上書き設定による初期値の隠蔽を防ぎます。これは一連の検証手順であり、それ自体が環境を隔離するわけではありません。
ホスト環境の依存関係や生成成果物から隔離して検証する場合は Docker を使用します。

```bash
docker build -f scripts/portable.Dockerfile -t slidev-stage-hub:portable .
docker run --rm --init --shm-size=1g slidev-stage-hub:portable
```

ホストのディレクトリはマウントせず、`.dockerignore` により `node_modules`、成果物、`target`、`dist`、`.git`、ローカル認証情報を除外します。セットアップとビルドにはネットワーク接続が必要です。
`.github/workflows/checks.yml` では上記の Node.js およびブラウザ検証に加え、`cargo test --locked --manifest-path apps/stage/Cargo.toml -p slidev-native-core` を独立して実行します。リポジトリの push を行っていないため GitHub 上での CI 自体は未実行であり、手元の Docker による検証記録とは区別されます。コンテナ環境は独立したネイティブ GTK/WebKit アプリケーションとしての配布を保証するものではありません。ローカルのデスクトップ環境で回帰試験を実施した場合は別途記録します。

Hubの公開Node API・設定・非公開receipt・通常失敗時の復元範囲は [Hubサービス開発ガイド](guides/hub-service.md)、Step 3の実測は [検証記録](results/hub-service.json) を参照。

Stageの準備・接続API、設定探索、共有ロックは [Stageツール開発ガイド](guides/stage-tools.md)、Step 4の実測は [検証記録](results/stage-tools.json) を参照。

新CLIのコマンド、設定優先順位、非公開tarball導入手順は [CLI利用ガイド](guides/cli.md) を参照。旧環境変数は互換ラッパーでのみ使用します。
