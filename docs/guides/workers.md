# Workers 版 Hub ガイド

## 構成とローカル開発環境

Workers 版 Hub は `apps/hub-worker` に配置されています。`src` は Worker および Durable Objects 向けの実装で厳格な型定義（strict TypeScript）を用い、`runtime` はブラウザ向けの Vue と Slidev、`scripts` は Node.js 限定で構成しています。過去の検証結果は `packages/hub/bundle-sharing/experiments/workers/results` に残り、実験用スクリプトは `docs/legacy/workers-tools` に保管されています。

ローカル環境の構築と起動は以下のコマンドで行います。クラウドへの自動デプロイは行われません。

```bash
pnpm install --frozen-lockfile
pnpm build:workers
pnpm --filter @slidev-stage-hub/workers dev
```

起動後は既定で `http://127.0.0.1:4180` で待機し、ローカルの R2 と Durable Objects に成果物や状態を永続化します。テーマには Slidev 公式のデフォルトテーマを使用します。

## スライドの発行とリビジョン管理

スライドの発行には CLI を使用します。`pnpm build:workers` の実行後、以下の発行コマンドを実行します。

```bash
node packages/cli/dist/bin/hub.js publish --origin http://127.0.0.1:4180 --id demo/intro --source examples/workers/slides.md
```

保存先は自動推測されないため、明示的な引数指定が必要です。接続先オリジンは HTTP ループバックまたは HTTPS に限られます。リクエスト本文は 512KiB の JSON、スライド数は最大 100 枚までであり、任意のバイナリ送信には対応していません。オプションとして `--assets path/to/assets.json`、`--headers-file path/to/auth.json`、`--json` を指定できます。アセット JSON はファイル名からテキストへのオブジェクトであり、キーには ASCII のスラッシュ区切りパス（拡張子は `.svg`、`.txt`、`.css` 限定）、値には文字列を指定します。認証は任意であり、指定する場合は Stage のオリジン紐付けに対応したファイル権限 0600 のヘッダーファイルを使用します。

公開成果物からはソースノートが除去され、プライベートストレージが HTTP 経由で公開されることはありません。テーマ、レイアウト、コンポーネントは事前ビルド済みランタイムに含まれる必要があります。未対応の数式やコード描画に関する警告は残り、Slidev の完全な互換性は保証されません。

ソース、アセット、コンパイラ、ランタイムプロファイルの変更により、不変なリビジョンが生成されます。保存処理は書き込み、インデックスマーカー配置、Durable Objects コミットの順序で実行され、最新の開始処理が優先されます。競合時は 409（superseded）が返され、書き込み失敗時に既存リビジョンが置き換わることはありません。ストレージでは R2 の `FILES`、Durable Objects の `VERSIONS` および `DeckVersions` を扱い、migration v1 と SQL の状態は維持されます。

## カタログ提供と Stage 連携

レガシーな `/api/catalog` は維持され、`/catalog.json` ではカーソル（任意）付きの protocolCatalog v1 を提供します。`@slidev-stage-hub/hub/client` の `createWorkersCatalogSource()` は全ページを取得して共通の `mountHub` に渡します。最大ページ数は既定で 100 であり、上限超過、ループ検知、応答異常の発生時は失敗し、不完全な結果を暗黙に返すことはありません。サムネイル欠落時は代替表示を行います。`/native-player.json` v2 では再生リビジョン照会が追加されました。メタデータのない過去のバンドルもブラウザでは閲覧可能ですが、Stage 向けには汎用的な理由で非対応として一覧されます。

Stage は discovery v1 および v2 に対応し、保存設定スキーマは 1 を維持します。v2 はセッションを通じて URL リビジョンを固定するため、新規リビジョン B が発行されても開いているリビジョン A のセッションは更新されず、再接続時に B が選択されます。リモートノートの識別子は `origin/id/page` のまま保たれるため内容は維持され、変更時は `sourceChanged` 警告が通知されます。ネイティブブリッジのプロトコルはバージョン 1 のままです。

## 検証ゲートと未検証事項

品質検証のために以下のゲートが用意されています。これらは意図された検証対象を示すものであり、現時点でテスト通過を断定するものではありません。

```bash
pnpm verify:workers
pnpm verify:workers-stage
pnpm check
```

`verify:workers` はローカルの workerd およびブラウザ環境での動作を対象とし、`verify:workers-stage` は実デスクトップ（Tauri および WebKit、Linux ディスプレイ環境が必要）の検証を目的としています。

なお、以下の項目は現時点で未検証のままです。
- クラウド環境への実際のデプロイ
- Cloudflare Access 実ホスト環境での動作
- Windows 環境での動作
- 物理 2 画面環境（物理 Linux モニターを含む）での動作

リポジトリ内の `wrangler` 設定は名称とストレージ移行設定を保持していますが、クラウド公開の準備が整った設定ではありません（`PROFILE_DIGEST` やリソース、認証の明示的なセットアップが必要です）。自動デプロイは行われません。
