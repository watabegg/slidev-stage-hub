# Slive の実装規約

- Slive の状態正本と遷移規則は Rust core に置き、UIやTauriホストへ重複させない。
- UI、frame controller、QA 用 TypeScript は strict を維持する。共有 wire 型は `packages/protocol/` で扱う。
- 認証ヘッダーやノート本文をログ・生成物へ出さない。許可ルート、権限検査、既存ノート保存仕様を保つ。
- Slive の Node 検証は `pnpm --filter @slidock/slive typecheck` と `test`、Rust core は `cargo test --locked --manifest-path apps/slive/Cargo.toml -p slive-core` を使う。
- WebKit、Windows、物理2画面の未検証範囲を、Node テストの合格で検証済みにしない。
