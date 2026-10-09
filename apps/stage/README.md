# ネイティブ発表 PoC

Rust を進行状態の正本とする Tauri 2 のローカル実験。manifestから準備した資料のレジストリから発表者・聴講者の 2 ウィンドウを生成する。実測と制約は [結果メモ](results/2026-10-08-native-poc.md) を参照。

```bash
# monorepo root から。OS へのインストールは行わない。
pnpm install --frozen-lockfile
pnpm browser:install
# Optional local GTK/WebKit SDK extraction; this does not install OS packages.
python3 apps/stage/scripts/prepare-sdk.py
pnpm build:hub
pnpm stage:prepare
pnpm build:stage-ui
NO_AT_BRIDGE=1 pnpm stage

# 実際の WebView を起動し、JSON・PNG・ノート差分を保存して終了する。
NO_AT_BRIDGE=1 python3 apps/stage/scripts/verify.py
cargo test --locked --manifest-path apps/stage/Cargo.toml -p slidev-native-core
```

`NO_AT_BRIDGE=1` はこの PC の AT-SPI 起動クラッシュを避ける実験条件で、アクセシビリティ対応の合格を意味しない。Windows と物理 2 画面は未検証。

資料は 設定ファイルの隣の `versions/<id>/site/` へコピーし、設定の `siteRoot` で参照して、`127.0.0.1` の一時ポートから読み取り専用で配信する。`NATIVE_POC_TRANSPORT=protocol` で比較用 `deck://localhost` 経路を使える。IPC はローカルのラッパー画面で受け、資料フレームへファイル操作権限を渡さない。

進行は `next / previous / toggleBlackout / selectDeck / toggleTimer / resetTimer`。入力元ごとの連番で重複を拒否し、状態イベントを入力へ再変換しない。ノート編集中はキー送りを抑制する。次スライドは操作不可。

ノート対応表は Slidev 53 の parser から生成し、公開成果物の外に置く。既存の末尾 HTML コメントだけ編集できる。保存時に私有の対応表も更新し、再起動後も読み直せる。外部変更や古い編集リビジョンは保存を拒否する。ソース再読み込みは `prepare.mjs` とアプリ再起動で行う。下書きはページごとに保持するが、アプリ終了後は保持しない。

同一資料のページ／クリック更新はiframeを再読込せず、Native専用のrouter bridgeで反映する。別資料は予備フレームで描画を確認してから交換する（主表示は最大2フレーム）。[比較実験](results/flicker.md) に基準値と再現手順を記録した。

別fixtureを使うときは `node apps/stage/scripts/prepare.mjs --site <成果物> --fixtures-root <ソースディレクトリ>`。manifest の資料一覧とソースを照合する。現在のStageはASCIIの資料IDと単純な `v-click` のみ対応し、複雑なクリック指定は準備時に停止する。

既存のHTTPSホストや別途起動したlocalhostへ接続するPoCも利用できる。今回のWebビルドが生成する `native-player.json` と連携コードが必要。

```bash
node apps/stage/scripts/connect.mjs http://127.0.0.1:4177
# 公開先なら https://slides.example.com のようなルートURLを指定
NO_AT_BRIDGE=1 pnpm stage
```

リモート接続時のノートは、元の接続先URL・資料パス・ページ番号ごとに端末内へ保存する。公開先には送信しない。元の内部配信へ戻すには `prepare.mjs --site <ローカル成果物>` を実行して再起動する。HTTPSの試験条件と詳細は [remote-player.md](results/remote-player.md) を参照。

認証付きホストには `connect.mjs <origin> --headers-file /absolute/private/auth.json` で接続する。ファイルは `{"origin":"https://slides.example.com","headers":{"Authorization":"Bearer <token>"}}` の形式で、Unixでは権限を `600` にする。Nativeが同一ホストへのファイル取得に指定ヘッダーを付ける。Cloudflare AccessのService Token用ヘッダー2つも指定できる。利用条件・実験結果は [認証とローカルノート](results/auth-notes.md) を参照。

Stage画面・iframe制御・実機QAは `apps/stage/src/*.ts` で管理する。共有bridgeは `packages/protocol/` で管理し、`cargo build/run --features desktop` が共有 protocol と Stage UI の型チェック・生成を自動実行する。型チェック、UI生成、Node tests は次のコマンドで実行する。Rust coreのみのテストではTypeScript変換を実行しない。

```bash
pnpm --filter @slidev-stage-hub/stage typecheck
pnpm --filter @slidev-stage-hub/stage build:ui
pnpm --filter @slidev-stage-hub/stage test
```

準備・接続サービス、`--config`、旧設定との互換性は [Stageツール開発ガイド](../../docs/guides/stage-tools.md) を参照。
