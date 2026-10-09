# Webクライアントとフロントエンドのカスタマイズ

本ガイドでは、HubにおけるWebクライアント機能およびフロントエンド画面の設計仕様と、独自の画面構成へカスタマイズする手順を説明します。

Hubでは、データ通信と画面描画の責務を分離するため、データ取得を担うクライアント（`packages/hub/src/client`）と、Vueによる描画を担当するフロントエンド（`src/frontend`）を独立させています。クライアント側にはVue、DOM操作、スタイル定義、インポート時の通信処理を含めない設計としており、標準のホーム画面はこれまでの外観および公式Slidevテーマを維持したまま動作します。

---

## カタログクライアント（`@slidev-stage-hub/hub/client`）

スライドカタログの取得処理には、プライベートパッケージ `@slidev-stage-hub/hub` の公開サブパスエクスポート `@slidev-stage-hub/hub/client` を使用します。JavaScriptコードと型定義は `dist/client` に配置されています。

### データソースとカタログ取得

カタログ取得は、データ読み込みを担当するデータソースインターフェース `CatalogSource` を基盤として動作します。

```typescript
export interface CatalogSource {
  load(options?: { signal?: AbortSignal }): Promise<unknown>;
}
```

HTTP経由でカタログを取得する場合は `createHttpCatalogSource` を利用します。取得URLのデフォルト値は `/catalog.json` であり、独自の `fetch` 実装を渡すことも可能です。

```typescript
import {
  createHttpCatalogSource,
  createCatalogClient,
  getCatalog,
} from '@slidev-stage-hub/hub/client';

// データソースの生成（URLやfetchは省略可能）
const source = createHttpCatalogSource({ url: '/catalog.json' });

// クライアントインスタンスを生成して取得
const client = createCatalogClient(source);
const catalog = await client.getCatalog();

// ユーティリティ関数による直接取得（sourceの省略も可能）
const directCatalog = await getCatalog(source);
```

### スキーマ検証とアダプター仕様

クライアントはプロトコル検証関数 `validateCatalog` を備えており、`getCatalog` の呼び出しごとにスキーマ仕様（v1）との整合性を検証します。キャッシュ処理は行われません。

独自のデータソースアダプターを実装する場合、`load` メソッドはプロトコル仕様に準拠したカタログデータを返す必要があります。なお、Cloudflare Workers APIによるページネーションや実エンドポイントとの接続はStep 7で統合予定であり、現時点では契約検証用のテストデータ（フィクスチャ）のみが用意されています。静的配信と将来のWorkersアダプター双方が満たす戻り値として共通のプロトコル仕様（v1）が定義されていますが、現時点では契約検証用のフィクスチャのみが用意されており、実エンドポイントの応答変換を担うWorkers向けアダプターはStep 7で提供されます。

### エラー処理と中断制御

カタログ取得で問題が発生した場合は `CatalogClientError` が送出されます。エラーの根本原因は `cause` プロパティから参照できます。

| エラーコード | 発生条件 |
| --- | --- |
| `ABORTED` | 処理が中断された場合 |
| `NETWORK` | ネットワーク接続に失敗した場合や、独自データソースの読み込みでエラーが発生した場合 |
| `HTTP` | HTTPエラー応答（ステータスコードを保持）を受信した場合 |
| `INVALID_JSON` | レスポンスのJSON解析に失敗した場合 |
| `INVALID_CATALOG` | スキーマ検証（v1）に違反している場合 |

`AbortSignal` を渡した場合、データソース側の処理がシグナルを無視して継続しても、クライアントは待機状態を解除して即座に処理を中断します。ただし、通信自体を停止させるには下位のアダプターがシグナルを適切に処理する必要があります。標準の `fetch` 実装は渡されたシグナルをそのまま下位へ転送します。なお、クライアント側には画面上のエラー通知処理（`onerror`）は含まれていないため、エラー表示は呼び出し元で実装する必要があります。

---

## フロントエンドマウント（`@slidev-stage-hub/hub/frontend`）

画面描画には、同パッケージの公開サブパスエクスポート `@slidev-stage-hub/hub/frontend` が提供する `mountHub` 関数を使用します。

```typescript
import { mountHub } from '@slidev-stage-hub/hub/frontend';

const instance = await mountHub('#app', {
  source: customSource, // 未指定時は /catalog.json を使用
  signal: abortController.signal,
  navigation: {
    homeHref: '/',
    homeLabel: 'ホーム',
    deckHref: (deck) => deck.entry,
  },
});

// マウント解除（冪等であり複数回の呼び出しが可能）
instance.unmount();
```

