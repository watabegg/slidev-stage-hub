# Workers 実験コードの規約

- このディレクトリは Workers PoC と検証資産であり、`apps/hub-worker/` への製品化が完了したものとして扱わない。
- Worker runtime の import graph は Cloudflare Edge 環境に保つ。Node 専用の検証・ビルドスクリプトを runtime から参照しない。
- ローカル検証と実クラウド操作を区別する。デプロイや外部公開は明示的な依頼なしに行わない。
- publish、revision、thumbnail の変更は現行の上限・失敗時の振る舞いを確認し、履歴比較用の結果を上書きしない。
- token、認証ファイル、生成 bundle、`artifacts/` はコミットしない。
