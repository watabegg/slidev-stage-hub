# 個別ビルド基準測定

## 仮説

4資料を標準の独立ビルドにすると、Slidevとテーマのランタイムが資料ごとに出力される。各資料のビルド量を、共有候補との比較基準にする。

## 再現コマンド

```sh
pnpm install --frozen-lockfile --offline
pnpm baseline
```

スクリプトは資料ごとに次の形式で `slidev build` を実行する。計測JSONには4件それぞれの実コマンドと各生成ファイルのSHA-256を保存した。

```sh
pnpm exec slidev build bundle-sharing/fixtures/aaa/aaa1/slides.md \
  --out bundle-sharing/artifacts/baseline/aaa/aaa1 \
  --base /aaa/aaa1/ --without-notes
```

## 環境と資料

Linux x86_64 / kernel `7.0.0-31-generic`、Node.js `v24.15.0`、pnpm `12.3.4`、Slidev CLI/parser `53.0.0`、Vite `8.3.2`、PostCSS `8.5.28`。テーマ `slidev-theme-watabegg` `1.2.0` は HEAD `fb035f1ebd01f368e937e98f028e1a53d93b4801` を使用。テーマの作業ツリーは既存変更を含むため読み取り専用で扱い、working-tree snapshot SHA-256 は `28a7cb391fde0056122029fb0b3c5d23c8dd94fe85dba19cbf798c60785fc8e8`。

4資料はSlidev parserで各3ページ、クリック段階 `[0, 2, 0]` と確認した。テーマのレイアウト・`QuestionList`・Mermaid setup、コード、数式、同名相対画像、衝突する scoped CSS を含む。画像ファイル名は全資料で `assets/conflict.svg`、内容ハッシュは異なる。

## 結果

| 資料 | ページ / クリック | ファイル数 | Raw bytes | gzip bytes | build wall time | 出力 tree SHA-256 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| `aaa/aaa1` | 3 / `[0,2,0]` | 190 | 7,571,764 | 2,861,433 | 6.649 s | `7f8b22e122846eb81854a704b1f470b8f285a917092b649eac6b33ffc34d0367` |
| `aaa/aaa2` | 3 / `[0,2,0]` | 190 | 7,571,796 | 2,861,445 | 11.068 s | `ee18a9474c7b828f73ca1a56a5b57c2ef25154977c8a467849b04d70bf459a3e` |
| `bbb/bbb1` | 3 / `[0,2,0]` | 190 | 7,571,758 | 2,861,391 | 11.571 s | `625be9e51f0a1ea6e229ada95fc68265ceec6dacb4b6e112f9741b6efeedb33b` |
| `bbb/bbb2` | 3 / `[0,2,0]` | 190 | 7,571,847 | 2,861,482 | 13.091 s | `99a663f8e6849cfc0b72bb15cd2f4aedae76f7704147031a2b9de7b5c73bfb2a` |
| **合計** | **12 pages** | **760** | **30,287,165** | **11,445,751** | — | — |

gzip bytes は生成ファイルを1ファイルずつNode.jsの `gzipSync` 既定レベルで圧縮した合計で、転送量の近似値。build wall time は各 `pnpm exec` プロセスの起動を含むため、実行環境の負荷に左右される。全出力は `bundle-sharing/artifacts/baseline/<group>/<id>/` に生成された。

各ソースに `PRIVATE_NOTE_<id>` は2件あり、`--without-notes` 後の成果物を全ファイル走査して0件であることを確認した。4件すべて通常のCSS minifierで成功した。Viteは出力先がプロジェクトルート外のため自動emptyしない旨を警告するが、スクリプトが各出力先をビルド前に削除する。

別途実行したブラウザ確認では、4ルートすべてのCSS色・画像表示・クリック進行・リロード・タブ分離の機能アサーションが通った。厳格なネットワークエラー判定は失敗し、`/<id>/assets/conflict.svg` への preload 404 が合計18件あった。証跡は `artifacts/browser-baseline/result.json`。これは独立ビルドのベースライン欠陥として記録し、共有アダプター側での修正確認を次の比較に含める。

## 失敗・制約

初期のregistry解決CLI依存グラフでは、生成CSSのminification時にPostCSSが不正な疑似要素トークン（dimension値）を報告して失敗した。CLIをローカルテーマの既存インストールへ相対リンクし、そこで解決されるVite/PostCSSで再実行すると、CSS minifierを無効化せず4件とも成功した。

テーマの `styles/globals.css` はGoogle FontsのM PLUS 2を外部 `fonts.googleapis.com` から読み込む。テーマの読み取り専用条件を守るため、この基準ではフォントを置き換えていない。完全なオフライン表示は未検証。

## 採否と次の実験

この4件を独立ビルドの基準として採用する。パッケージ設定はpnpm `12.3.4` と、隣接するローカルテーマへの相対リンクを使用する。JSONのファイル別ハッシュを使って、共有候補の削減量と配信時の読込差を比較する。次はこの不変な成果物に対してpost-build dedup候補を測り、ブラウザ実験で各ネスト済みルートの表示とクリック進行を確認する。
