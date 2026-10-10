# Hubサーバーの実行環境と導入

本ドキュメントは、Hubサーバーを運用または開発するエンジニアに向けて、サポートされている各実行環境の責務分担、Node.js環境でのローカル起動手順、本番環境向けのストレージ構成、コンテナおよびデプロイ用テンプレートの利用方法、プライベートパッケージの導入手順、ならびに現在の制約事項を解説する導入ガイドです。アーキテクチャの背景や決定事項については [../DECISIONS.md](../DECISIONS.md) を、Cloudflare Workers 固有の運用については [workers.md](workers.md) を、CLI の利用法については [cli.md](cli.md) を参照してください。

## 実行環境とパッケージの責務分担

Hubサーバーは、中核ロジックを共有パッケージに集約し、実行基盤や永続化の差異をアダプター層で吸収する構成を採用しています。

### パッケージ構成と責務

| パッケージ | 主な責務と対応環境 | 依存関係と補足 |
| :--- | :--- | :--- |
| `packages/server` | コアロジック（HTTP ルーティング、配信処理 `publishDeck`、スライドコンパイラ） | 外部プラットフォーム依存を持たず、ES2022 および DOM 型定義のみに依存（`types: []`）。`createHubServer(options)` は `{ fetch(Request): Promise<Response> }` オブジェクトを返却 |
| `packages/protocol` | サーバー・クライアント間のデータ構造および API リクエスト／レスポンス型定義 | 共通型定義 |
| `packages/slidev-adapter` | Slidev スライドのパース、メタデータ抽出、ビルド連携 | スライド変換抽象化 |
| `packages/adapter-cloudflare` | Cloudflare Workers 環境への接続。R2（`FILES`）、Durable Objects（`VERSIONS`）、静的アセット（`STATIC`）、プロファイル環境変数のマッピングとサムネイル取得 | Wrangler 生成型および実プラットフォーム型を使用。Durable Objects の `DeckVersions` クラスや SQL 状態は `apps/hub-worker/src/versions.ts`、マイグレーション v1 設定は `apps/hub-worker/wrangler.jsonc` に配置され、本アダプターには内包されない |
| `packages/adapter-node` | Node.js 環境への接続。`@hono/node-server` による HTTP 起動、ローカルファイルシステム成果物保存、インメモリ配信ストア、静的アセット配信 | HTTP 起動や静的アセット配信は Node.js 実行共通で利用され、ファイルシステム保存とインメモリ配信ストアのみがローカル開発専用 |
| `packages/storage-s3` | AWS S3 をバックエンドとする成果物保存（`ArtifactStore`）の実装 | AWS SDK クレデンシャルチェーンに依存。ストリーム PUT はメモリへバッファして Content-Length を指定した単一条件付き PUT として送信 |
| `packages/storage-gcs` | Google Cloud Storage をバックエンドとする成果物保存（`ArtifactStore`）の実装 | Google Cloud ADC（Application Default Credentials）に依存。GCS SDK 依存関係を隔離 |
| `packages/state-postgres` | PostgreSQL をバックエンドとする配信ストア（`PublicationStore`）の実装 | `pg.Pool` を利用したマニフェスト永続化、世代管理、初期化関数を提供 |
| `apps/hub-server` | Node.js リファレンスサーバーアプリケーション | 各種アダプターと永続化層を統合して起動 |

## Node.js環境でのローカル起動とCLI配信

Node.js 環境上で手軽にサーバーを起動し、CLI からスライドを配信して動作確認を行えます。

### 前提条件

- Node.js 24.15.0 以上
- pnpm 12.3.4
- 初回ビルド時のインターネット接続（オフラインでの依存関係導入はキャッシュメタデータの欠落により保証されません）

### ソースコードからの起動手順

1. 依存関係のインストールとサーバーランタイムの事前ビルドを実行します。
   ```bash
   pnpm install --frozen-lockfile
   pnpm build:server-runtime
   ```
   ※ `build:server-runtime` は単一のビルダー（`apps/hub-worker/scripts/build-runtime.mjs`）を実行し、`apps/hub-worker/artifacts/site` 配下に静的アセットと `runtime-manifest.json` を生成します。

2. ローカルでの変更操作を許可して開発サーバーを起動します。
   ```bash
   HUB_ALLOW_LOCAL_MUTATIONS=true pnpm dev:server
   ```
   サーバーはデフォルトで `127.0.0.1:4180` で待機します。

3. 別のターミナルから CLI を用いてスライドを配信します。
   ```bash
   pnpm hub publish --origin http://127.0.0.1:4180 --id demo/intro --source examples/workers/slides.md
   ```

