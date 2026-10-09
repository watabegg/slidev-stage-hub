# Workersコンパイル環境の拡張検証レポート

## 目的と検証範囲

ユーザーからの「もっと多くのケースを試してほしい」という要望を受け、前回のWorkersコンパイル概念実証（PoC）の範囲を拡張した。実資料への適用、同時更新や再起動への耐性、複数ブラウザタブでの競合、スタイルシート（CSS）通信障害時の挙動、サムネイル撮影時の破損画像検知などを網羅的に検証することを目的とする。
コンテナ環境を排し、ブラウザ側でのコンパイルを行わない制約を維持した上で、ローカルのworkerdおよびChrome環境のみを用いて検証を実施した。外部への公開、コミット、プッシュは行わず、テーマリポジトリは読み取り専用としている。なお、初回の検証記録である `results/poc.md` は歴史的記録として保持し、本レポートはGeminiによる最新の追記として `bundle-sharing/experiments/workers/results/expansion.md` に保存する。

## 実験結果と不具合の修正

### 負荷耐性と永続性の検証（stress.mjs）

実運用における競合や再起動時のデータ保持を検証するため、同一資料に対する12件の同時更新、同一内容の8件同時再送、24資料の一覧取得を実施した。R2およびSQLite Durable Objectsへの保存後にworkerdを再起動し、旧版のバイト列と現行リビジョンが正しく保持されることを確認した。別資料間での同名SVGの分離や、asset mapの順序非依存性も確認している。
また、scriptタグ、未知のコンポーネント、未対応のレイアウトやテーマ、上限100ページを超える101ページのスライド、アセットやJSONを含むリクエストボディが512KiBを超えるデータ、破損したYAMLなどの不正な入力に対しては、処理を適切に拒否して旧版を維持することを確認した。Durable Objects単体の模擬ではなく、実際のHTTP通信競合下で全21件の検査に合格した。テストハーネスには `statePath` と `workerPath` を追加し、実験ごとに保存先とビルド先を分離できるようにした。

### 複数タブ表示と通信障害への耐性（browser-experiments.mjs）

同一オリジン上で複数資料を開いた際の表示干渉や、通信途絶時の挙動を検証した。同一オリジンの別タブで開いた2つの資料間で、CSS、スライド表示、クリック操作の混線が発生しないことを確認した。Markdown更新後、旧タブを再読み込みした場合は旧リビジョンが維持され、リビジョン指定のないURLアクセスでは新リビジョンが表示される。CSS配信遅延時にも未装飾の画面を露出させず、通信復旧後に正常表示されることを確認した。
一方、CSS通信を中断（abort）した際に画面が白画面になる問題が発生した。これに対し、表示エラー画面と再読み込みボタンを実装して回復可能であることを確認し、全8件の検査に合格した。修正前の失敗証跡は `results/browser-before-fix.json` に記録している。

### コンパイラ互換性の修正（compatibility.mjs）

既存の4件のフィクスチャとテーマの `example.md` を直接コンパイルしたところ、初回は5件すべてが名前付きスロット（named-slot）の拒否により失敗した。さらに小規模な20件の検証において、コードブロック内の `{{ value }}` がVue式として解釈されたり、数式が警告なく文字として出力されるサイレント不一致（silent mismatch）が計4件発生した。
この課題を解決するため、コンパイラを修正した。Markdownのコードブロックおよびインラインコードに `v-pre` を付与してVue文字列やタグをそのまま表示可能とし、`::left::`、`::right::`、`::default::` をnamed slotへ変換して実テーマへ転送するよう改修した（コードブロック内のマーカーは単なる文字として扱う）。生のVueテンプレートは未対応として正確に拒否する。数式機能は未実装のままであり、描画サポートを追加したのではなく、ドル記号区切りが平文になる旨をAPIレスポンスおよび公開CLI（`publish.mjs`）のJSON内にある `warnings` 配列へ明示する仕様とした。
修正後の直接コンパイルでは、元の5資料全文はいずれもMermaidの利用により明示的に拒否された（フィクスチャのスライド3、テーマexampleのスライド14）。焦点を絞った20件の検証では、15件受理、2件数式警告、3件明示的拒否（scriptタグ、src include、生テンプレート）となり、サイレント不一致は0件となった。ただし有限ケースでの検証結果であり、Slidevの全構文に対応したわけではない。

### フィクスチャのブラウザ描画検証（fixture-browser.mjs）

既存4フィクスチャから、未対応のMermaidや数式を含む第3ページを除外し、先頭2ページを変更せずに抽出して検証した。実際のworkerd生成物を用いてChromeで表示を確認し、2カラムの左右スロット、同名相対SVG、QuestionList、v-click、テーマのEnter、リテラルコードの描画など全24件の検査に合格した。なお、これは先頭2ページに限定した検証であり、4資料の全文に対応したわけではない。

