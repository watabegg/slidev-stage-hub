# TODO: Stage / Hub の実装基盤

> 運用契約: このファイルを再作成しない。in-place 更新のみ。再開時は、まず本ファイル全文と計画書の「Hard Gate」「Out of scope」および現在 Step の本文を再読し、現在位置を1行で宣言してから作業する。

- 計画書: `docs/plans/productization-plan.html`
- goal prompt: `なし`
- 計画検証日時: 2026-10-10（base: main@1ecc2f3。鮮度チェックを実施したら更新する）
- アクティブタスク: Step 4 / T10〜T12 完了。次は Step 5 / T13〜T15（CLIの整理とパッケージ化、未着手）。
- ステータス凡例: `[ ]` 未着手 / `[x]` 完了 / `[!]` blocked（理由必須） / `[-]` cancelled（理由必須）
- 完了条件: 全行が `[x]` または `[-]` に消し込まれていること。未消し込みのままの完了報告は禁止。
- cancelled の扱い: `[-]` にはユーザー指示または計画改訂に紐づく理由が必要。`[-]` が1件でもあれば完了報告は「完了（一部取消あり）」とし、取消一覧を明記する。
- 非冪等タスク（migration、データ更新、外部 API 書き込み）は、実行直前にタスク行へ「実行開始」を追記してから実行する。再開時、先頭の未完了タスクが非冪等なら副作用の有無を確認してから再実行する。
- 計画に無い問題や設計変更が必要な発見があったら、実装範囲を黙って広げない。該当タスクを `[!]` にし、計画書を改訂してから再開する。

## Hard Gate 一覧

| 判定ゲート | 対応ステップ | 実行コマンド（新設/既存） | 合否判定条件 | 実行結果 |
| :--- | :--- | :--- | :--- | :--- |
| Gate G1 | Step 1 | `pnpm check` | exit 0、lint・format:check・typecheck・test・check:boundaries 通過、禁止 import の未登録違反 0 件（owner・解消 Step・理由付きの移行用 allowlist による期限付き例外を許容、例外 0 件必須は Step 8） | PASS 2026-10-09 / 81 tests、例外19件・未登録違反0件。`docs/results/development-foundation.json` |
| Gate G2 | Step 2 | `pnpm test:contracts && pnpm check` | exit 0、positive / negative wire フィクスチャおよび Rust 対応テスト通過、Node 組み込み混入なし | PASS 2026-10-09 / Node 115 tests・Rust共通fixture通過、例外16件・未登録違反0件。`docs/results/protocol-adapter.json` |
| Gate G3 | Step 3 | `pnpm test:hub-service && pnpm verify:hub && pnpm verify:example:watabegg`（`test:hub-service` 新設、`verify:*` 既存） | exit 0、空 CWD / 絶対パス起動成功、失敗時旧成果物保持、watabegg / official テーマ等価性維持 | PASS 2026-10-10 / service 7 tests、Hub 14・watabegg 10 checks、8 decks / 4 groups。`docs/results/hub-service.json` |
| Gate G4 | Step 4 | `pnpm test:stage-tools && pnpm verify:stage`（両スクリプト新設済み、Rust core テスト含む） | exit 0、空 CWD 起動・アトミック切り替え成功、失敗時旧 config / site 保持、remote / auth 照合通過 | PASS 2026-10-10 / Node service 10・Rust 41 tests、空CWDの実WebKit・HTTP/HTTPS・iframe維持を確認。`docs/results/stage-tools.json` |
| Gate G5 | Step 5 | `pnpm test:cli && pnpm verify:packed-cli`（両スクリプト新設予定） | exit 0、引数解決順序・JSON 出力・終了コード整合、packed private tarball からの実行成功 | 未実施 |
| Gate G6 | Step 6 | `pnpm test:web-client && pnpm verify:web-customization`（両スクリプト新設予定） | exit 0、default 表示維持、カスタム entry / style 差替え成功、headless client に副作用なし | 未実施 |
| Gate G7 | Step 7 | `pnpm verify:workers && pnpm verify:workers-stage`（前者は既存名を新パッケージへ接続、後者新設予定） | exit 0、ローカル workerd での publish・catalog ページネーション全件取得・Stage 接続・セッション固定確認 | 未実施 |
| Gate G8 | Step 8 | `pnpm check && pnpm verify:portable && pnpm verify:packed-cli && pnpm verify:workers-stage && pnpm verify:stage`（`verify:portable` 既存、他 Step 新設） | exit 0、クリーン環境での全量回帰通過、パッケージ循環 0、禁止 import 0、allowlist 例外 0 | 未実施 |

