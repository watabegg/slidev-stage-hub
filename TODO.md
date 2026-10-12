# 今後の課題

現在の構成と判断理由は [設計判断](docs/DECISIONS.md)、開発手順は [開発ガイド](docs/DEVELOPMENT.md) を参照。

- [ ] 公開用ライセンス・配布 API を決定
- [ ] ネイティブアプリの独立ビルド・インストーラ配布を整備
- [ ] Windows・物理 2 画面で検証
- [ ] 実 Cloudflare / Access ホストで受入検証
- [ ] オブジェクトストレージへの直接配置を公開ジョブへ接続するイベントアダプターを検討
- [ ] App / Web の UI・UX を設計

- [ ] AWS（ECS、S3、PostgreSQL）および GCP（Cloud Run、GCS、PostgreSQL）の実環境における受け入れ検証
- [ ] npm パッケージおよびサーバー成果物の正式な配布への対応

既存機能の集約・パッケージ分離・CLI・Web 拡張点の整備は完了。[最終回帰記録](docs/results/final-regression.json) にローカルの検証範囲を記載しています。

- [x] 公開ジョブ・CLI / Web 進捗確認を実装し、ローカル統合検証を完了する（[実装台帳](docs/plans/publication-jobs-todo.md)）

- [x] 公開ジョブのレビュー修正・クリーンDocker導入検証・完了から30日後の手動整理を実装する（[検証記録](docs/results/publication-jobs-followup.json)）

- [x] 公開ジョブの完了を契機に、30日経過した履歴・再試行用入力を非同期で自動整理する（デッキごと24時間に1回、残作業・失敗は翌日へ継続。[検証記録](docs/results/publication-jobs-auto-retention.json)）

- [x] Web を Slidock、Native を Slive と命名し、リポジトリ・ディレクトリ・CLI の名称を統一
- [ ] Slidock / Slive のアイコンと favicon を決定
