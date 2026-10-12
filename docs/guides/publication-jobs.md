# Slidock 公開ジョブの利用と運用

## CLI から接続して公開する

### 動作要件と開発時の実行
Slidock CLI は Node.js 24.15.0 以上（エンジン要件 `>=24.15.0`）で動作します。リポジトリ直下でのパッケージのビルドや開発中のコマンド実行には、`pnpm build:packages` と `pnpm slidock ...` を使用します。配布用の tarball はプライベートな成果物として管理されており、npm には公開されていないものとして扱います。

なお、CLI のコマンド契約は実装と照合済みですが、検証の実施状況はリポジトリの[検証記録](../results/publication-jobs.json)を参照してください。また、実クラウドへのデプロイ、クラウド実環境での受け入れ、および本番認証を通した受け入れ検証は未実施として扱います。

### 接続プロファイルの管理と認証設定
Slidock への接続設定は、リモート接続プロファイルを用いて管理します。CLI は既定で実行ディレクトリの `./hub.remote.json` を参照しますが、`--remote-config PATH` オプションを指定して別の設定ファイルを読み込むことも可能です。

プロファイルは `schemaVersion: 1` に準拠し、以下の構造を持ちます。
```json
{
  "schemaVersion": 1,
  "origin": "https://hub.example",
  "defaultDeckId": "talks/intro",
  "headersFile": "./auth-headers.json"
}
```
※ `defaultDeckId` および `headersFile` は任意項目です。`defaultDeckId` は `publish` や `jobs` コマンドで `--id` を省略した際に使用されるデッキ ID を指定し、`headersFile` は任意の認証ヘッダー設定を指定します。

設定項目とパスの解決ルールは以下のとおりです。
- **origin の指定**: 接続先には HTTPS のルート URL、または開発・テスト用の正確な HTTP ループバックオリジンを指定する必要があります。
- **パス解決の基準**: プロファイル内の `headersFile` は、プロファイルファイル自体の配置ディレクトリを基準に解決されます。一方、CLI 引数で渡すファイルパスフラグや、スライド本体（source）および添付アセット（assets）のパスは、コマンドを呼び出した際のカレントワーキングディレクトリ（cwd）を基準に解決されます。なお、CLI のオプションフラグは常にプロファイルの設定値より優先されます。
- **認証情報の保護**: 認証ヘッダーを付与する場合は、特定の origin に紐づいた専用の private JSON ファイルを用意し、Unix パーミッション mode `0600`（所有者のみ読み書き可能）に設定した上で `headersFile` に指定します。認証トークンをコマンドライン引数に直接指定すると、シェルの実行履歴やプロセス一覧から漏洩する危険があるため、引数には含めず独立した保護ファイルから読み込ませます。

### 接続の初期化と診断（slidock init / slidock doctor）
安全な接続環境の準備と状態確認のために、以下のコマンドが用意されています。

- **`slidock init --origin URL [--remote-config PATH]`**
  指定した接続先 origin を含む、`schemaVersion: 1` 形式の新しいプロファイル（`{ origin }`）を作成します。既存の設定を不用意に上書きして失わないよう、対象ファイルがすでに存在する場合は作成を行いません。
- **`slidock doctor [--remote-config PATH] [--origin URL] [--headers-file PATH]`**
  設定プロファイル、認証ファイル、およびサーバーの `GET /api/capabilities` エンドポイントを読み取り専用で診断します。API 応答を検証してジョブ機能への対応状況を報告しますが、この診断はサーバー側のワーカープロセスやレンダリング用ブラウザーの実稼働までを保証するものではありません。

### スライドの公開（slidock publish）
スライドを Slidock に登録して公開するには `slidock publish` コマンドを使用します。

```sh
slidock publish --id ID --source PATH [--assets PATH] [--origin URL] [--headers-file PATH] [--remote-config PATH] [--thumbnail auto|none] [--no-wait] [--timeout 300] [--require-jobs] [--job UUID] [--json]
```