Gate の結果は実施後に in-place で更新する。失敗時は依存する後続 Step に進まない。

## Unclear Points 要約

本計画の立案時点において、仕様および方針が未確定である事項は以下の3点のみである。これらはいずれもStep 1から始まる基盤抽出の実装着手をブロックしない。また、未決定事項を勝手に合意済み（Approved）として扱ってはならない。

### 15.1 公開名・ライセンス・配布先
- **Point（論点）**: 将来的な正式公開時のパッケージ名、オープンソースライセンスの種類、および配布先レジストリ（npm、GitHub Packages等）。
- **Why（理由）**: 現在はリポジトリの基盤再設計が目的であり、対外的なパッケージ公開方針やライセンス形態、配布先の決定が完了していないため。
- **Impact（影響範囲）**: 外部への一般公開作業（Public Release）のみをブロックする。リポジトリ内部でのリファクタリング作業には影響しない。
- **Need（確定に必要な要件）**: リポジトリ所有者および関係者による公開ポリシーの策定、正式名称とライセンス条項の決定。
- **Fallback（代替方針）**: 本計画期間中は仮のプライベートパッケージ名（`@slidev-stage-hub/*`）を維持し、外部への公開操作は一切行わない。

### 15.2 正式対応OS・ネイティブパッケージング仕様
- **Point（論点）**: 正式サポートを謳うOSの範囲、およびネイティブバイナリとしての配布パッケージング方式。
- **Why（理由）**: Windows実機やマルチディスプレイ環境でのCI検証基盤、およびコード署名環境が現在未整備であるため。
- **Impact（影響範囲）**: 正式リリースとしてのマルチプラットフォーム動作保証（Release Claim）のみをブロックする。
- **Need（確定に必要な要件）**: Windows環境での実行ログ、2画面環境での表示検証証跡、および署名付きインストーラのビルド手順の確立。
- **Fallback（代替方針）**: 開発ベースラインであるLinux環境での動作確認のみを当面の保証範囲とし、他環境は未検証として扱う。

### 15.3 実Cloudflare環境・Cloudflare Access設定
- **Point（論点）**: 本番Cloudflare環境（WorkersおよびR2）の実接続設定、およびCloudflare Accessの認証ポリシー。
- **Why（理由）**: 検証対象とする Cloudflare および Cloudflare Access 環境の接続先や実測条件が本計画で確定しておらず、実環境での検証が未実施であるため。
- **Impact（影響範囲）**: 実クラウド環境を用いた受け入れ検証（Actual Cloud Acceptance）のみをブロックする。
- **Need（確定に必要な要件）**: 実機検証を行う対象環境の指定、および Cloudflare Access 認証を検証するためのヘッダー条件の確定。
- **Fallback（代替方針）**: ローカルの `workerd` 実行環境とモックヘッダー（Mock Headers）を用い、現行の認証契約を維持した状態で動作検証を行う。

## タスク