### フロントエンドの特性と制約

- **ビルド要件**: 本パッケージはTypeScriptおよびVueのソースコードを直接エクスポートしています。個別にフロントエンドのバンドラーを構成する場合はViteおよびVueコンパイラが必要ですが、Hub標準のビルド構成を利用する場合は自動的にコンパイルされます。
- **副作用の排除**: パッケージのインポート時に、画面への自動マウントやデータ取得、スタイルシートの自動読み込みといった副作用は発生しません。
- **エラー処理**: 対象となるDOM要素が存在しない場合やマウントに失敗した場合は、エラーコード `MOUNT` を持つ `FrontendMountError` が送出されます。カタログ取得時のエラーはそのまま上位へ伝播します。
- **安全な画面描画**: スライドのフロントマター（メタデータ）に含まれるHTMLが意図せず実行されることを防ぐため、レンダラーはVueのテキスト補間を用いて安全に描画します。
- **リソースの破棄**: `mountHub` が返すオブジェクトの `unmount` メソッドは冪等であり、複数回呼び出しても安全に動作します。

---

## スタイル定義とカスタマイズ

スタイルの適用は任意であり、必要な場合はスタイルシートを明示的にインポートします。

```typescript
import '@slidev-stage-hub/hub/frontend/style.css';
import './my-theme.css'; // 上書き用CSSは基本スタイルの後に読み込む
```

### 提供されているCSS変数

基本スタイルシートは、以下のCSS変数を公開しています。

- `--hub-font-family`: 全体のフォントファミリ
- `--hub-background`: 背景色
- `--hub-text`: 基本テキスト色
- `--hub-accent`: アクセント色
- `--hub-content-max-width`: コンテンツの最大表示幅
- `--hub-layout-gap`: レイアウト全体の余白
- `--hub-card-row-gap`: カード行間の余白
- `--hub-card-column-gap`: カード列間の余白

### スタイル適用の注意点

- **読み込み順序**: 独自CSSによる変数やスタイルの上書きを反映させるため、基本スタイルシート（`style.css`）を先にインポートしてください。
- **表示領域による変化**: レスポンシブレイアウトの制御により、狭い画面幅では設定した余白（gap）が自動的に上書きされる場合があります。
- **スタイルの適用範囲**: デフォルトのスタイルはグローバルスコープに適用されます。Shadow DOMによるカプセル化は行われないオプトイン形式です。

---

## ビルド設定と独自エントリーポイント

Hubのビルド処理は、Node APIまたは設定ファイル（`hub.config.json`）から構成できます。

### 設定インターフェース

```json
{
  "schemaVersion": 1,
  "frontendEntry": "src/frontend/entry.ts",
  "navigation": {
    "enabled": true,
    "homeHref": "/",
    "homeLabel": "一覧へ戻る"
  }
}
```

Node APIから実行する場合は `buildHub` を使用します。

```typescript
import { buildHub } from '@slidev-stage-hub/hub';

await buildHub({
  baseDir: process.cwd(),
  sourceRoot: 'slides',
  outDir: 'dist',
  frontendEntry: 'src/frontend/entry.ts',
  navigation: {
    enabled: true,
    homeHref: '/',
    homeLabel: '一覧へ戻る',
  },
});
```

### パスの解決規則とセキュリティ要件

- **パス解決**:
  - `hub.config.json` 内のパス: 設定ファイルが配置されているディレクトリからの相対パス。
  - Node API: 絶対パス、または `baseDir` からの相対パス。
  - CLI（`--frontend-entry`）: コマンドを実行したカレントディレクトリからの相対パス。
- **セキュリティ要件**: `frontendEntry` はViteによってバンドルされるローカルの実行可能コードです。外部URLは指定できず、コード内容の検証は行われないため、呼び出し元が信頼できるコードや設定を指定する必要があります。また、出力先ディレクトリの外側に実在するファイル（シンボリックリンクの実体パスを含む）である必要があります。

### ナビゲーション設定の役割分担

ナビゲーションの設定項目は、設定箇所によって対象が異なります。

