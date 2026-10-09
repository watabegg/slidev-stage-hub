# 4174の白画面（2026-10-08）

- 実ブラウザ: Chrome 152、`http://127.0.0.1:4174/aaa/aaa1/1`。新規Chromeでは再現せず、利用中のブラウザでは強制再読み込み後も白画面。
- 診断: `Unable to preload CSS for .../assets/main-C-uqeE91.css`。`#app`は空。Service Worker登録なし。
- 同じCSS URLのキャッシュ内容は`/_fonts/fc906…css`をimport、ネットワーク内容は`/_fonts/b654…css`をimport。前者は現行成果物に存在しない。CSS参照URLの変更でユーザーの表示が復旧。
- 原因: offline後処理がViteのhash付きファイル名を維持したままCSSを書き換え、サーバーが同じURLをimmutableとして配信していた。キャッシュされたCSSと現行フォント一覧が不整合になった。
- 採用: offline加工後の成果物全体からsnapshot hashを作り、JS/CSSの名前と参照を更新する。循環importも同一snapshotの名前へ変換する。snapshot変更時にはJS/CSS全体のキャッシュを更新するため、細粒度のキャッシュ再利用は今後の最適化。
- 起動失敗時には独立したDOMで再読み込み／ホームリンクを表示する。通信失敗を隠す自動リトライは追加しない。
- 一時診断の記録: `artifacts/local-click-debug/browser.ndjson`、`requests.ndjson`。実験用の診断サーバーは検証後に通常サーバーへ戻す。
- 検証: `node --test scripts/fingerprint-offline.test.mjs` 4項目、`node scripts/verify-library.mjs artifacts/cache-fix-offline/site` 15項目合格。CSS強制失敗で復帰UIを確認。キャッシュ保持での白画面再現→修正版で表示を確認（`artifacts/local-click-debug/cache-upgrade.json`）。
- 4174は修正版を配置して通常の`node scripts/serve.mjs artifacts/module-graph-offline/site 4174`へ復帰済み。外部公開・pushは行っていない。
