# ステージツール開発者ガイド

## 責務と構成

`packages/stage-tools` では Node 側の prepare、connect、config と CLI 側の cwd、env、args が分離されています。Rust host は config、paths、commands、server の各モジュールで構成され、Rust core を正本として扱います。これらを操作する CLI は [cli.md](cli.md) から利用可能です（UI 刷新は別扱いとなります）。

## セットアップと提供機能
本パッケージは外部公開しない非公開ワークスペース `@slidev-stage-hub/stage-tools` として配置され、ステージの準備と接続を担う関数、型定義、およびエラー型を提供します。

```bash
pnpm install --frozen-lockfile
pnpm build:packages
```

エクスポートされる主な要素は `prepareStage`、`connectStage`、`StageToolsError`、および関連する型定義です。

## ステージ準備 API (`prepareStage`)
ローカル配信に必要な資材を検証・配置し、設定ファイルを構築します。暗黙の作業ディレクトリ（CWD）や環境変数への依存を排除するため、APIの引数にはすべて絶対パスを指定します。

```typescript
import { prepareStage } from '@slidev-stage-hub/stage-tools';

const result = await prepareStage({
  site: '/abs/hub/site',
  fixturesRoot: '/abs/slides',
  configPath: '/abs/project/.slidev-stage/local-config.json',
});
// 戻り値: { config, configPath, siteRoot }
```

`receiptPath` は任意であり、明示的な絶対パスで上書きできます。省略した場合は隣接する `site.receipt.json` が既定値として使用されます。

- **パス解決とソース検証**: 公開マニフェスト内の `sourcePath` は引き続き受け付けますが、相対パスが含まれる場合は `legacySourceRoot`（開発ラッパーのHubルート）の明示指定が必要です。マニフェスト不在時の旧フィクスチャへの自動フォールバックは行われず、開発ラッパーから明示的に渡された `fallbackDecks` のみを使用します。依存 Slidev CLI のディレクトリは `dependencyRoot` で明示でき、省略時は `stage-tools` 自体が内包する 53.0.0 を使用します。承認済みソースルート（`approvedSourceRoot`）は `realpath` で検証します。レシートによるソース承認は行われず、`sourceRevision` がノートの編集を妨げることはありません。
- **データ分離と更新保護**: 公開サイトからのノート除去は Hub のビルド処理が行い、`prepareStage` は提供された構築済みサイトをそのままコピーして `PRIVATE_NOTE_` センチネルのみを検証します。ソースパスやリビジョンなどの対応関係は非公開設定にのみ保持されます。配置処理は設定ファイルの親ディレクトリ配下にステージング領域 `versions/<unique>/site` を作成して検証とコピーを行い、権限 `0600` の設定ファイルを不可分（アトミック）に置換して確定版を `siteRoot` に指定します。以前のバージョンは保持され、自動的なガベージコレクションは行われません。設定置換前に処理が失敗した場合は旧設定とサイトがそのまま維持されます。このローカルファイルシステム上のアトミックな置換はポインタ更新を目的としており、停電耐性やネットワークファイルシステムでの動作を普遍的に保証するものではありません。同一設定ファイルに対する並行更新は、共有ロックファイル（`configPath.lock`、権限 `0600`）により拒否されます。これにより Node 側の準備・接続処理と Rust 側のノート保存処理が協調し、古い設定によって最新のサイトポインタが上書きされるのを防ぎます。
- **進捗とエラー処理**: `onProgress` コールバックにより `validate`、`copy`、`promote` の各フェーズが通知されます。処理失敗時は `process.exit` を呼ばず、型付きエラー（`StageToolsError`）で拒否します。

## ステージ接続 API (`connectStage`)
リモート配信サーバーへの接続情報を検証・取得し、設定ファイルに書き込みます。

```typescript
import { connectStage } from '@slidev-stage-hub/stage-tools';

const result = await connectStage({
  origin: 'https://slides.example.com',
  configPath: '/abs/project/.slidev-stage/local-config.json',
  headersFile: '/abs/private/headers.json',
});
// 戻り値: { config, configPath, unsupportedDecks }
```

