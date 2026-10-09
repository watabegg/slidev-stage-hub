# Leadによる最終確認（2026-10-08）

- 標準ビルドを1資料再実行し成功。`artifacts/lead-baseline.log`。
- `CHROMIUM_EXECUTABLE=/usr/bin/google-chrome node bundle-sharing/scripts/browser-experiment.mjs http://127.0.0.1:4173 artifacts/browser-shared-final`: 4資料PASS、別資料専用asset取得0。次資料の転送16,176 bytes、57資材cache再利用。
- `python3 scripts/compare-screenshots.py artifacts/browser-baseline artifacts/browser-shared-final artifacts/visual-comparison-final.json`: 12/12 pixel一致。
- `node scripts/prepare-offline.mjs`: 採用版をローカルfonts/favicon付きへ変換。今回475files / raw13,853,919 / gzip8,595,838 bytes。Google応答により以前の126font filesから245filesへ変化。取得URL・ハッシュは `artifacts/module-graph-offline/font-vendor.json`。
- `BLOCK_EXTERNAL=1 CHROMIUM_EXECUTABLE=/usr/bin/google-chrome node bundle-sharing/scripts/browser-experiment.mjs http://127.0.0.1:4174 artifacts/browser-offline-accepted`: 4資料・catalog・back/forward PASS、外部取得試行0。ローカルserverを残して外部HTTPを遮断する実験で、OSのnetwork設定は変更していない。
- offline版との画像比較は0/12 pixel一致。文字周辺に微差あり。目視でレイアウト・内容・色を確認。外部fontsを使う基準版と、取得時点の異なるfont snapshotの厳密一致は保証しない。`artifacts/visual-comparison-offline-final.json`。
- `node native-app/scripts/prepare.mjs --site artifacts/module-graph-offline/site` の後、`NO_AT_BRIDGE=1 python3 native-app/scripts/verify.py --log native-app/artifacts/runtime-lead-final.log`: 実WebView 18/18 PASS、ソース復元一致。対応表の新規instance再読込と `notes-save.diff` を確認。
- `cargo test --locked -p slidev-native-core` / `cargo fmt --all -- --check` をnative-appで実行し成功（6 tests）。`git diff --check`、変更したJSの構文確認、root frozen/offline pnpm installも成功。
- 環境記録scriptで取得したテーマHEAD/status/全通常ソースファイルSHA-256を前後比較し一致。既存dirty変更を保持。

採否: 同期bootstrap + ローカルfonts + Tauriを、このPCの条件付きPoCとして採用。残る実機制約は [TODO](../TODO.md) と [native結果](../native-app/results/2026-10-08-native-poc.md)。
