# Slive

Slidev の発表者用画面と聴講者用画面の 2 画面を提供する、Rust および Tauri ベースのデスクトップアプリケーションです。状態管理の正本として Rust コアを使用し、安定した 2 画面表示を実現します。

本プロジェクトは現在開発中であり、ソースコードは公開されていますが、npm やネイティブパッケージとしての配布、およびライセンスの選定は完了していません。また、Windows 環境での動作や物理 2 画面での動作は未検証です。設計上の判断理由については [DECISIONS.md](../../docs/DECISIONS.md) を参照してください。

## 主な機能と仕様

仕様の詳細に関する重複した説明を避け、各機能の解説は `../../docs/guides/` 配下の各ガイドに集約しています。

- **ノート機能**:
  - ローカルノート: ソース内の既存コメントの確認とハッシュ検証に基づいて扱います。
  - リモートノート: オリジン、ID、ページごとのサイドカーとして保持します。
- **リモート認証**: ネイティブ側でオリジンを限定したヘッダーを付与して通信します。
- **ネイティブプレイヤー**: native-player の Discovery manifest 契約 v1 および v2 を受け取ります。
- **クリック操作の制約**: 複雑なクリック操作には無条件で対応していません。制限の詳細は Workers ガイドを参照してください。
- **Node ツール CLI**: 関連する Node CLI ツールの説明は [slive-tools.md](../../docs/guides/slive-tools.md) および [cli.md](../../docs/guides/cli.md) を参照してください。

## 環境要件と実行

実行にはブラウザ環境および pnpm による依存関係の解決が前提となります。

### Linux 環境の準備
Linux 環境では、Rust、GTK、WebKitGTK、SDK、およびディスプレイ表示環境が必要です。必要に応じて以下のスクリプトで SDK の展開を行えます。

```bash
python3 apps/slive/scripts/prepare-sdk.py
```

※ このスクリプトは OS パッケージをインストールしません。Ubuntu の既存ライブラリなども必要であり、スクリプト単体ですべての依存関係が揃う保証はありません。

開発機で AT-SPI の起動に関する問題を回避する必要がある場合は、環境変数 `NO_AT_BRIDGE=1` を指定して起動してください。これは起動トラブルの回避策であり、アクセシビリティの動作を保証するものではありません。

### アプリケーションの起動
ルートディレクトリから以下のコマンドを実行します。

```bash
pnpm build:slidock:fixtures
pnpm slive:prepare
pnpm slive
```

別の Node CLI ツールを実行する場合は、以下のコマンドを使用します。

```bash
pnpm slive:cli --help
```

## 検証とテスト

各種検証およびテストは以下のコマンドで実行します。

### 型チェックおよびテスト
```bash
pnpm --filter @slidock/slive typecheck
pnpm --filter @slidock/slive test
```

### 実機検証
実行には SDK およびディスプレイ環境が必要です。

```bash
pnpm verify:workers-slive && pnpm verify:slive
```

### Rust コアのテスト
```bash
CARGO_BUILD_JOBS=2 cargo test --locked --manifest-path apps/slive/Cargo.toml -p slive-core -p slive
```
