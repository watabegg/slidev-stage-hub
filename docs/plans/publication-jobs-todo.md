# TODO: 公開ジョブ・CLI・進捗確認

> 運用契約: このファイルは in-place 更新する。再開時は全文と計画書の Hard Gate / Out of scope / 現在 Step を読み、現在位置を確認する。設計変更は計画書へ反映する。

- 計画書: [publication-jobs-plan.html](publication-jobs-plan.html)
- モック: [job-status-mock.html](publication-jobs-assets/mock/job-status-mock.html)（2026-10-10 ユーザー承認済み）
- goal prompt: なし（別セッションへの引き継ぎは未依頼）
- 計画検証日: 2026-10-10（main@2d96e53）
- アクティブタスク: 全7タスク完了。取消なし。検証記録: [publication-jobs.json](../results/publication-jobs.json)。
- 状態: [ ] 未着手 / [x] 完了 / [!] blocked（理由必須）/ [-] cancelled（計画改訂・理由必須）
- 完了条件: 全7タスクの消し込みと Gate 通過。一部取消時は取消一覧を残す。
- 非冪等操作: 実行直前に「実行開始」を記録し、再開時は副作用を確認する。

## Unclear Points

- U1: 解決済み。2026-10-10 ユーザーがWebモックを承認。
- U2: 本番render origin・認証・実行設定（実クラウド検証のみ。ローカル実装を妨げない）。

## タスク

- [x] Task 1: プロトコル規約とクライアントライブラリの実装 — packages/protocol/src/contracts/jobs.ts および packages/slidock/src/client/jobs.ts を作成し、プレーン TypeScript 型ガード、進捗監視非同期イテレータを実装する。［ゲート: G1］
- [x] Task 2: サーバーコアロジックの分離とジョブ基盤の構築 — packages/server/src/jobs/ 配下に ports.ts、service.ts、runner.ts を新設し、preparePublication の抽出と二重生成防止・冪等性管理を実装する。［ゲート: G2］
- [x] Task 3: 永続化アダプタと実行エンジンの実装 — PostgreSQL 用マイグレーション作成、Cloudflare Durable Objects アラーム連携、および独立ワーカープロセス worker.ts を実装する。［ゲート: G3］
- [x] Task 4: サムネイル生成レンダラーの統合 — packages/renderer-playwright/ を新設してローカル Chromium 描画を実装し、Cloudflare ブラウザ連携と partial 制御を統合する。［ゲート: G4］
- [x] Task 5: CLI コマンドの拡張と進捗監視機能の追加 — packages/cli/ において slidock publish の非同期対応、slidock jobs サブコマンド群、および設定プロファイル管理を実装する。［ゲート: G5］
- [x] Task 6: Web 進捗確認画面の実装 — packages/slidock/src/frontend/JobStatus.vue およびマウント用ラッパーを作成し、安全なトークン保持と切断耐性を持つ UI を構築する。［ゲート: G6］
- [x] Task 7: 統合検証ハーネスの構築と運用ドキュメントの整備 — apps/slidock-worker/scripts/verify-publication-jobs.mjs を作成して全体導通を自動化し、各種設定・運用ガイドを更新する。［ゲート: G7］

## Hard Gate

計画書 Appendix B がコマンドの正本。FAIL のまま依存する次 Step に進まない。台帳と Unclear Points を更新して再実行する。

| Gate | 結果 |
| --- | --- |
| G1 | PASS: protocol 5件・client 6件、境界違反 0／例外 0 |
| G2 | PASS: server 53件 |
| G3 | PASS: PostgreSQL 5件・Node adapter 13件・Cloudflare adapter 8件・workerd 16項目 |
| G4 | PASS: renderer 3件（実 Chromium）・Cloudflare adapter 8件・workerd 合成 Browser Run |
| G5 | PASS: CLI 28件・隔離 tarball 20項目 |
| G6 | PASS: Web 5件・型検査・統合16項目（通信復帰、再試行待ち、エラー表示、desktop／390px） |
| G7 | PASS: pnpm check 323件（skip 0）・統合16項目・workerd 16項目・runtime upgrade 29項目・server tarball 9 packages |

| Step | Command / Expect | 結果 |
| --- | --- | --- |
| G1 | Step 1: 規約・クライアント / ベースライン `2d96e53` が通過していること / pnpm build:packages && node --test packages/protocol/tests/jobs.test.mjs packages/slidock/tests/jobs-client.test.mjs && pnpm check:boundaries / 終了コード 0、全単体テスト合格、パッケージ境界違反 0 件 / Step 2 以降の全作業 | PASS: protocol 5件・client 6件、境界違反 0／例外 0 |
| G2 | Step 2: サーバーコア / G1 に合格していること / pnpm --filter @slidock/server build && pnpm --filter @slidock/server test / 終了コード 0、サーバー単体テスト全件合格、世代順序・エラー制御の確認 / Step 3、Step 4 | PASS: server 53件 |
| G3 | Step 3: 永続化・実行エンジン / G2 に合格していること / HUB_TEST_DATABASE_URL=<local> pnpm --filter @slidock/state-postgres test && pnpm --filter @slidock/adapter-cloudflare test && pnpm --filter @slidock/adapter-node test / 終了コード 0、PostgreSQL 2 ワーカー競合テスト合格、Durable Objects アラーム再開テスト合格 / Step 5、Step 7 | PASS: PostgreSQL 5件・Node adapter 13件・Cloudflare adapter 8件・workerd 16項目 |
| G4 | Step 4: サムネイル / G2 に合格していること / pnpm --filter @slidock/renderer-playwright test && pnpm --filter @slidock/adapter-cloudflare test / 終了コード 0、Playwright ローカルキャプチャ合格、Cloudflare バインディング有無の制御確認 / Step 5、Step 7 | PASS: renderer 3件（実 Chromium）・Cloudflare adapter 8件・workerd 合成 Browser Run |
| G5 | Step 5: CLI コマンド / G1、G3、G4 に合格していること / pnpm --filter @slidock/cli test && pnpm verify:packed-cli / 終了コード 0、CLI 単体テスト合格、パッケージ化済みバイナリ互換性検証合格 / Step 7 | PASS: CLI 28件・隔離 tarball 20項目 |
| G6 | Step 6: Web 画面 / G1 に合格し、U1（モック表示承認）が完了していること / pnpm --filter @slidock/slidock typecheck && pnpm --filter @slidock/workers typecheck && pnpm verify:publication-jobs（Step 6 で作成したブラウザ向け検証ハーネスを順次実行し、Step 7 で統合拡張する） / 型チェック通過、ブラウザコンポーネントのテストケース全件合格 / Step 7 | PASS: Web 5件・型検査・統合16項目（通信復帰、再試行待ち、エラー表示、desktop／390px） |
| G7 | Step 7: 統合・ドキュメント / G1 から G6 までのすべてのゲートに合格していること / pnpm check && pnpm verify:publication-jobs && pnpm verify:runtime-upgrade && pnpm verify:packed-server / 全パッケージ静的解析合格、統合ハーネス全件合格、既存ランタイム固定化検証合格 / 本番展開準備完了の判定 | PASS: pnpm check 323件（skip 0）・統合16項目・workerd 16項目・runtime upgrade 29項目・server tarball 9 packages |
