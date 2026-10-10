# 今後の課題

現在の構成と判断理由は [設計判断](docs/DECISIONS.md)、開発手順は [開発ガイド](docs/DEVELOPMENT.md) を参照。

- [ ] 公開用ライセンス・正式名称・配布 API を決定
- [ ] ネイティブアプリの独立ビルド・インストーラ配布を整備
- [ ] Windows・物理 2 画面で検証
- [ ] 実 Cloudflare / Access ホストで受入検証
- [ ] オブジェクトストレージへの直接配置を公開ジョブへ接続するイベントアダプターを検討
- [ ] App / Web の UI・UX を設計

- [ ] AWS（ECS、S3、PostgreSQL）および GCP（Cloud Run、GCS、PostgreSQL）の実環境における受け入れ検証
- [ ] npm パッケージおよびサーバー成果物の正式な配布への対応

既存機能の集約・パッケージ分離・CLI・Web 拡張点の整備は完了。[最終回帰記録](docs/results/final-regression.json) にローカルの検証範囲を記載しています。

- [x] 公開ジョブ・CLI / Web 進捗確認を実装し、ローカル統合検証を完了する（[実装台帳](docs/plans/publication-jobs-todo.md)）