### ローカル起動時の挙動と留意事項

- ローカルのデフォルト構成では、インメモリ配信ストア（`HUB_PUBLICATIONS=memory`）とファイルシステム成果物保存（`HUB_STORAGE=filesystem`）が使用されます。
- サーバーを再起動すると、インメモリに保持されていた配信ポインタ（`current`）は失われますが、ファイルシステム上の成果物実体（`artifacts/hub-server/objects` 配下）は残存します。
- `HUB_ALLOW_LOCAL_MUTATIONS=true` は、公開トークン未設定かつループバック接続時に限って変更操作を許可する開発向けのフラグです。本番環境（`NODE_ENV=production`）では本フラグ自体が自動で無効化されるのではなく、ファイルシステム保存やインメモリ配信ストアの利用自体が起動時に拒否されます。
- 認証が必要な環境に対して CLI から配信を行う場合は、パーミッション `0600` の設定ファイル（`--headers-file`）を介して Bearer トークンを渡してください。詳細は [cli.md](cli.md) を参照してください。

## 環境変数一覧と設定仕様

サーバーアプリケーション（`apps/hub-server/src/config.ts` および `start.ts`）で読み込まれる環境変数の仕様は以下のとおりです。

| 環境変数名 | デフォルト値 | 許容値 / 型 | 説明 |
| :--- | :--- | :--- | :--- |
| `NODE_ENV` | なし | 文字列 | `production` 指定時、`HUB_STORAGE=filesystem` または `HUB_PUBLICATIONS=memory` の組み合わせは起動時に明示的に拒否されます |
| `HOST` | `127.0.0.1` | 任意のホスト名文字列 | サーバーがリッスンするホストアドレス |
| `PORT` | `4180` | 整数（`0`〜`65535`） | リッスンポート番号。`0` を指定した場合はエフェメラルポートを使用 |
| `HUB_STATIC_DIR` | `apps/hub-worker/artifacts/site` | ディレクトリパス | 静的アセット配置先。ビルド済みの `runtime-manifest.json` が必須であり、プロファイルはこのマニフェストから導出されます（Node.js 環境向けの `PROFILE_*` 環境変数は存在しません） |
| `HUB_STORAGE` | `filesystem` | `filesystem` / `s3` / `gcs` | 成果物の保存先ドライバー |
| `HUB_ARTIFACT_DIR` | `artifacts/hub-server/objects` | ディレクトリパス | `HUB_STORAGE=filesystem` 選択時の保存先ディレクトリ |
| `HUB_BUCKET` | なし | 文字列 | `s3` または `gcs` 利用時に必須となるバケット名 |
| `AWS_REGION` | なし | 文字列 | S3 利用時のリージョン名（任意） |
| `HUB_S3_ENDPOINT` | なし | URL 文字列 | S3 互換ストレージやローカル検証用のエンドポイント URL（任意） |
| `HUB_S3_FORCE_PATH_STYLE` | なし | `true` / `false` | S3 パススタイルアクセスの強制（ローカル互換ストレージ等で使用） |
| `GOOGLE_CLOUD_PROJECT` | なし | 文字列 | GCS 利用時のプロジェクト ID（任意） |
| `HUB_PUBLICATIONS` | `memory` | `memory` / `postgres` | 配信状態ストアのドライバー |
| `HUB_DATABASE_URL` | なし | 接続 URL 文字列 | `postgres` 利用時に必須となる PostgreSQL 接続文字列 |
| `HUB_DATABASE_INIT` | なし | `true` / `false` | `true` の場合、サーバー起動時にテーブル初期化を実行します（リクエストごとではありません）。未指定または `false` の場合は初期化を行いません |
| `HUB_PUBLISH_TOKEN` | なし | 文字列 | 設定時、Bearer トークンによる変更操作（mutation）を有効化 |
| `HUB_ALLOW_LOCAL_MUTATIONS` | なし | `true` / `false` | 正確に `true` かつループバック通信、トークン未設定の場合のみ有効 |

クラウドストレージの認証情報はコードやリポジトリ、コンテナイメージに直接埋め込まず、AWS SDK 標準の認証情報チェーン、または Google Cloud の ADC（Application Default Credentials）を使用します。

## 本番ストレージ構成とPostgreSQL配信ストア

本番環境（`NODE_ENV=production`）では、成果物保存先に S3 または GCS を、配信状態ストアに PostgreSQL を組み合わせて運用します。

### 配信状態の永続化モデル

PostgreSQL ストアでは、デッキ単位の最新マニフェストと世代番号（`generation`）を単一のテーブルで管理します。

