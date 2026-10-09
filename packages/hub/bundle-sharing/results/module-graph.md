# 同一グラフの4資料共有実験（2026-10-08）

- 仮説: URL に応じて configs/slides を起動前に遅延 import し、同期 facade を通して client を起動すれば、独立した deck と共有 runtime を両立できる。
- 環境: Node 24.15.0、CLI/client 53.0.0、Vite 8.3.2、PostCSS 8.5.28。依存は `/home/watabegg/slidev-watabegg` の導入済みグラフ。テーマ HEAD `fb035f1ebd01f368e937e98f028e1a53d93b4801`、dirty のまま読み取り専用。CSS は標準 minifier。
- 再現（リポジトリ直下から）: `node bundle-sharing/experiments/module-graph/build.mjs`、`PORT=4173 node bundle-sharing/experiments/module-graph/serve.mjs`、`CHROMIUM_EXECUTABLE=/usr/bin/google-chrome node bundle-sharing/scripts/browser-experiment.mjs http://127.0.0.1:4173 artifacts/module-graph/browser`、`node bundle-sharing/experiments/module-graph/inspect.mjs artifacts/module-graph/browser/result.json`。
- 成果物: [site](../../artifacts/module-graph/site/)。[契約](../experiments/module-graph/README.md)、[計測](../../artifacts/module-graph/build-metrics.json)、[グラフ](../../artifacts/module-graph/chunk-graph.json)、[照合結果](../../artifacts/module-graph/graph-analysis.json)。根拠はテーマ導入済み CLI の [serve-DzvJFv6v.mjs](/home/watabegg/slidev-watabegg/node_modules/@slidev/cli/dist/serve-DzvJFv6v.mjs:1466)（仮想 `/@slidev/slides`、source ID と loader は1535・1673行）および client の [setup/root.ts](/home/watabegg/slidev-watabegg/node_modules/@slidev/client/setup/root.ts:57)（title-based sync）。

| 項目 | 実測 |
|---|---:|
| ビルド時間 | 3.699 秒 |
| raw / gzip 総量 | 7,626,672 / 2,888,725 bytes |
| ファイル数 | 227 |
| canonical client / theme modules | 120 / 23 |
| 同期起動版の初回ローカル transferSize 合計 | 3,502,641 bytes |
| 同期起動版の2資料目ローカル transferSize 合計 | 16,176 bytes |
| 同期起動版の2資料目キャッシュ取得リソース | 57 |

- 検証: 同期起動版の Chromium 152 で4資料の色・同名相対画像・クリック進行・再読込・別タブ独立性を確認（PASS、エラー0）。どの資料も他資料の chunk 取得0。PRIVATE_NOTE_ は全生成ファイルで検出0。画像先読みも資料ごとの hashed URL を取得。[ブラウザ記録](../../artifacts/module-graph-webkit/browser/result.json)、[グラフ照合](../../artifacts/module-graph-webkit/graph-analysis.json)。採用後の通常出力は142JSファイルを構文解析し、top-level await 0を確認した（[証跡](../../artifacts/module-graph/bootstrap-validation.json)）。
- 失敗と修正: 初期版は notes 前の `<style>` により HTML コメントが JS に残り、画像先読みは `/assets/conflict.svg` に404を出した。公開 content のコメント除去、元資料を基準にした画像 URL import、一覧 HTML の画像先読み除去で修正した。CSS minify 無効化の途中結果は最終値に使わない。
- WebKit: 旧TLA版は page1/2 を描画したが、page3 が custom scheme / loopback ともに Loading のまま止まった。同じ WebKitGTK 2.52.6 で標準個別版は16項目を通過。同期起動＋フォントをローカル化した版は18/18通過し、page3 のコード・数式・Mermaid と notes の再読込も確認した（[native記録](../../native-app/artifacts/runtime-webkit-offline.json)）。静的 import グラフには循環がなく、エンジン内部の原因までは特定していない。外部 @import を残す raw 版は native CSP により CSS load を拒否された。
- 採否: TLAを持つクライアント版は不採用（[旧成果物・計測](../../artifacts/module-graph-tla/)）。同期起動を既定として通常出力へ昇格。全体の採否は同じ依存グラフの個別ビルド・事後重複除去との比較で lead が判断する。事後重複除去は同一 bytes を再利用できるが、configs を含む異なる client chunk は結合できない。
- 未検証 / 次: in-page deck 切替、資料固有 component/setup、異なる compile-time feature、SEO、Windows。HTML コメント内のコード例も除去する実験仕様。次は昇格した通常出力を lead が独立確認し、フォントをローカル化した複製で native 最終確認を行う。外部公開・push・OS設定変更なし。