1. **ビルド時のナビゲーション設定（`buildHub` / `hub.config.json`）**: 各スライド側からホームへ戻るリンクを構成します。従来の動作を維持しながら、ラベルやURLの上書き、あるいは `enabled: false` によるリンクの無効化が可能です。
2. **マウント時のナビゲーション設定（`mountHub` の `navigation`）**: ホーム画面内のブランド表示や各スライドへの個別リンクを構成します。

### エントリーポイントの実装責任

- **デフォルト構成**: `frontendEntry` を指定しない場合、標準の `src/frontend/home.ts`（明示的なCSS読み込みと `mountHub` を実行する構成）が使用されます。
- **カスタム構成**: 独自のエントリーファイルを指定する場合、マウント処理、スタイルシートの適用、エラー表示UIの実装は開発者側の責任となります。Vueを使用せず、`@slidev-stage-hub/hub/client` と `document.createElement` を組み合わせてフレームワークに依存しない構成を作ることも可能です。

---

## 実行コマンドと構成例

リポジトリ内で提供されているビルドおよび配信コマンドの例です。

```bash
# パッケージのビルド
pnpm build:packages

# 設定ファイルを指定したサイト構築
pnpm hub build --config examples/custom-frontend/hub.config.json

# 構築したサイトのローカル配信
pnpm hub serve --site artifacts/custom-frontend/site
```

### 構成パターンの例

- **バニラ構成（`entry.ts` + `style.css`）**: フレームワークを使用せず、クライアントライブラリからDOMを直接構築する最小構成。
- **テーマ適用構成（`themed.ts`）**: `mountHub`、基本スタイルシート、独自テーマスタイル（`theme.css`）を組み合わせた構成。CLIから直接エントリーポイントを上書きしてビルドすることもできます。

```bash
# CLIオプションで設定ファイルのエントリーポイントを上書き
pnpm hub build --config examples/custom-frontend/hub.config.json --frontend-entry examples/custom-frontend/themed.ts
```

デフォルトの構成を利用する場合は、`frontendEntry` を指定せずにそのままビルドできます。

---

## エラー原因の特定

問題が発生した際は、エラーの種類と出力元を確認して切り分けを行います。

- **クライアント起因のエラー**: `CatalogClientError` が送出され、`ABORTED`、`NETWORK`、`HTTP`、`INVALID_JSON`、`INVALID_CATALOG` のいずれかのコードが設定されます。
- **マウント起因のエラー**: DOM要素が見つからない場合などに `FrontendMountError`（コード: `MOUNT`）が送出されます。
- **スタイル適用の不備**: スタイルが適用されない、あるいは意図しない表示になる場合は、基本スタイルシートが明示的にインポートされているか、独自CSSのインポート順序が基本スタイルの後になっているか、ブラウザの開発者ツールで計算されたCSS変数値を確認してください。
- **エントリーパスの誤り**: 指定したエントリーファイルが存在しない場合、設定検証時に `CONFIG` エラー（CLIでは `INVALID_CONFIG`）が発生します。
- **構文・依存関係の解決エラー**: ビルド時の構文エラーやインポートエラーは `BUILD` エラーとなります。Node API経由ではコンパイラの詳細な診断情報が出力されますが、CLI経由では `BUILD_FAILED` という汎用エラーが表示され、生の診断情報は表示されません。

---

## 検証スクリプトとゲート検証

Webクライアントおよびフロントエンドの仕様適合性を検証するため、Step 6のゲートコマンドが用意されています。

```bash
# クライアント単体機能のテスト
pnpm test:web-client

# フロントエンドカスタマイズ全体の統合検証
pnpm verify:web-customization
```

### 検証範囲と動作確認項目

これらのコマンドは、Step 6の受け入れ動作の検証を目的として定義されています。

ブラウザゲート検証では、標準構成、バニラ構成、テーマ適用構成のそれぞれをビルドし、以下の項目を検証します。

- 処理中断（Abort）シグナル受信時の挙動
- 不正な形式のカタログや空のカタログを受信した際の処理
- ナビゲーションリンクの動作
- フロントマターに含まれるテキストの安全な展開（HTMLとして実行されないこと）

検証実行時の結果は `artifacts/step6/gate.json` に保存され、スクリーンショットは同ディレクトリ（`artifacts/step6/`）内にPNGファイルとして保存されます。実行後のテスト結果は `docs/results/web-customization.json` で追跡されます。なお、本検証はローカル環境向けに定義されたものであり、クラウド環境やあらゆるオペレーティングシステムでの動作を保証するものではありません。
