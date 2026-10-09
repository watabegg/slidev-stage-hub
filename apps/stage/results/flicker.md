# iframe 再読込によるちらつきの実験（2026-10-08）

仮説: 同じ資料の document を保持し、対象モジュールを先読みして router を更新すれば、操作ごとの空表示を避けられる。別資料は旧画面を残したまま予備フレームで描画し、最新 revision の描画確認後に交換する。

再現: `node native-app/scripts/verify-flicker.mjs artifacts/native-persistent-offline/site native-app/artifacts/flicker-browser-final3`。旧コードは `3d8c6a6` の app/bridge、成果物は両方式で同じ固定テーマ・Slidev 53.0.0。Chromium 152.0.7977.82、Ubuntu/Wayland。テーマは変更していない。

| 観測 | 旧方式 | document 保持 |
| --- | ---: | ---: |
| 初期表示＋同一資料4操作の document 読込 | 5 | 1 |
| 同一資料4操作の navigation 要求 | 4 | 0 |
| 同一資料4操作の空DOMフレーム / 観測フレーム | 30 / 146 | 0 / 20 |
| 別資料切替の空DOMフレーム / 観測フレーム | 7 / 27 | 0 / 12 |
| 同一資料4操作の描画確認応答（ms） | 715, 616, 600, 617 | 115, 51, 165, 101 |
| 別資料切替の描画確認応答（ms） | 442 | 197 |

証拠: `native-app/artifacts/flicker-browser-final3/result.json`。遅延B、A→B→A/C、旧/予備フレーム入力、古いtoken/描画通知、失敗時の旧画面保持、同じ失敗資料の再試行、chunk取得失敗、逆順revisionの取消済み予備フレームの古い失敗通知を含む11ケースが成功。主表示の iframe は最大2個。

失敗・修正: 最初の runtime hook は slides の ref を公開しており読み込めなかった。公開側を配列に修正。失敗資料の再選択で ready を待ち続ける問題は、失敗slotの document を作り直して解消。

採用: このPCのPoCでは router 更新＋近傍モジュール先読み＋描画確認による2フレーム交換を採用。Rust正本、ノート下書き、入力抑止、読み取り専用プレビューを維持。一般ブラウザにはnative bridgeを注入しない。

限界: 応答時間には旧方式の300ms debounceが含まれ、画面のpixel更新時間ではない。rAFで空DOMを数えた実験であり、描画負荷やコンポジタのちらつきを完全に証明する値ではない。初回起動の空表示は比較対象外。実WebKitの既存18項目は lead が `verify.py` で別途実行（`native-app/artifacts/runtime-persistent.json` は18成功・document保持・source復元を確認）。複数runtime/themeは `native-app/artifacts/runtime-multi-profile.json` の実WebKitで8資料・24項目成功、source復元も確認。最終の失敗通知gate追加後の既存18項目は lead の最終実行を参照。Windows・物理2画面は未検証。

最終版の実WebKit確認: `native-app/artifacts/runtime-persistent-final.json` は18/18成功、同一資料document保持、ソース復元、資料変更1回で計2documentを確認。最初のページ移動の応答303ms、その後の同一資料更新36〜96ms、別資料の描画確認446ms（この実行の値）。異なる52/53・A/Bテーマ8資料は `runtime-multi-profile.json` の24項目が成功。聴講者snapshotも今回の実行では正常に描画された。
