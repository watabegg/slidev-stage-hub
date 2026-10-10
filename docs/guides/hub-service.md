# Hub サービス開発者向けガイド

Hub が提供する公開 Node API の開発者向け仕様および利用手順です。ソースコードは公開されていますが、npm によるパッケージ配布は未実施です。

## パッケージの準備と公開 API

本サービスは pnpm workspace 環境で管理されています。公開エクスポートをコンパイルするには、依存関係を固定バージョンで同期した上でビルドを実行します。

```bash
pnpm install --frozen-lockfile
pnpm build:packages
```

パッケージのルート（`.`）および `/node` から主要な Node API をインポートできます。また、ローカルでの配信確認用として `/serve` サブパスから `createServer` が提供されています。

```typescript
import {
  buildHub,
  normalizeHubConfig,
  HubBuildError,
  generateThumbnails,
} from '@slidev-stage-hub/hub';
```

`buildHub` は設定ファイルのパスと進捗コールバックを受け取り、ビルド完了時に `BuildResult` を解決する Promise を返します。

```typescript
const result = await buildHub({
  configPath: '/absolute/hub.config.json',
  onProgress: ({ phase }) => console.log(phase),
});
```

戻り値のオブジェクトには以下の情報が含まれます。

- `output`: 出力先サイトの絶対パス
- `catalog`: カタログ情報（`Catalog`）
- `native`: プレイヤー定義（`PlayerDocument`）
- `receipt`: ビルドレシート情報（`BuildReceipt`）
- `receiptPath`: 出力先に隣接して生成されたレシートファイルの絶対パス
- `diagnostics`: 非公開の診断情報（`{ chunkGraph?: BuildChunk[], groups: Record<string, BuildChunk[]> }`）。コンパイラのモジュールパスを含み、結果オブジェクトのメモリ上のみに保持されます。互換性グラフのビルドでは配信ツリー外に保存され、最終的なオフライン用ハッシュ名ではなくオフライン化前のコンパイラファイル名を示します。

## 設定ファイルの構成（hub.config.json）

設定は JSON 形式で記述し、バージョン番号として `schemaVersion: 1` を指定します。

```json
{
  "schemaVersion": 1,
  "sourceRoot": "./slides",
  "outDir": "./dist/site"
}
```

### パス解決とオプション

- `sourceRoot`: スライドの配置元ディレクトリを指定します。
- `outDir`: サイトの出力先ディレクトリを指定します。
- `theme`: 任意のテーマパッケージディレクトリを絶対パスまたは相対パスで指定します。
- `dependencyRoot`: `@slidev/cli` を含む任意のパッケージディレクトリを指定します。
- デフォルト構成: テーマや依存先を指定しない場合、バンドルされている公式の `@slidev/theme-default`（0.25.0）および Slidev CLI（53.0.0）が適用されます。
- パス解決規則: 設定ファイル内の相対パスは、設定ファイル自身の配置場所を基準に解決されます。Node API に直接オプションを渡す場合は、絶対パスまたは明示的な `baseDir` を渡す必要があり、暗黙のカレントディレクトリ（`cwd`）は参照されません。`configPath` は絶対パスまたは `baseDir` からの相対パスで指定可能です。

### スライドの登録と検出

スライド一覧は `decks` 配列で個別に指定できます。各項目の `entry` は設定ファイルのあるディレクトリからの相対パスです。

```json
{
  "decks": [
    { "id": "talks/demo", "entry": "./slides/demo.md" }
  ]
}
```

`decks` を省略した場合は、`sourceRoot` 配下の Markdown ファイルが再帰的に自動検出されます。ネストした階層にある `slides.md` は、親ディレクトリ名がスライドの `id` に割り当てられます。ただし、`README` や `AGENTS`、および `assets`、`public`、`node_modules` の各ディレクトリは検出から除外されます。公開メタデータの許可リスト（allowlist）は従来通り維持されます。

### バージョン分割プロファイル

任意で `profiles` を定義し、スライドごとに異なる環境を割り当てることができます。

```json
{
  "profiles": {
    "legacy": {
      "dependencyRoot": "./legacy-deps",
      "theme": "./legacy-theme"
    }
  },
  "decks": [
    { "id": "talks/old", "entry": "./slides/old.md", "profile": "legacy" }
  ]
}
```

Slidev は 52.15.2 と 53.0.0 を個別の互換性グループとして共存させており、任意のバージョンに対する動作互換性は保証していません。CLI および Web における entry、source、style の各カスタマイズ機能は実装済みですので、詳細は [cli.md](cli.md) および [web-customization.md](web-customization.md) を参照してください。

## オフライン対応とサムネイル生成

- オフラインモード: `offline` 設定はデフォルトで `true` に設定されています。
- サムネイル生成: ビルド工程の一環としてサムネイルが生成されます。
- ブラウザ実行ファイル: `chromiumExecutable` に絶対パスまたは設定ファイルからの相対パスを指定できます。省略時は `pnpm browser:install` で導入される Playwright の管理ブラウザが使用されます。
- 制約事項: オフライン用のフォントを取得するため、ビルド実行時にはネットワーク接続が必要です。また、スライド内の任意の外部埋め込みコンテンツはオフライン用に変換されません。

## ビルド処理の流れと耐障害性

