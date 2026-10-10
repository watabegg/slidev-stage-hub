# 開発ガイド

本ドキュメントは、GitHub リポジトリ `watabegg/slidev-stage-hub` の開発手順と検証方法を説明する開発者向けガイドです。本リポジトリは現在開発中であり、ソースコードは公開されていますが、npm やネイティブ向けのパッケージ配布、およびライセンスの選定は完了していません。

## 前提条件と環境構築

開発には以下の環境が必要です。

- Node.js 24.15 以上
- pnpm 12.3.4（ロックファイルを固定して使用）

リポジトリを取得後、依存関係の解決、テスト用ブラウザの導入、パッケージのビルド、初期検証を順に実行します。

```bash
pnpm install --frozen-lockfile
pnpm browser:install
pnpm build:packages
pnpm check
```

Linux 環境でテスト用ブラウザやシステム依存ライブラリが不足している場合は、以下のコマンドで Chromium と必要な依存パッケージを導入してください。

```bash
pnpm exec playwright install --with-deps chromium
```

ブラウザ検証には標準で Chromium の headless チャンネルを使用します。任意の実行バイナリを使用する場合は、環境変数 `CHROMIUM_EXECUTABLE` で上書きしてください。なお、ビルド時にフォント取得などの外部通信が発生するため、インターネット接続が必要です。

## リポジトリ構成

本リポジトリは以下のコンポーネントで構成されています。個別の設計理由については [DECISIONS.md](DECISIONS.md) を参照してください。

- `apps/stage`: Rust によるコア・ホスト実装および TypeScript 製 UI
- `apps/hub-worker`: Edge、ブラウザ、Node.js 向けスクリプト群
- `packages/hub`: Node.js ビルドパイプライン、クライアント、フロントエンド
- `packages/protocol`: 純粋な契約（contracts）およびブリッジ定義
- `packages/slidev-adapter`: Node.js 向けの Slidev 非公開 API 境界に加え、Worker でも利用可能な Node.js 非依存のクリック操作
- `packages/stage-tools`: 準備および接続用の Node.js ツール群
- `packages/cli`: 各種機能を呼び出す薄いアダプター

## 日常の開発と品質管理

日々の変更に対する検証には `pnpm check` を使用します。内部では以下の順序で検査が実行されます。

1. `lint`（静的解析）
2. `format:check`（整形確認）
3. `typecheck`（型検査）
4. `test`（単体・結合テスト）
5. `check:boundaries`（依存境界の検査）

静的解析ツールの Oxlint は Vue テンプレート内の型整合性を保証しないため、型検査には `vue-tsc` を組み合わせて安全性を確保しています。コード整形の適用には `pnpm format` を実行してください。フォーマッターの除外対象（`**/*.md`、ロックファイル、`generated/`、`artifacts/`、`dist/`、`target/`、`results/`）の詳細は `.oxfmtrc.json` に定義されています。

アーキテクチャ境界の例外は許容されず（例外数 0）、本番コードから実験用コード（`experiments`）をインポートすることは禁止されています。不要な抽象化を避け、コードには実装方法（How）、テストには振る舞い（What）、コミットには変更理由（Why）、コメントには採用しなかった理由（Why Not）を記述してください。また、ビルド成果物や秘密情報を Git に含めてはいけません。

## ビルドと開発サーバー

コンポーネントごとのビルドおよび開発サーバー起動コマンドは以下のとおりです。

- **Hub**: `pnpm build:hub` / `pnpm dev:hub`
- **Stage**: `pnpm stage:prepare` / `pnpm build:stage-ui`
- **Workers**: `pnpm build:workers` / `pnpm dev:workers`

各コンポーネントの詳細な利用手順は、以下のドキュメントを参照してください。

- `guides/hub-service.md`
- `guides/stage-tools.md`
- `guides/cli.md`
- `guides/workers.md`
- `guides/web-customization.md`

## 回帰テストと検証

変更内容を網羅的に検証する際は、以下のコマンドで一括回帰テストを実行します。

```bash
pnpm check && pnpm verify:portable && pnpm verify:packed-cli && pnpm verify:workers-stage && pnpm verify:stage
```

### Docker による Node 隔離環境での検証

ホスト環境の差異を排除するため、Docker コンテナ内で隔離検証を実施できます。

```bash
docker build -f scripts/portable.Dockerfile -t slidev-stage-hub:portable .
docker run --rm --init --shm-size=1g slidev-stage-hub:portable sh -c 'pnpm check && pnpm verify:portable && pnpm verify:packed-cli'
```

`.dockerignore` により `node_modules/`、`artifacts/`、`target/`、`dist/`、`.git/`、および非公開設定はビルドコンテキストから除外されており、ホストディレクトリのマウントは行いません。依存パッケージの導入やビルドのため、コンテナ内からインターネット接続が必要です。

`portable` 検証では、実ブラウザ操作、静的配信、オフライン動作、カスタム Web、テーマ適用、HTTP/HTTPS 通信、Workers フィクスチャ、モック認証をテストします。`packed-cli` 検証では、外部の一時ディレクトリに非公開の 5 つの tarball パッケージを実際にインストールして動作を確認します。

### ネイティブ環境の検証（apps/stage）

`apps/stage` のネイティブ機能に関する 2 段階のゲート検証には、Rust に加えて Linux SDK およびディスプレイ環境（Xvfb 等）が必要です。詳細は [../apps/stage/README.md](../apps/stage/README.md) を参照してください。

コアおよびホスト機能のテストは、並列ジョブ数を指定して実行します。

```bash
CARGO_BUILD_JOBS=2 cargo test --locked --manifest-path apps/stage/Cargo.toml -p slidev-native-core -p slidev-native-poc
```

必須の SDK が導入されていない環境では検証を行わず「未検証」として扱ってください。Node.js 側のテストが合格しても、ネイティブ機能が合格したとはみなせません。

## CI パイプラインと検証記録の扱い

CI のワークフロー定義は [../.github/workflows/checks.yml](../.github/workflows/checks.yml) に記載されており、portable 検証、Rust ビルド、Linux 上の Xvfb を用いたネイティブ検証の順で実行される設定となっています。GitHub Actions 上の実際の実行環境とローカル環境での計測結果は異なるため、本文書では CI が成功したとは記載しません。また、リポジトリ内の `results/final-regression.json` は 2026-10-10 時点のローカル検証スナップショットであり、現在の CI 成功を証明する記録ではありません。

## 互換用環境変数と実験コードの分離

従来のラッパー向けに以下の互換環境変数が用意されており、設定が存在する場合は優先順位に従って適用されます。

1. `SLIDEV_THEME_PATH`（最優先）
2. `SLIDEV_LAB_THEME`
3. `SLIDEV_THEME_DIR`

`SLIDEV_LAB_DEPENDENCY_ROOT` は実験用です。新しい API や CLI ではこれらを使用せず、明示的な設定を参照してください。

現行 Stage のフレーム維持・描画待ち・競合処理は `apps/stage/scripts/verify-flicker.mjs` で検証します。過去版の比較ハーネスと計測記録は [DECISIONS.md](DECISIONS.md) 内の固定 Git リンクから参照できます。
