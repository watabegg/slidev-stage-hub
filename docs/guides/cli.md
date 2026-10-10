# CLI 利用ガイド

`@slidev-stage-hub/cli` は、Hub および Stage サービスの薄いアダプターとして機能する開発者・利用者向けの CLI です。Node CLI とデスクトップ版は別個に構成されており、公開コマンドの `hub publish` は実装済みです。

## パッケージ構成と動作環境

本ツールは非公開パッケージ `@slidev-stage-hub/cli`（バージョン 0.1.0）として構成されており、npm レジストリへの公開は行われていません。コマンドラインバイナリとして `hub` と `stage` を提供します。

- 動作要件: Node.js 24.15 以上、pnpm 12.3.4
- ワークスペースのビルド: `pnpm install --frozen-lockfile; pnpm build:packages`
- ヘルプの確認: リポジトリ直下で `pnpm hub --help` および `pnpm stage:cli --help` を実行

リポジトリ直下の `pnpm stage` は既存の Rust 製デスクトップアプリを起動するコマンドであり、新しい stage CLI ではありません。配布される tarball に含まれる `stage` コマンドは `prepare`、`connect`、`doctor` のみを提供し、ネイティブアプリの起動やバイナリそのものは含みません。

## コマンド一覧と共通仕様

各コマンドの機能と動作仕様は以下のとおりです。

- `hub build`: スライドのコンパイルとサムネイル生成を実際に実行します。既定でオフラインモードが有効（`true`）となっており、無効化する場合は `--no-offline` を明示します。
- `hub check`: 入力設定とスライド構成（deck）を読み取り専用で検証します。コンパイル自体の成功を保証するものではありません。
- `hub serve`: 静的ファイルを配信する常駐サーバーを起動します。既定では `127.0.0.1` のポート `4174` で待機し、ポート `0`（空きポートの自動割り当て）も指定できます。
- `hub thumbnail`: 既存のビルド済みサイトからサムネイル画像を生成します。
- `stage prepare`: Hub が生成した既存のレシート（既定では配信サイトディレクトリに隣接する `${site}.receipt.json`）を読み取り、ランタイム設定を生成します。ランタイム設定の `schemaVersion: 1` は維持されます。
- `stage connect`: 指定したオリジンへ接続します。位置引数または `--origin` で接続先を指定します。
- `stage doctor`: ランタイム設定、Node.js バージョン、スキーマ、スライド構成、パス、認証ファイルを読み取り専用で検査します。ファイルへの書き込みは行わず、OS やネイティブバイナリ自体の動作準備を保証するものではありません。準備不備が検出された場合は終了コード 1 で終了します。
- `hub publish --origin ROOT --id ID --source PATH`（各オプション必須）を実行すると、CLI から Workers API へ公開処理を行い、revision と entry を返却します。追加オプションとして `--assets JSON`、`--headers-file PATH`、`--json` を指定できます。HTTPS または loopback HTTP の利用条件や、パーミッション 0600 が必要な origin-bound headers などの仕様詳細は [workers.md](workers.md) を参照してください。

### 共通フラグ・入出力・終了コード

すべてのコマンドで `--help`（`-h`）、`--version`、`--json` を利用できます。

- 出力形式: `--json` 指定時、標準出力には単一の JSON ドキュメントのみを出力します。進捗やログはすべて標準エラー出力へ送られます。
  - 成功時: `{"ok":true,"command":"hub build","data":{...}}`
  - 失敗時: `{"ok":false,"command":"...","error":{"code":...,"message":...}}`
- 常駐動作: `hub serve` は、`--json` 指定時に起動準備が整った段階で準備完了 JSON を 1 回だけ標準出力し、SIGINT または SIGTERM を受信するまで常駐します。
- 終了コード:
  - `0`: 正常終了
  - `1`: 実行時エラー、または `stage doctor` による準備状況の検査不備
  - `2`: 入力値の不正、または未対応コマンドの指定

