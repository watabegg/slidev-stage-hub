# 開発引き継ぎ書

本書は、後続の開発者およびエージェントに向けて、現行システムの実装状況と運用手順を引き継ぐための技術文書です。過去の経緯を整理した記録は含めず、現在の実装事実のみを記載します。Step 7 までの詳細な履歴は、別紙の [legacy/handoff-through-step7.md](legacy/handoff-through-step7.md) に保存されています。

## 1. プロジェクト構成と進捗状況

本システムは、Rust と Tauri および厳格な TypeScript で構成されるデスクトップ UI の Stage、Node によるビルドと Slidev による静的スライド配信を担う Web フロントエンドの Hub、そして独立した Cloudflare Workers バックエンドの 3 要素で構成されています。
Step 1〜8 の実装とローカル検証は完了しました。基準となる進捗状況は [plans/productization-todo.md](plans/productization-todo.md)、全体計画は [plans/productization-plan.html](plans/productization-plan.html) を正として管理します。
Step 8 の実測は [results/final-regression.json](results/final-regression.json) に記録しています。クリーン Node コンテナで 203 件、ローカル Linux で Rust 42 件と実 Tauri/WebKit の回帰が通過し、境界違反・循環・移行例外は 0 件でした。先行する Step 7 の検証結果は [results/workers-integration.json](results/workers-integration.json) に保存されています。過去の検証記録は [results/](results/) および [legacy/](legacy/) に維持されています。なお、UI の再設計は延期されており、リファクタリングの完了と本番製品リリースの判断は明確に切り離して扱います。

## 2. モジュール構成と責務の境界

コードの肥大化や誤った依存関係を防ぐため、各ディレクトリの所有権と責務を厳格に定めています。
- `apps/stage/core`: Rust 側の状態管理に関する決定権を持ちます。
- `apps/stage/src-tauri`: ホスト環境との連携、設定、ファイルパス解決、認証、ノート管理を担います。
- `apps/stage/src`: ブラウザフレームおよびデスクトップ UI 画面の表示を担当します。
- `packages/protocol`: 通信電文の厳密な検証処理（バリデータ）およびネイティブブリッジを提供します。
- `packages/slidev-adapter`: Node 側の Slidev とランタイムを接続する仲介処理、および純粋なクリック判定の解析処理を担います。
- `packages/hub/src/node`: ビルド、設定読み込み、オフライン動作、サムネイル生成を処理します。
- `packages/hub/src/client`: 検証済みカタログを操作するヘッドレスなクライアント機能を提供します。
- `packages/hub/src/frontend`: 必要に応じて利用する任意の Vue 画面を提供します。
- `packages/stage-tools`: 実行準備、接続、認証設定を不可分（アトミック）な単位で処理します。
- `packages/cli`: `hub` および `stage` の各コマンドライン実行バイナリを提供します。
- `apps/hub-worker`: `src` は Edge コンパイラ、R2 ストレージ、Durable Objects を、`runtime` はブラウザランタイムを、`scripts` は Node スクリプトを受け持ちます。

本番コードから実験用コードを取り込むことは禁じられています。過去の薄いコマンド群は現行 API への転送処理として動作し、過去の検証結果や性能測定用ハーネスはそのまま保持されています。

## 3. 開発環境の前提と検査手順

実行環境として Node.js 24.15 以上および pnpm 12.3.4 を前提とします。環境構築と基本検証は以下の手順で実行します。

```bash
pnpm install --frozen-lockfile
pnpm browser:install
pnpm build:packages
pnpm check
```

ルートの `pnpm check` は、静的解析（lint）、コード整形（format）、型検査、テスト、境界検証を一括で実行します。ブラウザ向けの型検査には `vue-tsc` が含まれており、Vue のスクリプトとテンプレートの型を検査します。Markdown ファイルおよびロックファイルはフォーマッタの対象外です。理由のない `any` や `@ts-ignore` の使用は認められません。また、`/home/watabegg/slidev-lab` や `slidev-watabegg` などの隣接リポジトリやテーマを直接編集すること、機密情報や生成成果物を Git に含めることは厳禁です。

## 4. サービス起動・CLI 操作と配布方針

UI は変更せず、公式テーマ `@slidev/theme-default` と公開済みの `slidev-theme-watabegg@1.2.1` の例を使用します。各機能の詳細は以下の手引きを参照してください。
- [guides/hub-service.md](guides/hub-service.md)
- [guides/stage-tools.md](guides/stage-tools.md)
- [guides/cli.md](guides/cli.md)
- [guides/web-customization.md](guides/web-customization.md)
- [guides/workers.md](guides/workers.md)

