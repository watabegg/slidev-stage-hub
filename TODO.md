# Stage / Hub 開発タスク

- [x] 新モノレポへの移植・起動検証
- [x] 引き継ぎdocsと旧PoCとの差分を整理
- [ ] 公開用ライセンス・名称・パッケージAPIを決定
- [x] ローカルテーマ・CLI・ブラウザ依存を解消し、クリーンコンテナで検証
- [x] 公式defaultテーマを既定化し、watabegg 1.2.1 exampleを追加
- [x] Node/ブラウザ検証とRust core用のCI設定を追加（GitHub上では未実行）
- [x] App/Web・コード構成・CLI・導入方法の現状を[HTMLレポート](docs/reports/architecture-overview.html)に整理（設計の決定はこれから）
- [x] 実験機能の集約・疎結合化・開発基盤を対象に[実装計画](docs/plans/productization-plan.html)を作成
- [ ] [実装計画の進捗台帳](docs/plans/productization-todo.md)に沿って8段階の再設計を進める（Step 7まで完了、Step 8未着手）
- [ ] 独立環境でのネイティブアプリのビルド・配布を検証
- [x] Workersコンパイルと既存Hub/Stageをローカル環境で統合・検証
- [ ] R2直接配置→Queueの自動生成経路
- [ ] Windows・物理2画面・認証付き実ホストを検証

環境依存解消の手順は [開発ガイド](docs/DEVELOPMENT.md)、実測は [検証記録](docs/results/portability.json) を参照。Step 7（Workers統合）まで完了。検証結果は [Workers統合記録](docs/results/workers-integration.json) を参照。次は Step 8（境界の最終整理・クリーン環境での全量回帰）。App/WebのUI/UX刷新は別途検討する。
