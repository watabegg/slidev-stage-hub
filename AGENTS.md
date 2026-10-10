# 開発の入口

- 最初に `README.md`、`docs/DECISIONS.md`、`TODO.md` を読む。過去の計画・実験記録は設計判断集から Git 履歴を参照する。
- Stageは `apps/stage/`、Hubは `packages/hub/`、共有仕様は `packages/protocol/`。
- 元の `../slidev-lab` とテーマ `../slidev-watabegg` は変更しない。
- 機能の動作を保ちながら段階的に製品化する。移植済みと製品完成を区別し、未検証事項を隠さない。
- 採用した設計と理由は `docs/DECISIONS.md`、検証の要約は `docs/results/`、生ログ・生成物は無視対象の `artifacts/` に残す。`TODO.md` は未完了の課題を管理する。
- Node依存はpnpm workspace、StageのRustはapps/stage/Cargo.tomlで管理する。
- アーティファクト・認証ファイル・トークンをGitへ追加しない。外部公開とcloud deployはローカル変更とは別に扱う。
- 長い技術文書は利用可能なagy-writer skillを使い、事実との照合を行う。

- **サーバー配置とコアの責務境界**: 共通サーバー関連のコードは `packages/server`、`packages/adapter-cloudflare`、`packages/adapter-node`、`packages/storage-s3`、`packages/storage-gcs`、`packages/state-postgres`、および `apps/hub-server` に配置されています。共通ビジネスロジックを担う `packages/server` にはプロバイダー固有の SDK を含めないでください。ブラウザ向けランタイムのビルダー（`apps/hub-worker/scripts/build-runtime.mjs`）は単一の構成のまま変更ありません。
- **ローカル永続化と本番永続化の区別**: Node アダプターで提供されるファイルシステムやインメモリの永続化はローカル検証専用の実装です。S3、GCS、PostgreSQL などの本番向け永続化構成と混同しないでください。

## 実装と検証

- codeはHow、testsはWhat、commitはWhy、commentはWhy notを記録する。コメント行数は機械判定しない。
- 振る舞いをテストし、不要な抽象化を避ける。`any` と `@ts-ignore` には理由を添える。
- 変更後はルートの `pnpm check` を使う。これは lint、format:check、typecheck、test、check:boundaries を順に実行する。
- Oxlint は Vue の未使用変数検査や template 全般を保証しない。型検査には既存の `vue-tsc` を使う。
- Formatter の対象と除外は現行の `.oxfmtrc.json` に従う。Markdown と `pnpm-lock.yaml` は対象外。
- 移行例外ゼロを維持する。本番コードから `experiments/` を import しない。Workers の動的 import は `validatedRevisionModuleUrl` を直接通し、未検証 URL の解決を追加しない。
- 全量回帰は `pnpm check && pnpm verify:portable && pnpm verify:packed-cli && pnpm verify:workers-stage && pnpm verify:stage`。Node のクリーンコンテナ検証と Linux SDK・画面を使うネイティブ検証の実測を区別し、未実行を成功扱いしない。
