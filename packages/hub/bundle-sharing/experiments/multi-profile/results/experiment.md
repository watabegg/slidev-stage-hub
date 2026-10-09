# 実測メモ（2026-10-08）

仮説：実行時・テーマ・setup/compile条件が等しい資料だけ共有し、それ以外を文書遷移で隔離すれば、キー/CSSの衝突を防ぎながら同一条件内の重複を減らせる。上位ディレクトリのREADMEに再現コマンドを記載。

同じ8資料、同じminify・PNG生成で比較した。

|方式|グラフ|raw bytes|gzip bytes|ファイル|
|---|---:|---:|---:|---:|
|資料ごと|8|6,411,925|2,747,217|480|
|互換条件ごと|4|3,306,849|1,427,918|286|

raw48.43%、gzip48.02%削減。[計測JSON](../../../../artifacts/multi-profile/comparison.json)。グループ間のasset dedupは未実施。52依存はローカル既存storeに固定したPoCであり、別PCでのインストールは未検証。

採用：独立子プロセス＋同期bootstrap。実ブラウザで8資料の実クライアント52.15.2/53.0.0、同名layout/component、A/BのCSS・Enter、同じtitleの資料間同期分離、他グループ取得0を確認。[ブラウザ結果](../../../../artifacts/multi-profile/browser/result.json)。markerがある場合だけrouterとunrefしたslides配列を公開する接続も両版で成功。leadの実WebKit確認は [native24項目](../../../../native-app/artifacts/runtime-multi-profile.json)。

不採用の混在ケースも実行した。Aページへ実際のB setup/CSSを追加すると、両テーマがwindow/document captureでkeydown/keyupを消費し、A componentのまま背景がB色になる。A単独の3→5に対し混在は3→4。[壊れた再現](../../../../artifacts/multi-profile/browser/broken-co-load.json)。本番assetは変更していない。

初回は合成fixtureの不正な区切りと、52でbooleanを受け取らない `fonts.local` が失敗した。修正後は5頁×8資料となり、公開物のprivate note検査も成功。古いloaderが残すraw YAMLは静的metadataから除いた。download設定差が別signatureになることと、資料側setupの明示的拒否を [guard結果](../../../../artifacts/multi-profile/guard-result.json) で確認。

次：別PCの依存導入、未対応バージョン、任意addons/setupの互換条件は別実験とする。今回の対応範囲へ含めない。