#### 非同期ジョブへの投入と同期フォールバック
従来の同期 API（`POST /api/decks/:id`）との互換性を保ちながら、サーバーの capabilities でジョブ機能が有効と確認された場合は、既定で `POST /api/jobs` にリクエストを投入して非同期で公開処理を行います。`--origin` や `--headers-file` を指定すると、プロファイルの設定を上書きできます。

サーバーがジョブ API に未対応である場合（capabilities の取得結果が 404）や、ジョブの受け付けが無効と報告された場合は、`--require-jobs` オプションが指定されていない限り、標準エラー出力（stderr）で通知した上で旧来の同期 API にフォールバックします。旧同期 API にフォールバックした場合、同期的な公開処理が完了するまでコマンドは待機（ブロック）し、`--no-wait` は効果がありません。また、ジョブ待機用の `--timeout` オプションはレガシーリクエストには引き継がれず、独自の 10 秒タイムアウトで処理されます。なお、フォールバック時はサムネイルの自動生成は行われません。

ただし、capabilities のリダイレクトや 404 以外の HTTP エラー、認証失敗、ネットワーク障害、および不正な capability 応答が発生した場合はフォールバックせず、エラーとして処理を中断します。

#### 受付票（receipt）によるジョブ追跡と再送
非同期ジョブを投入する際、ネットワーク切断や予期せぬ中断が発生しても安全に追跡や再送を行えるよう、CLI は送信前に UUIDv4 形式のジョブ ID と 32 バイトの閲覧トークン（view token）を自動生成します。

そして、OS の状態管理領域（`XDG_STATE_HOME/slidev-stage-hub/receipts`。環境変数未指定時は Linux/macOS では `~/.local/state/slidev-stage-hub/receipts`、Windows では `%APPDATA%/slidev-stage-hub/receipts`）へ受付票（receipt）を保存します。Unix 系 OS ではディレクトリを mode `0700`、各受付票を mode `0600` に制限します。

受付票には `origin`、`deck ID`、`job ID`、`view token`、およびリクエスト内容の同一性を確認するための `request hash` が記録されます。機密情報の保護と容量節約のため、Markdown 本文、発表者ノート、およびアセットの実体データは受付票に含めません。

ネットワーク障害時などに `--job UUID` を指定して再送処理を行う場合は、ローカルに保持されている受付票とリクエストのハッシュ値が完全に一致する場合にのみ再送が許可されます。対応する受付票がローカルにない場合は新規ジョブを作らず、コマンドは失敗します。

#### ジョブの監視とタイムアウト
ジョブ投入後、CLI は既定で処理の完了まで最大 300 秒間サーバーを監視（watch）します。待機時間は `--timeout` オプションで 1〜86400 秒の範囲で変更できます。即座に制御を戻したい場合は `--no-wait` オプションを指定することで、サーバーへの受け付け完了直後にコマンドを終了できます。

なお、クライアント側で監視を中断したりタイムアウトが発生したりした場合でも、サーバー側で受け付け済みのジョブは中断されず処理が継続します。

### ジョブの追跡と再試行（slidock jobs）
投入した公開ジョブの進捗確認や再試行には `slidock jobs` サブコマンドを使用します。

#### 状態確認と監視（読み取り権限）
- `slidock jobs status --id ID --job UUID`
- `slidock jobs watch --id ID --job UUID`

これらのコマンドは、スライドの公開権限（publish token）だけでなく、投入時にローカルの受付票へ記録された閲覧トークン（view token）を用いても照会可能です。これにより、公開権限を持たない環境からでも進捗や結果を安全に追跡できます。

#### ジョブ一覧の取得と再試行（公開権限が必要）
- `slidock jobs list --id ID [--limit N] [--cursor CURSOR]`
- `slidock jobs retry --id ID --job PARENT_UUID --stage thumbnail|all [--timeout 300] [--no-wait]`

スライドの管理に関わるこれらの一覧取得と再試行には、公開認証（publish 認証）が必要です。