ビルドエンジンの内部実装は `packages/hub/src/node/internal` 配下にあり、CLI 用のラッパーは `packages/hub/scripts` にあります。フロントエンドの構成とは分離されています。

- プロセス分離: Slidev のグローバル設定が相互に干渉することを防ぐため、処理は子プロセス上で実行されます。
- 進捗フェーズ: `onProgress` には `build`、`thumbnails`、`offline`、`promote` の各段階が通知されます。
- ロックと一時領域: ビルド時は同一ファイルシステム上の親ディレクトリに一時領域（staging）とロックを作成し、同一の出力先に対する並行書き込みを拒絶します。
- サイトの反映とロールバック: 生成完了後に一時領域から本番出力先への配置換え（promote）を行います。通常の配置エラーが発生した場合は、元のサイトとレシートが復元されます。
- クラッシュ時の制約: 2 回の名前変更（rename）操作はハードクラッシュに対してアトミックではありません。障害からの自動復旧は保証されず、残された古いロックファイルの解除には運用者による手動確認が必要になる場合があります。
- エラーハンドリング: ビルド失敗時は `HubBuildError` がスローされ、エラーコード（`CONFIG`、`BUILD`、`OUTPUT_BUSY`、`OUTPUT`、`OUTPUT_RECOVERY`）が設定されます。`OUTPUT_RECOVERY` は保持されたバックアップの場所を示します。なお、すべてのファイルシステム呼び出しが常に正規化されている前提には立たず、網羅的な動作保証は行いません。
- 出力成果物の扱い: 生成された出力ディレクトリ内のファイルを直接手動で編集することは避け、変更が必要な場合は必ず再ビルドを行ってください。

## 非公開レシートと Stage 連携（site.receipt.json）

公開される配信マニフェストには、元のファイルパスの流出を防ぐため `sourcePath` が含まれません。これに代わり、出力ディレクトリと同階層に隣接する形で非公開のレシートファイル `site.receipt.json`（schemaVersion: 1）が生成されます。

- レシートの構造: `output`、`sourceRoot`、およびスライド一覧（`decks: [{ id, sourcePath（絶対パス）, revision, sourceRevision（SHA-256） }]`）が記録されます。
- パーミッションと配置: Unix 環境ではファイル権限 `0600` で作成されます。配信対象のツリー配下には含まれないため、外部にデプロイしてはなりません。
- Stage の検証規則: `stage:prepare` 処理は隣接するレシートを読み取り、スライド、リビジョン、出力先を検証します。既存の `--fixtures-root` による realpath 権限チェックは維持され、レシートに記載された `sourceRoot` 自体がアクセス権限を与えるわけではありません。
- 発表者ノートの編集: 発表者ノート（notes）の編集は許可されています（`sourceRevision` は診断情報の記録を目的としており、変更をロックするものではありません）。
- 互換性: `sourcePath` を含む従来の古い形式のマニフェストも引き続き受け付けられます。

## 検証コマンドと再現手順

動作確認およびテストの実行手順は以下の通りです。これらは動作を再現するための手順であり、未測定の成功を主張するものではありません。

```bash
# Hub 関連の既存エントリポイント
pnpm build:hub
pnpm verify:hub

# サンプル（watabegg 1.2.1）の実行
pnpm build:example:watabegg
pnpm verify:example:watabegg

# Slidev Stage 向けデータの準備
pnpm stage:prepare

# Hub サービスのテスト（空のカレントディレクトリからの明示的設定読み込みや失敗時の状態保持を検証）
pnpm test:hub-service

# 共有リグレッションテスト
pnpm check
```

## 公開ジョブ API と worker

`packages/server` は `GET /api/capabilities`、`POST /api/jobs`、ジョブ状態・一覧・再試行 API、および publish 認証を必要とする手動 `POST /api/jobs/cleanup` を提供します。cleanup はサーバー時刻を基準に完了から30日を経過したジョブを上限付きで整理します。`runPublicationJobCleanup` は `packages/server` から export されるバックグラウンド helper で、optional な `PublicationJobMaintenanceStore.automatic` port と ArtifactStore の delete 操作が利用可能な場合に、保留中のデッキ単位 cleanup を処理します。first-party Node worker と Cloudflare alarm がこの helper を呼び出し、手動 cleanup API とは独立して動作します。既存 custom store は optional port がなくても source-compatible で、自動 cleanup はその場合 skip されます。`HubServerOptions.jobs` には公開コミットとジョブ遷移が同じトランザクションに参加する job store を渡し、`jobsEnabled` で新規受付を停止できます。カスタムアダプターはこの原子性を store 側で保証する必要があり、データベース接続情報の共有だけでは不十分です。`onJobEvent` は phase、attempt、queue age、duration、status、error code を含む安全な構造化 telemetry を受け取ります。Node.js memory 構成ではリファレンスアプリが開発用 worker を同プロセスに起動し、PostgreSQL 構成では `node dist/worker.js` を別プロセスとして起動します。保持期限、dry-run、再実行、削除範囲の詳細は[公開ジョブガイド](publication-jobs.md)を参照してください。

Web クライアント `@slidev-stage-hub/hub/client` から `createPublicationJobClient`、フロントエンド `@slidev-stage-hub/hub/frontend` から読み取り専用 `mountJobStatus` を利用できます。API、認証、status の違い、worker 設定の詳細は[公開ジョブガイド](publication-jobs.md)を参照してください。
