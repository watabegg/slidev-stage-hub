# Post-build 重複排除（2026-10-08）

- 仮説: 4つの独立ビルドから完全一致する自己完結型リーフ資材だけをハードリンクすれば、参照やCSS・JavaScriptの内容を変えずにローカル保存量を下げられる。
- 再現コマンド: `node bundle-sharing/scripts/dedup.mjs`。入力は `bundle-sharing/artifacts/baseline/{aaa/aaa1,aaa/aaa2,bbb/bbb1,bbb/bbb2}`、出力は [site](../../artifacts/dedup/site/)。[全計測値・共有ハッシュ・除外理由](../../artifacts/dedup/metrics.json) と [HTTP確認記録](../../artifacts/dedup/http-qa.json) を保存した。
- 環境: Linux x86_64、Node.js 24.15.0、Slidev CLI 53.0.0、Vite 8.3.2。テーマ `slidev-theme-watabegg` HEAD `fb035f1ebd01f368e937e98f028e1a53d93b4801`、dirty working tree snapshot `28a7cb391fde0056122029fb0b3c5d23c8dd94fe85dba19cbf798c60785fc8e8`。ベースラインと同じ Node `gzipSync` 既定レベルを使った。

| 測定 | 独立ビルド | 重複排除候補の各ルート | 候補の一意inode合計 |
| --- | ---: | ---: | ---: |
| ファイルパス数 | 760 | 760 | 580個相当の内容 |
| raw bytes | 30,287,165 | 30,287,165 | 26,785,361 |
| gzip bytes | 11,445,751 | 11,445,751 | 8,555,008 |

一意inode rawの差は3,501,804 bytes（11.56%）で、60グループ・180別パスの完全一致に由来する内訳はフォント59グループで3,218,844 bytes、PNGロゴ1グループで282,960 bytes。gzip一意inode値は各一意inodeを1回ずつgzipした比較用値であり、ネットワーク転送量ではない。ルートcatalogとmanifestを加えた全siteは30,333,748 raw / 11,454,064 gzip bytes。

- 安全性・ルーティング確認: SHA-256一致後にバイト列を照合し、フォントとラスター画像だけをハードリンクした。catalog、manifest、4つの `/<id>/1`、28件のHTML内ローカル参照をHTTPで確認し、24件は200、各資料の `assets/conflict.svg` preload 4件は独立ビルドと同じく404だった。未知ID、欠損アセット、エンコードされた親パスは404。HTMLはno-cache、ハッシュ付き資材はimmutable。公開出力の `PRIVATE_NOTE_` は0件。
- 除外した完全一致: CSS 12グループはcascade順序とscoped/global selectorの影響が未証明、JavaScript 24グループは相対・動的importと埋め込みURLを依存関係ごとに解析していないため統合しなかった。CSS結合や文字列置換は行っていない。
- 失敗・制約: deckごとのURLを保持するため、path raw/gzipはベースラインから減らず、別資料間のブラウザーキャッシュ再利用も示していない。ハードリンクによるraw削減は同一ファイルシステムでのinode計測で、配信・コピー時に通常ファイルへ展開されれば失われる。厳密なベースラインのブラウザー検査では `conflict.svg` preload 404 が計18件と報告されている。候補でのフルブラウザー検査とオフライン検査は未実施。
- 採否: ランタイム共有方式としては不採用。ローカル保管のraw容量を11.56%減らす補助手段にはなるが、gzip転送量と実行時再利用は改善しない。次は同一モジュールグラフ方式を共有・ルーティングの主候補として評価する。