`retry` コマンドは元の親ジョブ（PARENT_UUID）に対して新しいジョブ ID を持つ子ジョブを生成し、既定ではその完了まで待機します。再試行の対象範囲は `--stage` オプションで選択します。
- `--stage all`: 公開結果を持たない `failed` 状態のジョブと保存済み入力を対象に、公開処理全体を再実行します。
- `--stage thumbnail`: 完了済みで公開結果があり、サムネイルが `ready` ではない親ジョブを対象に、レンダラーが利用可能な場合にサムネイル処理のみを再試行します。`failed` に加え、サムネイルが利用不可（`unavailable`）または `--thumbnail none` でスキップ（`skipped`）された場合も対象です。

`--stage all` を再試行できるのは、その親ジョブが最新世代（generation）の場合に限られます。後から新しい世代が始まっていると API は HTTP 409（`superseded`）を返します。その場合は古い入力で再試行せず、新しい公開ジョブを送信してください。

#### 完了ジョブの整理（`slidock jobs cleanup`）
保持期限を過ぎたジョブは、次のコマンドでデッキ単位に整理できます。

```sh
# 対象のプレビュー（既定で dry-run）
pnpm slidock jobs cleanup --id talks/intro

# 結果を確認してから実行
pnpm slidock jobs cleanup --id talks/intro --apply
```

`--limit N` は1回に処理する上限で、既定値は100、指定できる範囲は1〜100です。コマンドは1回だけ API を呼び出します。dry-run の `jobs` はそのバッチの候補一覧です。`more` は後続のジョブまたは入力削除作業が残ることを、`pendingInputs` は保留中の入力削除件数を示します。一度の要求では全履歴の合計件数を返しません。対象が残る場合は CLI が再実行コマンドを案内するので、案内に従って `more` が false になり、`pendingInputs` もなくなるまで繰り返してください。`--apply` はジョブ履歴を削除するため、プレビュー結果を確認してから指定します。`--origin`、`--remote-config`、`--headers-file` は他の `slidock jobs` コマンドと同様に使えます。認証には publish 権限が必要で、ジョブ閲覧トークンは使えません。ローカルの CLI receipt は変更されません。

サーバーは `POST /api/jobs/cleanup` を提供します。リクエストは `{deckId, apply?, limit?}` 形式で、保持期限の判定にはサーバー時刻を使います。応答には期限、対象ジョブ ID と完了時刻、削除数、保留中の入力削除数、続きがあるかを含み、ソースやトークンは含みません。ジョブストアの保守機能または ArtifactStore の削除機能がない場合は、変更前に `503 JOB_CLEANUP_UNAVAILABLE` を返します。削除に失敗した入力が残ると `pendingInputs` が正の値になり、`--apply` は `JOB_CLEANUP_PARTIAL` で非ゼロ終了します。保留作業を再試行するには、案内されたコマンドをもう一度 `--apply` 付きで実行してください。新規受付を `HUB_JOBS_ENABLED=false` で停止していても、ジョブストアが構成されていれば整理を実行できます。

### 出力仕様と終了コード
自動化スクリプトや外部ツールとの連携のため、出力と終了コードの仕様が明確に整理されています。

#### 出力形式と `--json`
`--json` を指定した場合、標準出力（stdout）には従来どおり単一の JSON エンベロープ形式（`{ ok, command, data/error }`）のみが出力されます。進捗表示、受付済み job ID、確認用リンクなどは標準エラー出力（stderr）に出力されるため、標準出力をそのままパイプ等で JSON として安全にパースできます。

#### 終了コードと状態区分
- **`partial`（終了コード 1 `PARTIAL_SUCCESS`）**: スライド自体の公開は成功したものの、サムネイル生成が失敗または利用不可になった状態です。公開されたリビジョンはサーバー上に反映されて結果に残りますが、完全な成功ではないため終了コード 1 を返します。公開確定前に失敗してリビジョンが反映されない `failed` とは明確に区別されます。
- **watch 中の Ctrl+C（終了コード 130）**: ローカルでの監視処理のみを終了します。サーバー側のジョブは継続して実行されます。
- **タイムアウト（終了コード 1 `JOB_WAIT_TIMEOUT`）**: 指定した待機時間内に完了しなかった場合に返されます。後から監視を再開するためのコマンドが画面上に案内されます。
- **`--no-wait` 指定時**: 新規に受け付けられた未完了ジョブは処理の完了を待たずに終了コード 0 で終了しますが、リプレイなどですでに終端状態（`succeeded`、`partial`、`failed`、`superseded`）にあるジョブが返された場合は、`--no-wait` を指定していてもその状態に応じた通常の終了コードが返されます。

