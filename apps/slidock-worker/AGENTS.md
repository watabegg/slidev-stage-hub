# Slidock Worker

- `src/` は Workers/DO、`runtime/` はブラウザ、`scripts/` は Node のビルド・検証。環境をまたぐ内部 import を追加しない。
- R2 の FILES、DO の VERSIONS / DeckVersions、SQL state と migration v1 は既存データの互換境界。変更時は移行を設計する。
- 公開は成果物と一覧マーカーの保存後に current を切り替える。失敗・競合時は既存 current を保つ。
- 動的モジュールは検証済みの同一リビジョン URL に限る。native metadata がない旧資料は Web 専用として扱う。
- `pnpm verify:workers` と `pnpm verify:workers-slive` はローカル検証。クラウドへのデプロイを含めない。
- 生成物・秘密情報は artifacts または無視対象に置き、過去の results を上書きしない。
