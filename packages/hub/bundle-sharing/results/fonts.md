# Google Fonts のローカル化（2026-10-08）

- 仮説: ビルド成果物内の Google Fonts CSS と、その `@font-face` が参照するフォントだけを `/_fonts/<sha256>.<ext>` に保存し、外部通信なしの配信準備ができる。
- 再現コマンド: `node scripts/vendor-fonts.mjs <site-root> <evidence-json>`。検証時は `artifacts/module-graph/site/index.html` と `manifest.json` の一時コピーに、テーマの Google Fonts `@import` と無関係な外部CSS・JS URLを加え、実行した。初回・2回目の証跡は [verification-first.json](../../artifacts/fonts/verification-first.json) と [verification-second.json](../../artifacts/fonts/verification-second.json)。
- 環境: Node.js 24.15.0。Google Fonts へHTTPS接続し、CSS・フォントを最大4件並列で取得した。テーマリポジトリは変更していない。
- 実測: 初回はCSS 2件、フォント126ファイルを取得。生成したローカル資材はCSS 760,077 bytes、フォント2,783,604 bytes、合計3,543,681 bytes。マニフェストの `commonAssets` に128件を登録した。2回目は追加取得・書き換えとも0件で、サイト内ファイルのSHA-256一覧は初回後と一致した。`example.invalid` の画像・JS URLは維持された。存在しないフォント名へのHTTP 400では終了コード1となり、入力ファイルも変更されなかった。
- 制約: 一時コピーでの確認であり、実際の候補成果物やネットワーク遮断状態でのブラウザー描画は未検証。CSS内の `@import` を置換すると、既存のハッシュ付きCSS名は内容ハッシュと一致しなくなる場合がある。レポートにも記録した。公開前の成果物で使う場合はCSS名を再生成する必要がある。
- 採否: ローカルPoC用のオフライン資材生成として採用候補。失敗したHTTP応答・予期しないオリジン・空データは非ゼロ終了し、サイトを書き換える前に全ダウンロードを完了する。
- 次: 親エージェントの指示後、共有バンドル候補に適用し、オフラインで全参照を取得できることとブラウザー描画を確認する。