### 代表的な利用例
以下は、パッケージのビルドからプロファイル作成、公開、およびジョブ管理に至る代表的なコマンド例です。

```sh
# パッケージのビルド
pnpm build:packages

# リモート接続プロファイルの初期化
pnpm slidock init --origin https://hub.example

# 接続状態と機能の事前診断
pnpm slidock doctor

# スライドの公開（処理完了まで待機）
pnpm slidock publish --id talks/intro --source slides/intro.md

# 非同期ジョブとして投入し、受け付け後にすぐ終了
pnpm slidock publish --id talks/intro --source slides/intro.md --no-wait

# ジョブの進行状況を監視
pnpm slidock jobs watch --id talks/intro --job 550e8400-e29b-41d4-a716-446655440000

# ジョブの最新状態を確認
pnpm slidock jobs status --id talks/intro --job 550e8400-e29b-41d4-a716-446655440000

# デッキのジョブ一覧を取得
pnpm slidock jobs list --id talks/intro

# サムネイルが未生成の公開ジョブを再試行
pnpm slidock jobs retry --id talks/intro --job 550e8400-e29b-41d4-a716-446655440000 --stage thumbnail
```

### 関連資料
CLI の詳細な共通仕様や、サーバーおよびプラットフォーム側の設定については、以下のドキュメントを参照してください。

- CLI の共通仕様と詳細なコマンド体系: [cli.md](cli.md)
- サーバーの配置やプラットフォーム構成: [platforms.md](platforms.md)
- Cloudflare Workers 固有の設定や制限事項: [workers.md](workers.md)
- Web ライブラリの拡張やフロントエンドの統合: [web-customization.md](web-customization.md)
- 非同期ジョブ機能の採用理由や設計判断の記録: [DECISIONS.md](../DECISIONS.md)

## ジョブ API と状態遷移

### 公開受付の処理フロー
スライド公開のジョブ化は、CLI から `POST /api/jobs` へ HTTP リクエストを送信することで開始します。Slidock ではクライアントが R2、S3、GCS などのオブジェクトストレージへ直接書き込む方式は採用しておらず、オブジェクトストレージのイベント通知も使用しません。また、webhook も実装していません。

サーバーはリクエストを受け付けると、まず元のソース（source）を非公開の ArtifactStore へ保存します。続いて、公開状態とジョブ情報を同じトランザクション内に記録し、クライアントに HTTP 202 と job ID を返します。Cloudflare では Durable Object の alarm、Node/PostgreSQL ではワーカーのポーリングがジョブを実行します。

### エンドポイントと認証
公開ジョブの操作および進捗確認には、以下のエンドポイントを使用します。

- `GET /api/capabilities`
- `POST /api/jobs`
- `GET /api/jobs/:jobId?deckId=...`
- `GET /api/decks/:deckId/jobs`
- `POST /api/jobs/:jobId/retry?deckId=...`
- `POST /api/jobs/cleanup`

各操作には用途に応じた認証が必要です。ジョブの登録（submit）、再試行（retry）、一覧取得（list）には publish 認証が求められます。ジョブの状態取得（status）は、publish 認証のほか、対象ジョブの閲覧専用トークンである `X-Slidock-Job-View` を使ってアクセスすることも可能です。

なお、API レスポンスおよび公開スナップショットには、Markdown 本文、発表者ノート、内部の生のエラースタック（error stack）を含めない仕様となっています。

### 状態とフェーズ
ジョブ全体の処理状態を表す status と、進捗段階を表す phase は、互いに独立した値として管理されます。