サービスの起動手順は以下のとおりです。
- Hub の起動: `pnpm build:hub` の実行後、`pnpm dev:hub` を実行するとポート 4174（localhost:4174）で起動します。
- Stage の起動: `pnpm stage:prepare` の実行後、`NO_AT_BRIDGE=1 pnpm stage` を実行します。起動にはデスクトップ SDK とディスプレイ環境が必要です。ネイティブのノート書き込みテストを実施した場合は元の状態へ復元されます。
- Rust のビルド: 負荷の高い並列処理を避け、`apps/stage` ディレクトリから `CARGO_BUILD_JOBS=2` を指定して直列でビルドします。

コマンドライン操作では、`pnpm hub publish` の実行時に `--origin`、`--id`、`--source` の明示的な指定が必要です。Hub は build、check、serve、thumbnail の各処理を受け持ちます。Stage 用 CLI は `pnpm stage:cli` で実行し、デスクトップアプリの `pnpm stage` と明確に区別します。CLI では prepare、connect、doctor の機能を提供します。外部配布に関しては、`pnpm pack:cli` によるプライベートパッケージ化と、`pnpm verify:packed-cli` によるワークスペース外での導入検証にとどめ、npm への一般公開やネイティブインストーラの配布は行いません。

## 5. Worker ストレージ・通信仕様と公開世代・再生リビジョン管理

Worker のソースコードと配信成果物は、不変（immutable）なリリースとして保存されます。ストレージ構成として、R2 バインディングの `FILES`、Durable Objects バインディングの `VERSIONS`、Durable Object クラス `DeckVersions`、およびマイグレーション第 1 版の SQL ストレージ状態を維持します。
公開処理は、不整合を防ぐため、世代予約、成果物とマニフェストの保存、インデックス目印の更新、確定の順序で進められます。失敗した公開処理や古い世代のデータが現在の公開データを上書きすることはありません。
通信仕様において、`catalog.json` はプロトコル第 1 版に基づきページ分割され、クライアント側ですべてのページを取得します。`native-player` は第 1 版に加えて再生リビジョン照会に対応した第 2 版をサポートします。ネイティブブリッジ第 1 版および設定スキーマ第 1 版は維持されます。
Stage でリビジョン A を開いている最中に新しいリビジョン B が公開されても、再生中のリビジョン A は固定され自動更新されません。再接続時にリビジョン B が採用された場合は、既存ノートに対してリビジョン不一致の警告を表示します。サイドカーノートの識別情報（配信元、スライド ID、ページ番号）は不変であり、端末間の同期や排他制御は行われません。

## 6. 検証ゲートと CI パイプライン

品質を担保する G8 検証ゲートは、以下のコマンド列で構成されます。

```bash
pnpm check && pnpm verify:portable && pnpm verify:packed-cli && pnpm verify:workers-stage && pnpm verify:stage
```

ポータブル検証には、実際のブラウザ実行、静的ファイルの整合性、オフライン動作、公式テーマ、watabegg テーマ、カスタム Web 画面、Workers、モック認証が含まれます。Node 側の検証をホスト環境から隔離して清潔に実行するため、[../scripts/portable.Dockerfile](../scripts/portable.Dockerfile) によるコンテナ環境を利用できます。この際、ホストの `node_modules` や生成成果物をコンテナ内にマウントしてはなりません。
ローカル環境でのネイティブ Tauri および WebKit の検証には、Linux SDK と実際のディスプレイ環境が必要です。見かけ上テストを通過させるためのスキップは認められません。
継続的インテグレーションの設定ファイルである [../.github/workflows/checks.yml](../.github/workflows/checks.yml) には、ポータブル検証、パッケージ検証、Rust ビルド、仮想ディスプレイを用いたネイティブ検証を順番に実行するジョブが定義されています。ただし、ワークフロー設定の存在は GitHub 上での正常な実行を証明するものではなく、現時点で GitHub 上での実行は実施されていません。

## 7. 保留事項と制約条件

外部への一般公開やクラウド環境への配備は承認されていません。以下の項目は未決定または未確認の課題として本リファクタリングの範囲から切り離されています。
- 正式名称、ライセンス形態、配布手段の選定
- Windows 環境への対応および物理的な 2 画面環境での動作確認
- 実際の Cloudflare Access ホスト環境との接続検証およびクラウド受入試験

これらの項目は未完了であるため、Step 8 を含むリファクタリング作業がすべて完了したとしても、製品全体の開発が完了したとは主張できません。