### サムネイル撮影と待機判定の修正（thumbnail-experiments.mjs）

defaultレイアウトの表紙（先頭ページ）に見出しとSVGを配置し、1200x675ピクセルのPNG実撮影を実施した（テーマのcoverレイアウトは元々スロットを表示しない仕様のため、画像検証ではdefaultを指定）。動的モジュールに約650msの遅延が生じる環境でも撮影対象が表示されることを確認した。不正なPNGや規定外サイズ（980x551）は400エラーで保存を拒否する。旧版サムネイルの固定、Markdown更新時の旧画像保持、別PNGの再PUT時にもキャッシュによりハッシュ値が変わらないことを確認した。Browser Run binding未設定、429、500エラーへの対応はモックで確認しており、実リモート環境での検証ではない。
検証の過程で、Slidevのローディング用プレースホルダーも `.slidev-layout` に一致するため、画像の読み込み待機が空配列で完了し、破損したSVGであってもPNG撮影が成功扱いになる不具合が判明した（修正前証跡: `results/thumbnail-experiments-before-fix.json`）。
対策として、ランタイムの実描画レイアウトに `data-lab-slide-ready="$page"` 属性を追加し、ローカルCLIがこのマーカーを検知した後に `fonts.ready` および全画像の `img.decode` 完了を待機するよう改修した。改修後は破損画像でCLIが非ゼロ終了し、PNG取得が404になることを確認した。Browser Run側の待機セレクタも同マーカーへ変更したが、実リモート環境での画像デコード挙動は未確認である。

## 再現手順と検証コマンド

作業ディレクトリは `bundle-sharing/experiments/workers` とする。再現には初回のREADMEに記載されたローカルテーマ、依存関係、Chrome環境が必要である。

```bash

# ランタイムのビルド（コンパイラを含まないruntime-onlyグラフであることを確認）

pnpm build:runtime

# 単体テストの実行（コンパイラ13件、サムネイル14件、計27件合格）

pnpm test

# 既存統合テストの実行（32件合格）

pnpm verify

# 個別検証スクリプトの実行

node stress.mjs               # 負荷耐性・永続性検証（21件合格）
node browser-experiments.mjs   # 複数タブ・通信障害検証（8件合格）
node fixture-browser.mjs       # フィクスチャ描画検証（24件合格）
node compatibility.mjs         # 互換性検証（20件focused + 5件fullの分類）
node thumbnail-experiments.mjs # サムネイル撮影検証
```

`thumbnail-experiments.mjs` は一時的なMiniflareオリジンを用いる隔離テストハーネスでの実行が完了しており、永続デモ環境を汚染することなくハーネスが破棄されることを確認した（結果は `results/thumbnail-experiments.json` に記録され、任意のオリジン指定も引き続きサポートしている）。

## デモ環境と検証証跡

デモ環境は `pnpm dev`（localhost:4180）で起動し、別端末から `node prepare-demo.mjs` を実行する。これにより初回5ページのPoCおよび4資料の先頭2ページ版（計5資料）が登録され、各サムネイルが撮影される。この検証は完了しており、実際のChrome環境で全5件のサムネイルデコードとカタログのスクリーンショット（`artifacts/workers/expanded-catalog.png`）を確認した。既存の4174ポート環境とは分離されている。

検証証跡として以下のファイルを確認している。

- 証跡JSON: `results/stress.json`、`results/browser-experiments.json`、`results/fixture-browser.json`、`results/compatibility-before.json` / `results/compatibility.json`、`results/thumbnail-experiments-before-fix.json` / `results/thumbnail-experiments.json`、`results/expansion-measurements.json`
- 証跡画像（git管理外）: `artifacts/workers/stylesheet-failure.png`、`artifacts/workers/original-two-cols.png`

## 現在の境界と今後の課題

- 次の優先課題は数式レンダリングへの対応、Mermaid等の図表生成方式の確立、R2通知とCloudflare Queuesの自動接続である（今回Queue接続は追加していない）。
- 現在は固定の `watabegg/runtime` を使用しており、同一ランタイム内でのMarkdown更新を検証した。
- ランタイムのバージョン更新を跨いだ旧版との互換性、Native環境や既存Vueホームとの統合、Cloudflare WorkersのCPUおよびメモリ制限、実リモートBrowser Runでの撮影は未検証である。
- 今回は不具合を個別に再現して修正し、対応可能な構文を段階的に広げた段階であり、あらゆるSlidev資料の全文をそのまま変換・描画できる段階には達していない。
