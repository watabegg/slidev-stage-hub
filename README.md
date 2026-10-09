# Slidev Stage / Slidev Hub

**Stage** は安定した発表操作を提供するTauriアプリ。**Hub** は複数のSlidev資料を共有ランタイムで配信するWeb基盤。

旧PoCから機能を移植した開発用モノレポです。まず **[引き継ぎ](docs/HANDOFF.md)**、[TODO](TODO.md)、[移行後の検証結果](docs/migration/verification.json) を読んでください。開発環境の再現手順は **[開発ガイド](docs/DEVELOPMENT.md)** を参照してください。一般配布の準備はこれからです。

App/Webの機能・コード構成・CLI・導入方法・今後の設計論点は、[現状アーキテクチャレポート（HTML）](docs/reports/architecture-overview.html) にまとめています。

実験機能の集約、パッケージ境界、CLI・Webの拡張性、開発基盤の整備は、[実装計画（HTML）](docs/plans/productization-plan.html) と [進捗台帳](docs/plans/productization-todo.md) を参照してください。Step 4（Stageサービスとhost path）まで完了し、Step 5〜8は未着手です。日常の検証は `pnpm check`、結果は [Step 4検証記録](docs/results/stage-tools.json) を参照してください。

```sh
pnpm install --frozen-lockfile
pnpm browser:install
pnpm typecheck
pnpm test
pnpm build:hub
pnpm thumbnails:hub
pnpm dev:hub
```

Hubは http://localhost:4174 。ポートが使用中なら `pnpm --filter @slidev-stage-hub/hub exec node scripts/serve.mjs artifacts/module-graph-offline/site 4194` で変更できます。

Stageは `pnpm stage:prepare` の後、`NO_AT_BRIDGE=1 pnpm stage` で起動します。このPCのSDK準備・検証手順は [Stage README](apps/stage/README.md) を参照。Hubの開発にRustは不要です。

- [Stage](apps/stage/): Rust/Tauri、TypeScript UI、端末内ノート、認証付き外部接続
- [Hub](packages/hub/): Vueホーム、複数資料・テーマの共有ビルド、Workers変換実験
- [Protocol](packages/protocol/): 共通マニフェスト・資料解析・Native bridge・型
- [Examples](examples/): 共通資料と旧実装の比較用fixture

既定は公式 `@slidev/theme-default`。Slidev・テーマ・検証ツールはworkspaceのlockfileで管理します。公開済みwatabegg 1.2.1のexampleは `pnpm build:example:watabegg` → `pnpm dev:example:watabegg`（localhost:4175）で確認できます。

クリーン環境の検証は `scripts/portable.Dockerfile`、実行結果は [portability.json](docs/results/portability.json) を参照。旧リポジトリとテーマ開発ディレクトリは変更しません。GitHubへの公開、npm公開、Cloudflareへの再デプロイは行っていません。

Hub Node APIの使い方は [Hubサービス開発ガイド](docs/guides/hub-service.md)、Step 3の検証結果は [hub-service.json](docs/results/hub-service.json) を参照。

Stageの準備・接続APIと設定パスは [Stageツール開発ガイド](docs/guides/stage-tools.md) を参照。
