# 2026-10-08 ネイティブ PoC 結果

仮説: 同じ静的 Slidev 成果物を Tauri 2 で描画し、Rust の状態を 2 ウィンドウへ配信できる。

環境: Ubuntu 26.04.1 / Wayland、Rust 1.96.1、Tauri 2.12.1、WebKitGTK 2.52.6、GTK 3.24.52。開発用ファイルは 98 個の deb をローカル展開した。OS パッケージは導入していない。[版一覧](environment.json)・[展開パッケージ](sdk-packages.txt)。

| 実験 | 実測 |
|---|---|
| 初期起動 | AT-SPI の `spi_register_object_to_path` で SIGSEGV。GDB ログ保存。DMABUF 無効化では改善なし |
| `NO_AT_BRIDGE=1` | 起動可能。アクセシビリティ連携を無効にした条件付き結果 |
| 標準個別ビルド | 3 ページ描画、コード・数式・Mermaid、操作 16/16 |
| 初期共有グラフ | page3 が Loading のまま。custom protocol / loopback とも失敗 |
| 同期 bootstrap + ローカル fonts | 実際の WebView 操作 18/18、ソース復元一致 |
| Rust core | 6 テスト合格、Clippy 合格 |
| 画面 | PHL 221E9 1920×1080 / scale1 を 1 台検出。全画面要求・配置交換要求を実行、位置の観測は両方 0,0 |

再現コマンド（リポジトリのルート）:

```bash
node native-app/scripts/prepare.mjs --site artifacts/module-graph-webkit-offline/site
NO_AT_BRIDGE=1 python3 native-app/scripts/verify.py --log native-app/artifacts/runtime-webkit-offline.log
cargo test --locked --manifest-path native-app/Cargo.toml -p slidev-native-core
cargo clippy --locked --manifest-path native-app/Cargo.toml -p slidev-native-core -- -D warnings
```

証跡: `artifacts/runtime-webkit-offline.{log,json}`、`page-three-presenter.png`、`initial-{presenter,audience}.png`、`notes-save.diff`。ノートを実ソースへ保存し、対応表の再読込を確認してから元のバイト列へ復元した。初期共有方式の失敗は `runtime-protocol.log` / `runtime-loopback.log`、基準描画は `runtime-baseline.log` と `baseline-page-three-presenter.png` に保存した。

採用: この PC の PoC は Tauri / Rust と同期 bootstrap の組合せを条件付き採用。loopback は読み取り専用の公開成果物のみ。私有ノートと保存 API は配信しない。

制約: 物理 2 画面、切断・再接続、HiDPI、Windows は未検証。配置 API の成功だけで移動成功とは判定しない。聴講者の snapshot は一部条件で黒くなり、DOM の表示状態と分けて記録する。iframe の Wake Lock は Feature-Policy で拒否される。ノートは既存コメントの編集のみ、下書きは終了時に消える。外部編集の確認と rename の間、およびソース保存と対応表更新の間には極小の競合・クラッシュ余地が残る。

次の実験: アクセシビリティ連携を有効にした起動原因の特定、物理 2 画面と再接続、snapshot の描画制約、Windows WebView2。

参照: [Tauri Linux prerequisites](https://v2.tauri.app/start/prerequisites/)、[Tauri WebviewWindow API](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindow.html)。
