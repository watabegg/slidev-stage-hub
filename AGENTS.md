# 開発の入口

- 最初に `docs/HANDOFF.md` と `TODO.md` を読む。旧PoCの記録は `docs/legacy/` と各パッケージのresultsに残す。
- Stageは `apps/stage/`、Hubは `packages/hub/`、共有仕様は `packages/protocol/`。
- 元の `/home/watabegg/slidev-lab` とテーマ `/home/watabegg/slidev-watabegg` は変更しない。
- 機能の動作を保ちながら段階的に製品化する。移植済みと製品完成を区別し、未検証事項を隠さない。
- 計測結果・再現手順はresultsに記録し、進捗はTODO.mdへ反映する。
- Node依存はpnpm workspace、StageのRustはapps/stage/Cargo.tomlで管理する。
- アーティファクト・認証ファイル・トークンをGitへ追加しない。外部公開とcloud deployはローカル変更とは別に扱う。
- 長い技術文書は利用可能なagy-writer skillを使い、事実との照合を行う。
