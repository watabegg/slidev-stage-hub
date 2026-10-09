# 開発方針

StageとHubを独立して配布できるモノレポへ育てる。現状と次の優先事項は [docs/HANDOFF.md](docs/HANDOFF.md)、進捗は [TODO.md](TODO.md) を正本とする。

移植した実装は動作を保って改善する。最初に共有protocolと配布APIの境界を固め、ローカルテーマ・パス依存の解消、独立環境CI、ライセンスと配布方法の決定へ進む。

WorkersのMD変換と既存Hub/Stageの統合、R2直接配置からの自動更新、Windows・実複数画面の検証は未完了。旧PoCの失敗・制約を製品の合格条件と取り違えない。