- **`begin`（配信開始）**: アトミックな UPSERT を実行し、世代番号（`generation bigint`）をインクリメントします。この時点では既存の `current_manifest` は上書きされず維持されます。
- **成果物永続化とインデックスマーカー**: 生成された成果物群とマニフェストをオブジェクトストレージに永続化した後、インデックスマーカーを配置します。
- **`commit`（配信確定）**: 直前の `begin` で発行された最新トークンと合致する場合に限り、条件付き UPDATE を実行して `current_manifest` を更新します。同一の最新トークンを用いた再コミットは許容されます。
- **競合調停規則（latest-begin-wins）**: 最新の `begin` が常に優先されます。新しく開始された `begin` が正常に発行された後に公開処理が失敗した場合、その新しい世代によってそれ以前の古いトークンは無効化されます。一方で、データベース接続失敗などでストレージ更新に至らず失敗した `begin` は、既存のトークンを無効化しません。
- **障害時の保護**: 処理の失敗時や HTTP 409 競合が発生した場合も、既存の `current` 状態は保護されます。
- **設計境界**: デッキをまたぐグローバルトランザクション、オブジェクトストレージの CAS（Compare-And-Swap）による配信ドライバー、キューによる非同期再試行機構は存在しません。

### データベーススキーマ

```sql
CREATE TABLE IF NOT EXISTS hub_publications (
  deck_id text PRIMARY KEY,
  generation bigint NOT NULL CHECK (generation >= 0),
  current_manifest jsonb
);
```

## コンテナ環境とデプロイ用テンプレート

### DockerfileによるOCIイメージのビルド

リポジトリルートから以下のコマンドでビルドします。

```bash
docker build -f apps/hub-server/Dockerfile -t slidev-stage-hub:server .
```

- マルチステージビルドにより、単一のランタイムビルダーで静的アセットを構築し、本番依存関係のみ（`deploy --prod`）で構成されたアプリケーションイメージを出力します。
- イメージ内のランタイム環境変数は `NODE_ENV=production`、`HOST=0.0.0.0`、`PORT=8080`、`HUB_STATIC_DIR=/app/static` です。本番起動には S3/GCS および PostgreSQL の環境変数を注入する必要があります。

### ローカル検証用Docker Compose

ローカルで PostgreSQL と組み合わせた動作確認を行うための構成が `apps/hub-server/deploy/compose.yaml` に用意されています。

```bash
docker compose -f apps/hub-server/deploy/compose.yaml up --build
```

- 開発用構成（`HUB_STORAGE=filesystem` + PostgreSQL）で動作し、`localhost:8080` で待機します。
- テスト用の固定トークン `local-dev-only-publish-token` が設定されており、CLI からの接続には `--headers-file` による認証が必要です。この固定認証情報を本番環境で使用してはなりません。なお、今回の開発工程では構文確認のみを行っており、Docker Compose プラグインによる実起動テストは未実行です。

### クラウドデプロイ用テンプレート

デプロイ構成のひな型として以下のテンプレートが同梱されています。

- **AWS ECS Fargate向け**: `apps/hub-server/deploy/aws-ecs-task-definition.template.json`（ECS Fargate + S3 + PostgreSQL）
- **Google Cloud Run向け**: `apps/hub-server/deploy/gcp-cloud-run-service.template.yaml`（Cloud Run + GCS + PostgreSQL）

`apps/hub-server/deploy/aws-ecs-task-definition.template.json` および `apps/hub-server/deploy/gcp-cloud-run-service.template.yaml` は、リソースをプロビジョニングするコマンドではなく参照用の設定テンプレートであるため、含まれるすべての `REPLACE_*` プレースホルダーを運用者の実際の値に置き換える必要があります。また、クラウド環境の自動構築には対応しておらず、実際の AWS や GCP における受け入れ検証、デプロイ、IAM やネットワークの設定検証は実施されていないため、利用側で既存のバケット、接続可能な PostgreSQL データベース、実行・サービスアカウントの IAM 権限、シークレット連携、ネットワーク設定、イメージレジストリとイメージを事前に準備し、デプロイ前にテーブル初期化を完了しておく必要があります。

いずれのテンプレートも `HUB_DATABASE_INIT` は明示的に `false` と設定されており、デプロイ前にテーブルが作成されていることを前提とします。認証情報はテンプレートやイメージ内に含めず、各種シークレット管理サービスから注入してください。テンプレート単体でのデプロイコマンドや実環境での展開テストは提供されていません。

## プライベートtarballパッケージの利用

外部プロジェクトや独自のサーバー構成にライブラリを組み込むために、プライベート tarball パッケージ群を出力できます。