## 設定の優先順位と形式

設定値は **CLI フラグ > 設定ファイル > 既定値** の順に優先されます。CLI フラグで指定したパスは実行時のカレントディレクトリを基準とし、設定ファイル内のパスは対象 JSON ファイルが置かれたディレクトリからの相対パスとして解決されます。新しい CLI は従来の環境変数を無視します。未知の設定キーは許容されないため、古いキー名は明示的に移行してください。

秘密情報は `--headers-file` を介した非公開 JSON ファイル参照のみを受け付け、コマンド引数、ログ、JSON 出力にトークン文字列を直接露出させることは禁止されています。既存の接続先オリジン検証（auth-origin）、リダイレクト禁止（no-redirect）、制限付き読み取り（bounded-read）ポリシーはそのまま適用されます。

### Hub 設定（`hub.config.json`）

`--config <file>` を指定するか、カレントディレクトリの `hub.config.json` が自動で読み込まれます。既存の `schemaVersion: 1` 形式を使用し、新しいスキーマは追加されません。

- 許容フィールド: `sourceRoot`, `outDir`, `dependencyRoot`, `theme`, `decks`, `profiles`, `offline`, `chromiumExecutable`, `bootstrap`, `isolateDecks`
- 既定値: `sourceRoot` は `<cwd>/slides`、`outDir` は `<cwd>/dist`
- CLI フラグ: `--source-root`, `--out-dir`, `--dependency-root`, `--theme`, `--chromium-executable`, `--offline`/`--no-offline`, `--bootstrap sync|tla`, `--isolate-decks`
- サブコマンド固有フラグ: `serve` および `thumbnail` では `--site`（省略時は設定ファイルの `outDir` を利用）。`serve` では `--host`, `--port` も指定可能です。

### Stage CLI 設定（`stage.config.json`）

`--config <file>` を指定するか、カレントディレクトリの `stage.config.json` が自動で読み込まれます。これは実行時設定である `local-config.json` とはスキーマが異なります。

- 許容フィールド: `schemaVersion: 1`, `site`, `fixturesRoot`, `outputConfig`, `receiptPath`, `legacySourceRoot`, `dependencyRoot`, `origin`, `headersFile`
- 既定値: `site` は `<cwd>/dist`、`fixturesRoot` は `<cwd>/slides`、`outputConfig` は `<cwd>/.slidev-stage/local-config.json`（サンプルの固定フォールバックは持ちません）
- CLI フラグ: `--site`, `--fixtures-root`, `--output-config`, `--receipt`, `--legacy-source-root`, `--dependency-root`, `--headers-file`

## リポジトリ外での標準ワークフロー

スライド構成 `slides/demo/slides.md` を持つ外部プロジェクトでの作業手順は以下のとおりです。

1. 設定ファイルの作成: プロジェクト直下に `hub.config.json` を配置します。
   ```json
   {"schemaVersion": 1, "sourceRoot": "slides", "outDir": "dist"}
   ```
2. 設定の検証: `pnpm exec hub check` を実行して構成を検証します。
3. ビルドとサムネイル生成: `pnpm exec hub build` を実行します。
4. ランタイム設定の生成: `pnpm exec stage prepare` を実行し、`.slidev-stage/local-config.json` を出力します。
5. 状態検査: `pnpm exec stage doctor` を実行してランタイム設定やパスの整合性を確認します。
6. 配信用サーバーの起動: `pnpm exec hub serve` を実行して静的配信を開始します。
7. 別プロジェクトからの接続: 別のディレクトリから `pnpm exec stage connect http://127.0.0.1:4174` を実行します。

### ネイティブ環境とブラウザの注意点