phase には以下の値があります。
- `runtime`
- `compile`
- `store`
- `publish`
- `thumbnail`

このうち `compile` および `store` のフェーズでは、実測できるスライド数とオブジェクト数のみを表示し、推定パーセント値（percent）は算出しません。

status には以下の値が割り当てられます。
- `queued`: ジョブが登録され、実行待ちの状態。
- `running`: 処理が実行中の状態。
- `retry_wait`: 一時的な失敗の後、再試行を待機している状態。
- `succeeded`: 全工程が成功した状態、または `--thumbnail none` を指定してサムネイル生成をスキップした場合の状態。
- `partial`: スライドのリビジョン（slide revision）がすでに公開コミットされた後、サムネイル生成の失敗またはサムネイル機能の利用不能が発生した状態。すでに公開されたスライド自体は維持されます。
- `failed`: 公開コミット前に処理が停止した場合の状態。
- `superseded`: 先行世代の未コミットジョブが存在する状態で、新しい公開受付が行われた場合に遷移する状態。

### 実行制御と自動再試行
バックグラウンドで処理を行うワーカーは、少なくとも 1 回の実行（at-least-once）を前提として動作します。排他および競合制御には、lease（リース）と世代フェンシング（generation fencing）を使用します。受付時にはランタイム ID を記録しますが、ランタイムファイルの実体は実行時までアーカイブされません。そのため、実行時にランタイムの変更が検知された場合は、公開確定前に `RUNTIME_CHANGED` エラーとして処理が失敗します。

また、短期的な失敗に対しては、あらかじめ定められた有界回数の範囲内で自動リトライを行います。運用者向けには、機密情報を含まない安全なライフサイクルイベント（フェーズ、試行回数、処理時間、キュー滞留時間、ステータス、エラーコード）が構造化テレメトリとして出力され、Node.js および Cloudflare の各アダプター経由で構造化 JSON ログとして監視できます。

## 確認画面とアクセス制御

CLI から公開ジョブを投入すると、受け付け応答をもとに進捗確認用のリンクが生成されます。API が返す `statusUrl` と `viewPath` はオリジン相対パスであり、クライアント向けの絶対 URL は返されません。CLI は設定済みの Slidock オリジン（プロファイルまたは `--origin`）を基準に URL を解決し、閲覧トークンをフラグメントに付加します。利用者はこのリンクを通じて Web 画面からジョブの進行状況を確認できます。

### 確認リンクの形式と閲覧権限

CLI が受け付け応答から生成する確認リンクは、以下の形式をとります。

`/_hub/jobs?deckId=...&jobId=...#view=<token>`

このリンクは、単一のジョブに関する読み取り専用スナップショットを最大7日間閲覧できる capability として機能します。安全性を考慮し、権限は進捗確認のみに限定されており、以下の処理や情報取得は許可されません。

- スライドの公開
- ジョブの再試行
- source や notes の取得

`token` またはリンクを知っている人物は、7日間にわたり該当ジョブの job status を閲覧できます。そのため、このリンクと `token` は秘密情報として取り扱う必要があります。

### ブラウザーでのトークン管理

トークンの漏洩を防ぐため、`token` は URL のフラグメントに配置されます。

標準進捗画面は、サーバーへの fetch を行う前に `history.replaceState` で現在の URL からフラグメントを取り除き、トークンを `sessionStorage` に保存します。この処理により画面からの後続 API リクエスト URL にトークンを含めずに済みますが、ブラウザー履歴全体、クリップボード、共有先、あるいは初回のアクセス URL があらゆる仕組みから消去されることを保証するものではありません。閲覧リンク自体を秘密情報（bearer secret）として扱ってください。

### 通信方式と切断時の状態維持

進捗画面におけるジョブ状態の確認には、HTTP ポーリングを使用します。SSE や WebSocket は使用しません。

通信が切断された場合は、直近に取得したジョブの状態表示を保ちながら、再接続を試行している旨の表示を維持します。これにより、一時的なネットワーク障害が発生しても、直前の進捗状況を見失わずに確認を継続できます。

## 実行基盤、運用、制約

