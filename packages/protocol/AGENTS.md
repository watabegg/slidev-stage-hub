# Protocol の実装規約

- Hub、Stage、ブラウザー間の共有契約を扱い、Stage 専用の内部型を共有 API と混同しない。
- `deck-bridge.ts` などブラウザーで動くコードへ Node 組み込み API を追加しない。既存 Node 依存の整理は protocol 境界の移行計画に沿って行う。
- wire 形式の変更は互換性を明示し、Hub と Stage の両側で実際の振る舞いを検証する。Rust 側の対応状況も記録する。
- 公開 exports は `package.json` に明示し、未定義の内部パスを別パッケージから参照しない。