- **通信仕様**: オリジンには HTTPS、またはリテラルの HTTP ループバックアドレスのみを指定できます。サーバー情報の探索は固定エンドポイント `/native-player.json` に対して行い、応答サイズの上限は 1 MiB、タイムアウトは 10 秒とし、リダイレクトには追従しません。
- **認証と保護**: `headersFile` は同一オリジンであることを検証し、サイズ上限 64 KiB、Unix の非公開アクセス権、シンボリックリンクの不使用を要求します。機密情報のマスク処理は維持されます。既存の認証ファイルは参照のみを行い、複製や新規生成はしません。生成される設定ファイルは権限 `0600` で保護され、ブラウザに機密情報が渡ることはありません。接続処理に失敗した場合は既存の設定ファイルが維持されます。なお、テストで用いるモックヘッダーは実際の Cloudflare Access を検証するものではありません。

## 設定ファイルのスキーマ
新スキーマ（`schemaVersion: 1`）では、トップレベルに `decks`、`notes`、`approvedSourceRoot` を配置し、配信先としてローカルの `siteRoot` またはリモートの `viewerOrigin` のどちらか一方のみを厳密に指定します。`authHeadersFile` はリモート接続時のみ任意で指定できます。

```json
{
  "schemaVersion": 1,
  "decks": [
    {
      "id": "demo",
      "revision": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "entry": "/demo/1",
      "clickTotals": [0]
    }
  ],
  "notes": {},
  "approvedSourceRoot": "/abs/slides",
  "siteRoot": "/abs/project/.slidev-stage/versions/v1/site"
}
```

`schemaVersion` を持たない既存設定も互換性のためサポートされ、ローカル配信時は設定ファイルの親ディレクトリ配下の `site` が推測され、旧来の `viewerOrigin` もリモートとして動作します。Rust内部では `Playback` 列挙型によってローカルとリモートを分離しており、UI向けの設定APIは新設していません。

## 起動コマンドと開発ラッパー
ホスト環境の起動には以下のコマンドを使用します。

```bash
pnpm stage --config /abs/project/.slidev-stage/local-config.json
```

- **起動とパス探索**: `run.sh` は呼び出し元の CWD を変更せずに引数を転送します。ホスト側での設定ファイルの探索順序は、コマンドラインで明示された `--config`、次に `cwd/.slidev-stage/local-config.json` です。コンパイル時の開発成果物へのフォールバックはデバッグビルドでのみ行われ、リリースビルドではチェックアウト先への暗黙のフォールバックは存在しません。
- **相対パスの解決**: `--config` に相対パスが渡された場合は呼び出し元の CWD を基準に解決され、絶対パスであれば空の CWD でも動作します。ソースパスなどの旧来の相対パスは、`realpath` で検証された絶対パスのみを受け付けます。
- **開発ラッパー**: 既存の運用との互換性を保つため、`pnpm stage:prepare` および `node apps/stage/scripts/connect.mjs <origin> [--headers-file ...] [--config ...]` が維持されています。`prepare` は `--site`、`--fixtures-root`、`--receipt`、`--config` を受け付けます。互換用として `apps/stage/artifacts/local-config.json` を既定値として使用しますが、個別プロジェクトでは明示的に `--config` を指定してください。サービス層がプロジェクトの既定パスを独自に決定することはありません。

## ノートデータの保持仕様
- **リモートノート**: Tauri の `app_data_dir()/remote-notes` 配下に識別子 `local.slidev.lab` で保存され、プロジェクト設定から独立して維持されます。
- **ローカルノート**: ソース Markdown 内の HTML コメントとして保持され、リビジョンの競合検証を行います。
- 設定ファイルの配置場所を変更しても、ノートデータの保存領域は自動で移行されません。

## 検証手順
検証結果の件数は `docs/results/final-regression.json` に記録されます。動作の再現と検証は以下の手順で行います。

```bash
pnpm test:stage-tools # Node サービス層テスト、および Rust コア、認証、ホスト設定の検証
pnpm check            # 静的解析と整合性の確認
pnpm verify:stage     # prepare、デスクトップビルド、Chromium プロトコル、WebKit ネイティブ表示の検証
```

- **前提環境**: Linux デスクトップ環境および SDK が必要であり、環境が不足している場合は準備ゲートで明示的に失敗します。
- **スコープ**: WebKit の検証結果は Chromium と明確に区別されます。また、Windows 環境、物理マルチディスプレイ（全 OS）、および実際のクラウド環境は本検証の対象外です。