### アーキテクチャと設計判断
ジョブ管理の中核を担う `packages/server` は、特定のクラウド基盤向け SDK に依存せず、共通のジョブ API と実行機構（ランナー）を提供します。

公開の確定とジョブ状態は同じトランザクションで更新し、外部メッセージブローカーや cron は追加しません。first-party store は terminal publication finish と同じトランザクションでデッキ単位の cleanup 要求を記録し、Node worker または既存の Durable Object alarm が処理します。起動条件と日次上限は「自動クリーンアップ」に記載します。手動の `slidock jobs cleanup` も引き続き利用できます。
- **Cloudflare Workers**: 既存の `DeckVersions` Durable Object の SQLite トランザクション内で公開状態とジョブを扱い、Durable Object のアラーム（alarm）によってワーカーを起床させます。
- **Node.js**: 公開ストアとジョブストアを同一の PostgreSQL トランザクションに参加させ、ワーカーは `SKIP LOCKED` による行ロックを使ったポーリングでジョブを取得します。

公開の確定（commit）とジョブ状態を同一のトランザクションで更新できる永続化境界を設けることで、両者がアトミックに結合され、世代の不整合を防ぎます。単にデータベースの接続情報（credentials）を共有するだけでは、この原子性は保証されません。カスタムアダプターを実装する場合も、公開コミットとジョブ遷移が同じトランザクションに参加するストアが必要です。Webhook や Cloudflare R2 のイベント通知キューはジョブ受付時の検証や重複排除（冪等性）の仕組みを代替しません。プロバイダー固有のアップロードや通知フローを増やさず、既存の公開ストアと起床機構を使う理由は[設計判断](../DECISIONS.md)に記録しています。

### Node.js 環境での運用
Node.js 環境で `apps/slidock-server` を運用する場合、利用するデータストアによって役割と起動構成が異なります。サーバー配置やコンテナ運用の詳細な手順は[platforms.md](platforms.md)、CLI の共通仕様は[cli.md](cli.md)を参照してください。

#### ローカルインメモリ・ファイルシステム構成
インメモリおよびローカルファイルシステムを用いた構成は、ローカル開発や使い捨ての検証用途を対象としており、本番環境の永続化には利用できません。環境変数 `HUB_JOBS_ENABLED=true` を設定すると、API と同一の Node.js アプリケーション内でワーカーが起動してジョブを処理しますが、アプリケーションの再起動によってメモリ上の状態はすべて失われます。

#### PostgreSQL 構成
本番環境での永続化には PostgreSQL を使用します。環境変数に `HUB_PUBLICATIONS=postgres` および接続先を示す `HUB_DATABASE_URL` を指定します。
- **マイグレーションの事前適用**: サービスを開始する前に、既存の `hub_publications` テーブルを用意した上で、追加マイグレーション [`002-publication-jobs.sql`](../../packages/state-postgres/migrations/002-publication-jobs.sql)、[`003-job-retention.sql`](../../packages/state-postgres/migrations/003-job-retention.sql)、[`004-job-cleanup-schedule.sql`](../../packages/state-postgres/migrations/004-job-cleanup-schedule.sql) を順に適用します。`HUB_DATABASE_INIT=true` で Node アプリを起動し、ジョブストアが構成されている場合は基底 publication schema と job schema の両方が初期化されます。本番テンプレートは `HUB_DATABASE_INIT=false` のため、事前のデータベース初期化は運用者が行います。
- **プロセスの分離**: API プロセス（`start.ts`）とワーカープロセス（`node dist/worker.js`）を別プロセスとして起動します。両プロセスは同一の PostgreSQL データベースと成果物ストア（ArtifactStore）を共有します。API プロセス単体では PostgreSQL ジョブを処理しません。
- **並列処理数**: ワーカープロセスの既定の並列数は 2 です。
- **新規受付の停止とドレイン**: `HUB_JOBS_ENABLED=false` を設定すると、新規ジョブの受付を停止しつつ、すでに保存されているジョブの処理（ドレイン）を継続できます。なお、`HUB_JOBS_ENABLED=false` の状態であってもストア自体は構成されます。

