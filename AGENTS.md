# 開発の入口

- 最初に `docs/HANDOFF.md` と `TODO.md` を読む。旧PoCの記録は `docs/legacy/` と各パッケージのresultsに残す。
- Stageは `apps/stage/`、Hubは `packages/hub/`、共有仕様は `packages/protocol/`。
- 元の `/home/watabegg/slidev-lab` とテーマ `/home/watabegg/slidev-watabegg` は変更しない。
- 機能の動作を保ちながら段階的に製品化する。移植済みと製品完成を区別し、未検証事項を隠さない。
- 計測結果・再現手順はresultsに記録し、進捗はTODO.mdへ反映する。
- Node依存はpnpm workspace、StageのRustはapps/stage/Cargo.tomlで管理する。
- アーティファクト・認証ファイル・トークンをGitへ追加しない。外部公開とcloud deployはローカル変更とは別に扱う。
- 長い技術文書は利用可能なagy-writer skillを使い、事実との照合を行う。

## 実装と検証

- codeはHow、testsはWhat、commitはWhy、commentはWhy notを記録する。コメント行数は機械判定しない。
- 振る舞いをテストし、不要な抽象化を避ける。`any` と `@ts-ignore` には理由を添える。
- 変更後はルートの `pnpm check` を使う。これは lint、format:check、typecheck、test、check:boundaries を順に実行する。
- Oxlint は Vue の未使用変数検査や template 全般を保証しない。型検査には既存の `vue-tsc` を使う。
- Formatter の対象と除外は現行の `.oxfmtrc.json` に従う。Markdown と `pnpm-lock.yaml` は対象外。
- Step 8 以降は移行例外ゼロを維持する。本番コードから `experiments/` を import しない。Workers の動的 import は `validatedRevisionModuleUrl` を直接通し、未検証 URL の解決を追加しない。
- 全量回帰は `pnpm check && pnpm verify:portable && pnpm verify:packed-cli && pnpm verify:workers-stage && pnpm verify:stage`。Node のクリーンコンテナ検証と Linux SDK・画面を使うネイティブ検証の実測を区別し、未実行を成功扱いしない。