- デスクトップアプリの起動: 外部から提供されたネイティブバイナリに `--config /abs/project/.slidev-stage/local-config.json` を渡すか、リポジトリ内から `NO_AT_BRIDGE=1 pnpm stage --config ...` を実行します（`NO_AT_BRIDGE=1` は Linux 環境向けの回避策であり、すべての OS で必須ではありません）。Node.js の導入だけではネイティブの GTK/WebKit/Rust 実行環境を満たせません。
- Chromium の依存関係: ビルドやサムネイル生成には Chromium が必要です。Playwright コマンドが直接使用可能とはみなさず、`hub build` や `hub thumbnail` で `--chromium-executable /absolute/path/to/chromium` を指定して実行パスを明示するか、既存の Playwright ブラウザキャッシュを利用してください。

## プライベートパッケージの配布と検証

本ツールは `pnpm pack:cli` を実行することで `artifacts/cli-package` ディレクトリにパッケージ化されます。

- パッケージ内容: `package.json`、`pnpm-workspace.yaml`、および 5 つの内部パッケージ（`protocol`, `slidev-adapter`, `hub`, `stage-tools`, `cli`）の tarball。
- ファイルの制限: 各 tarball にはコンパイル済みの JS（dist）が含まれ、Hub に必要なフロントエンドのソースも含まれますが、生成されたスライドサイト、成果物、テスト用フィクスチャ、認証情報は含まれません。また、ネイティブ Stage バイナリは配布されません。
- インストール手順: `artifacts/cli-package` フォルダ全体をリポジトリ外にコピーし、そのディレクトリで `pnpm install` を実行します。その後、`pnpm exec hub --help` や `pnpm exec stage --help` を実行できます。
- 依存関係の解決: 生成された `pnpm-workspace.yaml` のオーバーライド定義を維持することで、内部パッケージはローカルの tarball から解決され、Slidev ツールチェーンの間接的な固定バージョンが保持されます。外部の依存関係は通常のレジストリやキャッシュから取得されます。npm レジストリへの公開は行いません。
- 自動検証: `pnpm verify:packed-cli` は、使い捨ての外部インストール環境を作成し、空のカレントディレクトリから「ビルド → サムネイル生成 → prepare → doctor → HTTP serve → connect → doctor」の一連の処理を実行します（詳細は `docs/results/final-regression.json` に記録されます）。
- テスト: `pnpm test:cli` および `pnpm check` を使用します。

## 移行ガイドと制限事項

### 既存スクリプトからの移行

既存の `pnpm build:hub`、`pnpm stage:prepare`、`node apps/stage/scripts/connect.mjs` は維持されます。

- 環境変数: `SLIDEV_LAB_*` などの旧環境変数は従来のラッパーでのみ有効です。競合が検知された場合は標準エラー出力に警告が表示されます（トークン値は出力されません）。
- 設定フラグの変更: 旧 stage ラッパーの `--config` は出力先のランタイム設定を指していましたが、新しい stage CLI の `--config` は入力用の CLI 設定を指し、出力先は `--output-config` で指定します。
- 設定形式の移行: Hub の古いプロファイル設定（`fixturesRoot` やオブジェクト形式の `decks`）は、新しい形式（`sourceRoot` や `{id, entry, profile}` の配列形式の `decks`）への変換が必要です。変換が完了するまでは従来のラッパーを使用してください。ユーザー設定ファイルの自動書き換えは行われません。
- フィクスチャのパス: 従来の固定フィクスチャパスはプロジェクト配下の `slides` や `dist` を基準とする形に改められたため、必要に応じて `--site` や `--fixtures-root`、または設定ファイルで明示してください。

### 制限事項

- 動作検証は Linux 環境でのみ実施されています。
- ネイティブバイナリのパッケージングは未検証です。
- 本番の Cloudflare 認証環境での動作は未検証です。
- 既存のデスクトップ UI は変更されていません。

Web entry は `--frontend-entry PATH` または設定ファイルの `frontendEntry` で指定します。CSS とナビゲーションの設定例は [Web カスタマイズガイド](web-customization.md) を参照してください。