### パッケージの出力

```bash
pnpm pack:server
```
出力先 `artifacts/server-package/` には、`package.json`、`pnpm-workspace.yaml`、および `tarballs/` ディレクトリ配下に8つのパッケージ（`protocol`、`slidev-adapter`、`server`、`adapter-cloudflare`、`adapter-node`、`storage-s3`、`storage-gcs`、`state-postgres`）が生成されます。

### パッケージの制約と導入手順

- ソースコードディレクトリは不要ですが、外部 npm レジストリへの依存関係解決は必要です（オフライン導入は保証されません）。
- **含まれない成果物**: この tarball セットには `server-app`、ビルド済みランタイム出力、および CLI ツールは含まれません（CLI は別途 `pnpm pack:cli` で出力します）。
- 利用先では `artifacts/server-package` ディレクトリ全体を相対パス構造を維持してコピーし、以下を実行します。
  ```bash
  pnpm install --ignore-scripts
  ```
- インポートの疎通確認は以下で行えます（モジュールのインポート可否を確認するものであり、完全なワークフローを検証するものではありません）。
  ```bash
  node --input-type=module -e 'import {createHubServer} from "@slidev-stage-hub/server"; console.log(typeof createHubServer)'
  ```
- 独自のカスタムサーバーを構築する場合はランタイムアセットを別途準備してライブラリ群と合成する必要があります。既製のリファレンスサーバーをそのまま利用する場合は、ソースリポジトリのチェックアウトを推奨します。

## HTTPルーティングとコンパイラ仕様

中核ロジックの契約および制限事項の概要は以下のとおりです（詳細な背景は [../DECISIONS.md](../DECISIONS.md) を参照）。

- **HTTP エンドポイント**: `/catalog.json`（カタログ v1、カーソル対応）、`/native-player.json`（再生方式として `revision` クエリパラメータ指定を案内するネイティブプレイヤー文書 v2）、`/api/catalog`（レガシー）、`/api/decks/:id`（GET/POST、リビジョン指定対応）、`/api/thumbnail/:id`（PUT/POST）、`/releases/...`（不変アセット配信）。デッキドキュメントの GET/HEAD 要求は `revision` クエリを保持して内部的に `/index.html` を取得して返却し、外部リダイレクトは行いません。存在しない API 等への SPA フォールバックは行いません。
- **コンパイラ制約**: JSON 本文上限 512 KiB、スライド数最大 100 枚（Cloudflare / Node.js 共通）。テキスト形式（`.svg`, `.txt`, `.css`）アセットのみを扱い、任意のスクリプト実行や include は禁止。テーマ等は事前ビルドで固定し、発表者ノートは非公開ストレージにのみ保持されます。
- **サムネイル生成の環境差分**: Cloudflare Workers では `BROWSER` バインディング設定時のみ Browser Rendering（quickAction）による自動生成が利用可能です。Node.js リファレンス環境は動的レンダリング機能を持たないため、`POST /api/thumbnail/:id` は既存画像がキャッシュされていれば 200 を返しますが、未生成画像に対しては 503 を返します（1200×675、4 MiB 以下の有効な PNG による直接 `PUT` 登録、またはローカルアップローダーを使用）。なお、ライブラリの呼び出し元は `renderThumbnail` を注入可能です。

## 検証状況とスコープ・制約事項

### 検証状況とローカルゲート

ローカル環境における各種ゲート検証（`pnpm check`、`pnpm verify:server`、`pnpm verify:packed-server`、Docker ビルド検証）は成功しています。具体的なテストケース数やアサーション結果の詳細は [platform-portability.json](../results/platform-portability.json) を参照してください。なお、ローカル検証において PostgreSQL はローカル実 DB、S3 は SDK とローカル HTTP フィクスチャ、GCS は注入フィクスチャを用いてテストされました。

### 未検証事項

- 実際の AWS、Google Cloud、Cloudflare Access 環境での受け入れ検証、およびクラウド実環境へのデプロイは未実施です。
- CI ワークフローの実行および今回の native Stage 検証は実施していません。

### 運用上の制約とスコープ外事項

- **共有ランタイムの互換性**: 各リビジョンの成果物は固定されますが、共有ランタイムを更新した場合に過去のリビジョンとの完全な互換性が維持される保証はありません。
- **スコープ外の機能**: npm レジストリへのパッケージ公開、汎用バイナリ配布、DynamoDB / Firestore や AWS Lambda / API Gateway 向けアダプター、オブジェクトストレージ CAS による配信ドライバー、キューによる非同期再試行機構は対象外です。