- [x] T01: `package.json`, `.oxlintrc.json`, `.oxfmtrc.json`, `scripts/check-boundaries.mjs` tooling/check: 静的検査基盤・スクリプトの整備（Gate: G1）
- [x] T02: `AGENTS.md`, 各パッケージ `AGENTS.md` rules/AGENTS: 開発規約・AGENTSドキュメントの整備（Gate: G1）
- [x] T03: `docs/DEVELOPMENT.md` feature台帳/baseline: 機能台帳の策定と既存ベースライン固定（Gate: G1）
- [x] T04: `packages/protocol/src/contracts/*`, `packages/protocol/src/bridge/*` purecontracts: 純粋なプロトコル・型契約の抽出（Gate: G2）
- [x] T05: `packages/slidev-adapter/src/{inspect-deck,native-manifest,static-runtime}.ts` Slidevadapter: Slidev内部APIの依存切り離しとアダプタ実装（Gate: G2）
- [x] T06: `tests/fixtures/`, `apps/stage/src/types/` Rust/TSfixtures: RustおよびTypeScript共通の検証用フィクスチャ整備（Gate: G2）
- [x] T07: `packages/hub/src/node/{build,config}.ts` hubservice/config: Hubコアサービスおよび設定読み込みの実装（Gate: G3）
- [x] T08: `packages/hub/src/node/{offline,thumbnail,artifacts}.ts`, `src/node/internal/profiles.mjs` profile/offline/thumbpipeline: プロファイル・オフライン・サムネイルパイプライン構築（Gate: G3）
- [x] T09: `packages/hub/` staticparity: 静的生成物の新旧等価性検証（Gate: G3）
- [x] T10: `packages/stage-tools/src/{prepare,connect,config}.ts` stageservices: Stage配信用コアサービス群の抽出（Gate: G4）
- [x] T11: `packages/stage-tools/src/`, `apps/stage/src-tauri/src/{commands,paths,config,server}.rs` hostpaths/atomicprepare: ホストパス解決とアトミックな準備処理（Gate: G4）
- [x] T12: `apps/stage/` stagecompatQA: Stage互換性確認およびQAシナリオ検証（Gate: G4）
- [ ] T13: `packages/cli/src/bin/{hub,stage}.ts` CLIcommands: CLIサブコマンド群の実装（Gate: G5）
- [ ] T14: `packages/cli/src/{args,output,errors}.ts` CLIinterfaceerrors: CLI入出力インターフェースおよびエラーハンドリング（Gate: G5）
- [ ] T15: `packages/cli/` packed導入: パッケージング成果物の導入と実行検証（Gate: G5）
- [ ] T16: `packages/hub/src/client/` client/source: クライアント向けソース同期インターフェース実装（Gate: G6）
- [ ] T17: `packages/hub/src/frontend/` frontendstylesentry: フロントエンド表示スタイルおよびエントリーポイント整備（Gate: G6）
- [ ] T18: `examples/custom-frontend/` customwebQA: カスタムWeb表示のQA検証（Gate: G6）
- [ ] T19: `apps/hub-worker/src/{worker,compiler,storage,versions}.ts` workermove/compilerstore: Worker環境への移行と専用コンパイラストア分離（Gate: G7）
- [ ] T20: `apps/hub-worker/src/native-player.ts`, `apps/hub-worker/runtime/*` catalog/discovery/nativebridge: カタログ・検出機能とネイティブブリッジ連携（Gate: G7）
- [ ] T21: `packages/cli/src/publish.ts`, `apps/hub-worker/` publish/revisionintegration: 公開処理およびリビジョン統合の検証（Gate: G7）
- [ ] T22: `packages/`, `apps/` duplicate撤去/boundaries: 旧重複コード撤去とパッケージ境界の確定（Gate: G8）
- [ ] T23: クリーン環境 cleanregression: クリーン環境での全体リグレッション検証（Gate: G8）
- [ ] T24: `docs/{DEVELOPMENT,HANDOFF}.md`, `.github/workflows/checks.yml`, `TODO.md` docs/results/CI: ドキュメント更新・結果記録・CI統合（Gate: G8）
