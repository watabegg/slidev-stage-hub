# slidev-stage-hub

slidev-stage-hub は、Slidev で作成した複数のプレゼンテーション資料を一括でビルド・配信し、手元の端末による発表操作と連携させるための基盤です。

スライド資料の共有・管理と、発表時のノート確認や画面操作を円滑につなぐことを目的に開発されています。現在は機能の実装を優先して進めており、画面表示（UI）の刷新は後回しとして開発を継続しています。

## 主な構成要素

- **Hub**: 複数の Slidev 資料をまとめてビルドし、配信する基盤です。
- **Stage**: Rust と Tauri で構築されたデスクトップ環境です。発表時のスライド操作や、手元の端末上でのノート確認を担います。
- **Worker**: 資料の公開や変換、および Stage との接続を担います。

## 前提条件

- Node.js >= 24.15.0
- pnpm 12.3.4
- セットアップおよびビルド時のインターネット接続

Hub の Node.js 環境やブラウザ向けの開発では、Rust のインストールは不要です。

## クイックスタート

リポジトリのルートディレクトリで以下のコマンドを実行すると、依存関係の解決とビルドを経て Hub の開発サーバーが起動します。

```bash
pnpm install --frozen-lockfile
pnpm browser:install
pnpm build:hub
pnpm dev:hub
```

起動後、ブラウザで `http://localhost:4174` を開くと Hub にアクセスできます。

## Stage と CLI の利用

- **Stage（デスクトップアプリ）の起動**
  実行には Linux SDK、Rust、およびディスプレイ環境が必要です。準備手順の詳細は [apps/stage/README.md](apps/stage/README.md) を参照してください。以下のコマンドでデスクトップアプリを起動します。
  ```bash
  pnpm stage:prepare
  pnpm stage
  ```
- **Node CLI の利用**
  パッケージをビルドしたあと、各 CLI のヘルプを確認できます。
  ```bash
  pnpm build:packages
  pnpm hub --help
  pnpm stage:cli --help
  ```

## テーマとサンプル

既定のテーマには `@slidev/theme-default` を使用します。追加テーマ `slidev-theme-watabegg`（バージョン 1.2.1）を使用したサンプルは、以下のコマンドでビルドおよび起動できます。起動後は `http://localhost:4175` にアクセスしてください。

```bash
pnpm build:example:watabegg
pnpm dev:example:watabegg
```

## 現在の開発状況と制限事項

本リポジトリは公開ソースコードとして開発を進めていますが、配布形態や検証状況に以下の未完了・未検証項目があります。

- **パッケージとアプリの配布**: npm への一般公開や Stage のインストーラー（ネイティブ配布）は未整備です。現時点ではプライベートワークスペースおよびプライベート tarball（`pnpm pack:cli`、`pnpm verify:packed-cli`）による検証を行っています。
- **未検証の環境**: Windows 環境、物理的な 2 画面環境、実際の Cloudflare Access と連携した動作は未検証です。
- **UI の更新**: UI の刷新は別途実施する予定です。
- **ライセンス**: ライセンスは未決定です。

## 詳細ドキュメント

開発手順や各種仕様の詳細は、以下のドキュメントを参照してください。

- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): 開発および検証の手順
- [docs/DECISIONS.md](docs/DECISIONS.md): 設計方針と採択理由
- [docs/guides/cli.md](docs/guides/cli.md): CLI の利用方法と導入手順
- [docs/guides/web-customization.md](docs/guides/web-customization.md): Web 画面の差し替え手順
- [docs/guides/workers.md](docs/guides/workers.md): Worker のローカル検証と公開 API
- [docs/guides/hub-service.md](docs/guides/hub-service.md): Hub サービスの API 詳細
- [docs/guides/stage-tools.md](docs/guides/stage-tools.md): Stage ツールの API 詳細
- [TODO.md](TODO.md): 今後の課題一覧
