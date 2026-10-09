# Stage / Hub 開発タスク

- [x] 新モノレポへの移植・起動検証
- [x] 引き継ぎdocsと旧PoCとの差分を整理
- [ ] 公開用ライセンス・名称・パッケージAPIを決定
- [x] ローカルテーマ・CLI・ブラウザ依存を解消し、クリーンコンテナで検証
- [x] 公式defaultテーマを既定化し、watabegg 1.2.1 exampleを追加
- [x] Node/ブラウザ・packed CLI・Rust・LinuxネイティブのCI設定を追加（GitHub上では未実行）
- [x] App/Web・コード構成・CLI・導入方法の現状を[HTMLレポート](docs/reports/architecture-overview.html)に整理（再設計前の記録）
- [x] 実験機能の集約・疎結合化・開発基盤を対象に[実装計画](docs/plans/productization-plan.html)を作成
- [x] [実装計画の進捗台帳](docs/plans/productization-todo.md)に沿って8段階の再設計を進める（Step 1〜8完了）
- [ ] 独立環境でのネイティブアプリのビルド・配布を検証
- [x] Workersコンパイルと既存Hub/Stageをローカル環境で統合・検証
- [ ] R2直接配置→Queueの自動生成経路
- [ ] Windows・物理2画面・認証付き実ホストを検証

環境依存解消の手順は [開発ガイド](docs/DEVELOPMENT.md)、実測は [検証記録](docs/results/portability.json) を参照。Step 1〜8 は完了。最新の実測は [最終回帰記録](docs/results/final-regression.json) を参照。App/WebのUI/UX刷新は別途検討する。