### Cloudflare Workers 環境での運用
Cloudflare Workers 環境では、既存の `DeckVersions` Durable Object の SQLite トランザクション内で公開状態とジョブを扱い、Durable Object のアラームでワーカーを起床させます。クラス名と Wrangler migration v1 は維持し、内部 SQLite スキーマを v4 に進めます。v4 初期化後は旧 v3 schema を前提とする Worker code に戻せません。無停止移行や rollback は検証されていません。既存 alarm は公開処理後に自動クリーンアップも試行します。

新規ジョブの受付制御には、環境変数または Wrangler の設定変数 `HUB_JOBS_ENABLED` をトグルとして使用し、新規受付の可否を切り替えます。Cloudflare 環境および Wrangler の固有設定の詳細は[workers.md](workers.md)を参照してください。

### サムネイル自動生成レンダラーの設定
スライド公開時のサムネイル自動生成機能（レンダラー）はオプションであり、利用環境に応じた設定が必要です。

#### 環境ごとの設定要件
- **Cloudflare Workers**: 自動サムネイル生成には、Cloudflare Browser Rendering の `BROWSER` バインディングと Wrangler 変数 `PUBLIC_ORIGIN` の両方が必要です。`BROWSER` が設定されていてもオリジンが指定されていない場合、サムネイル処理は `unavailable` になります。
- **Node.js ワーカー**: 以下の環境変数を明示的に指定する必要があります。
  - `HUB_THUMBNAIL_RENDERER=playwright`: レンダラーとして Playwright を指定します。
  - `HUB_CHROMIUM_EXECUTABLE=/absolute/path/to/chromium`: 利用する Chromium 実行ファイルの絶対パスを指定します。
  - `HUB_PUBLIC_ORIGIN`: レンダラーが描画対象のスライドへアクセスする際に使用する、信頼できるルートオリジンを指定します。

Docker イメージのビルド処理では、Playwright によるブラウザの自動ダウンロードはスキップされます。Dockerfile から直接ビルドする場合は `INSTALL_CHROMIUM=true`、Compose からビルドする場合は `HUB_INSTALL_CHROMIUM=true` を指定して Chromium を明示的に含めます。実行時にレンダラーを動作させるには、上記の環境変数を設定して明示的に有効化（オプトイン）する必要があります。

#### オリジンの使い分けと未設定時の動作
- **オリジンの扱い**: Node.js の `HUB_PUBLIC_ORIGIN` は Playwright が描画対象のスライドへアクセスする際の接続先としてのみ使用されます。API は閲覧リンクをオリジン相対パスで返し、CLI がプロファイルまたは `--origin` で設定された Slidock オリジンを基準に解決します。
- **レンダラー未設定時の動作**: レンダラーが設定されていない場合、サムネイルの自動生成ジョブは `partial`（一部完了）として終了し、結果は利用不可（unavailable）になります。ただし、サムネイルが生成されなくても、公開されたスライド自体は公開状態（live）を保ちます。Web ライブラリ側の表示拡張については[web-customization.md](web-customization.md)を参照してください。

### 30日保持と削除範囲
削除対象は、`succeeded`、`partial`、`failed`、`superseded` のいずれかで完了し、`finishedAt` がサーバー時刻から30日以上前のジョブです。`queued`、`running`、`retry_wait` は対象になりません。親ジョブは参照中の子ジョブが残る間は保持され、共有入力も残っているいずれかのジョブから参照されている間は削除されません。親子関係によって複数回の実行が必要になることがあります。

`--apply` はジョブメタデータを削除すると同じトランザクションで、再利用を防ぐ最小限の tombstone と、未参照の private input を消す耐久性のある outbox を記録します。削除済み UUID の再送・再試行には `410 JOB_EXPIRED` を返します。ストレージへの削除はメタデータのトランザクション後、同じ cleanup API 呼び出し内で試行されます。失敗分は outbox に残り、後続の `--apply` で再試行できます。

