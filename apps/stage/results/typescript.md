# Native UIのTypeScript移行（2026-10-09）

- 仮説：Cargoのdesktopビルドに型チェックとJS生成を組み込めば、起動操作を増やさずNative UIをTSに移行できる。
- 変更：`src` のapp／frame-controller／deck-bridge／qaをstrict TypeScript化。Rust IPC・状態・iframe連携の型を `globals.d.ts` に定義。
- 採用：既存のTypeScript 6を利用。`build.rs` が `scripts/build-ui.mjs` を実行し、Tauriは `dist` を同梱する。追加bundler・依存パッケージなし。生成物はGit管理外。
- `pnpm typecheck:native`：成功。`pnpm build:native-ui`：型チェック＋JS生成を含め約1.16秒（単発測定）。
- `source native-app/scripts/desktop-env.sh; CARGO_BUILD_JOBS=2 cargo build --locked --manifest-path native-app/Cargo.toml -p slidev-native-poc --features desktop`：成功、初回変更反映5.95秒。
- 一時TSファイルにnumberへの文字列代入を入れた実験：TS2322でCargoが終了コード101。ファイル削除後に再ビルド成功。変更なしの次回buildは約0.221秒、再コンパイルなし。
- `NO_AT_BRIDGE=1 python3 native-app/scripts/verify.py --log native-app/artifacts/typescript-qa.log`：実Tauri/WebKitの18項目成功。資料ソース復元、同一資料のdocument維持を確認。
- `node native-app/scripts/verify-remote.mjs`：手元ChromiumでHTTP31／HTTPS31項目成功。HTTPSは既存の試験用証明書例外を利用。
- `cargo test --locked --manifest-path native-app/Cargo.toml -p slidev-native-core --quiet`：13テスト成功。coreのみの検証にはTS変換を挟まない。
- 制約：desktopビルドにはNode.jsとルートでの `pnpm install --frozen-lockfile` が必要。Node用の実験・ビルドスクリプトはmjsのまま。Windows・物理2画面の検証は今回も未実施。
- 次の確認：Rust IPCの変更時は共有TS型も更新し、型チェックと実機QAを再実行する。
