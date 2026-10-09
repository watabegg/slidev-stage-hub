# Slidev Stage / Slidev Hub

**Stage** は安定した発表操作を提供するTauriアプリ。**Hub** は複数のSlidev資料を共有ランタイムで配信するWeb基盤。

旧PoCから機能を移植した開発用モノレポです。まず **[引き継ぎ](docs/HANDOFF.md)**、[TODO](TODO.md)、[移行後の検証結果](docs/migration/verification.json) を読んでください。一般配布の準備はこれからです。

```sh
pnpm install --frozen-lockfile
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

ローカルテーマ `/home/watabegg/slidev-watabegg` への依存が残っています。旧 `slidev-lab` は保存し、開発はこのリポジトリで進めます。GitHubへの公開、npm公開、Cloudflareへの再デプロイは行っていません。