対象は厳密に `private/jobs/<deckId>/<UUIDv4>.json` の未参照入力だけです。未受理の孤立アップロード、公開リリース、サムネイル、ランタイムアーカイブ、current pointer、generation、ローカル receipt は削除しません。S3/GCS のバージョニング、soft delete、保持ポリシー、バックアップによってストレージ上にデータが残ることがあるため、この処理は物理消去を保証しません。クラウド権限とストレージごとの削除動作は[プラットフォームガイド](platforms.md)を参照してください。

### 自動クリーンアップ

first-party job store は `kind=publication` のジョブが `finish` によって terminal 状態へ遷移すると、同じトランザクションでデッキ単位の cleanup 要求を記録します。`retry_wait`、thumbnail-only retry、旧同期 publish はこの要求を発生させません。期限切れ ID の遅れて到着した submit/retry が private input の削除待ちを再登録した場合も、同じ保留処理が入力削除を再試行します。マイグレーション時点ですでに完了している履歴は自動的には queue されません。

最初の要求はすぐに処理可能です。その後はデッキごとにローリング24時間あたり最大1回、最大100件の terminal leaf job と最大100件の保留中 input delete を処理します。複数の完了要求は合流し、次回の実行を後ろへずらしません。バッチの残作業や一時的な失敗があれば要求を保留し、後続の publication がなくても次の日次枠で再試行します。一方、完了したバッチでレコードが削除されたか空バッチであったかを問わず、残作業がなくなってクリーンアップが正常に完了したデッキに対しては定期的な再訪を行わず、全デッキ対象の periodic sweep も行いません。自動クリーンアップの失敗は publication の terminal status を変更しません。

Node worker は各 publication attempt の後と idle poll 時に cleanup を await して試します。PostgreSQL 構成では API と別に `node dist/worker.js` を起動してください。Cloudflare は既存の Durable Object alarm を使い、publication の後に cleanup を試行します。外部 cron や新しい queue service は必要ありません。メモリストアは開発用で、スケジュールもジョブ状態と同様にプロセス再起動後は残りません。

マイグレーション前の完了履歴は、そのデッキで新たな terminal publication finish が発生すれば後続の cleanup 対象になり得ます。新たな publication がないデッキを整理する場合は、手動の `slidock jobs cleanup` を使ってください。手動 cleanup は自動の日次上限を消費しません。`PublicationJobMaintenanceStore.automatic` は optional なので、custom store がこの port または ArtifactStore の delete 操作を実装しない場合、自動 cleanup は安全のため skip します。

### 運用上の制約と検証状況

#### システムの制約事項
本機能の運用にあたっては、以下の制約事項を考慮する必要があります。
- **自動保持の範囲**: first-party worker は terminal publication finish で要求されたデッキを日次上限付きで整理します。古い idle deck は新たな publication がなければ自動走査されないため、手動の `slidock jobs cleanup` を使ってください。未受理の孤立入力、公開成果物、サムネイル、ランタイム、CLI のローカル receipt は対象外です。
- **管理・操作機能の制限**: ジョブのキャンセル機能、サイト管理者用の管理コンソール、WebSocket や SSE（Server-Sent Events）を用いたリアルタイム通信、ロールバック機能、およびブラウザからの直接アップロード機能は提供されていません。
- **ブラウザの自動取得不可**: オプションのレンダラー機能は、実行時にブラウザを自動でダウンロードしません。

#### 検証手順と受け入れ状況
ローカル開発におけるジョブ機能の検証手順として、ルートディレクトリで実行可能な `pnpm verify:publication-jobs` コマンドが用意されています。検証の実施状況はリポジトリの[検証記録](../results/publication-jobs.json)を参照してください。

なお、実際の AWS、GCP、Cloudflare などのクラウド実環境へのデプロイや、Cloudflare Access などの本番認証を通した受け入れ検証は実施されていません（未実施として扱います）。クリーンインストールと手動保持の検証は[フォローアップ記録](../results/publication-jobs-followup.json)、自動保持の検証状況は[自動保持記録](../results/publication-jobs-auto-retention.json)を参照してください。
