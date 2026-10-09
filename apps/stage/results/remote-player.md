# リモートプレイヤー機能の検証レポート

## 目的とアーキテクチャ

ローカルにスライド資産を複製して内蔵サーバーから配信する既存の運用モードを維持しながら、外部のルート HTTPS オリジンや個別に起動された HTTP ループバック環境（`localhost`、`127.0.0.1`、`[::1]`）上のスライドを直接再生できるようにすることを目的とする。

### 静的メタデータ検出と通信ブリッジ
動的な API サーバーや、制御用の実行時 HTTP API・Workers ロジックを新設することなく、静的 JSON によるメタデータ検出と `iframe` の `postMessage` ブリッジによって制御を実現した。Web ビルド時には `/native-player.json`（スキーマ：`{schemaVersion: 1, protocolVersion: 1, decks: [{id, revision, entry, clickTotals}], unsupportedDecks: [{id, reason}]}`）を出力する。既存の簡易 `v-click` パーサーを利用してスライド情報を抽出し、発表者ノートやソースコードのパスは含めず、デッキ ID は ASCII 文字列で管理する。非対応構文を含むデッキは `unsupportedDecks` に理由とともに記録され、通常の Web サイトのビルド自体は中断せず正常に完了する。通信ブリッジは HTML 内でテーマやモジュールのリスナーが登録される前に組み込まれ、埋め込みフレーム内かつ `nativeProtocol=1` が指定された場合のみ有効化される。親オリジンは `nativeParentOrigin` で固定され、マウント時およびドキュメントトークンの検証、プロトコルバージョン 1 の整合性を確認する。最上位ウィンドウで開かれる通常の Web スライドの挙動には影響を与えない。

### 権限分離と状態管理
リモートフレームに対して Tauri IPC の実行権限は付与しない。HTTP 混在プロファイルプローブを用いたクロスオリジン `iframe` の実環境検証において、IPC が公開されていないこと（`remoteIpc:not-exposed`）を確認している。再生状態の管理は Rust 側が権威を持つ。同一デッキ内の遷移ではドキュメントを再読み込みせずに維持し、別デッキへの切り替え時は遷移先の準備完了を待ってから入れ替える方式（ready-before-swap）を採用することで、保持するフレーム数を最大 2 つに抑える。ネイティブのショートカットキーは、オプトインモードが有効な場合のみ競合するテーマ側のハンドラーを上書きして優先動作する。

### 接続処理と運用上の制約
接続スクリプト（`connect.mjs`）は、タイムアウト 10 秒、最大サイズ 1 MiB、リダイレクト不許可の条件でメタデータを取得する。取得時に URL、スキーマ、プロトコル、ID、クリック境界の妥当性を検証し、成功した場合のみローカル設定をアトミックに置き換える。メタデータの取得や検証に失敗した場合は直前の設定を維持し、自己署名証明書などのエラーはターミナルに出力される。リモートモードではローカルのソースマッピングは行われず、ノートの編集機能は無効化される。ローカルへのサイト複製は不要だが、リモート側のデプロイ内容を変更した場合は接続スクリプトの再実行とアプリの再起動が必要となる。本 PoC では URL 選択用の GUI は実装されていない。

## 実行コマンドと操作手順

```bash
# 基本的な起動手順（配信サーバーの起動後、別ターミナルで接続と起動を実行）
SLIDEV_LAB_ARTIFACT_NAME=remote-player node bundle-sharing/experiments/module-graph/build.mjs
node scripts/serve.mjs artifacts/remote-player/site 4176
node native-app/scripts/connect.mjs http://127.0.0.1:4176
NO_AT_BRIDGE=1 native-app/scripts/run.sh

# 複数プロファイル構成のビルド
SLIDEV_LAB_CONFIG=bundle-sharing/experiments/multi-profile/config.json SLIDEV_LAB_ARTIFACT_NAME=remote-multi-profile node bundle-sharing/experiments/module-graph/build.mjs

# ローカル配信モードへの復帰（実行後にアプリを再起動）
node native-app/scripts/prepare.mjs --site artifacts/module-graph-offline/site
```

公開 HTTPS を利用する場合は、接続 URL を `https://slides.example.com` などに置き換えて指定する（このドメインは例示であり、実際にはデプロイされていない）。接続先ホストには `/native-player.json` を含む新規ビルドサイトを配置する必要があり、従来の素の Slidev サイトには対応していない。また、ホスト側で `iframe` 埋め込みが許可されている必要があり、`frame-ancestors` や `X-Frame-Options` による拒否設定があるとブロックされる。接続はルートオリジンのみに限定されサブパスへの配置は拒否される。ログイン認証フローは検証されていない。

## 検証実績

- **自動テストとビルド結果**: Node.js ユニットテスト計 15 件（connect: 5、native-player: 1、fingerprint: 4、prepare: 5）が合格。TypeScript の型チェック、デスクトップアプリの `cargo build`、通常の Web ライブラリテスト 15 件もすべて合格。
- **Chromium ブラウザ自動検証**: `verify-remote.mjs` により、単一プロファイル構成（HTTP 31 件 / HTTPS 31 件）および複数プロファイル構成（HTTP 47 件 / HTTPS 47 件）の全テストに合格。結果は `artifacts/remote-browser/<artifactname>/result.json` およびスクリーンショットに記録。同一デッキでのドキュメント再読み込み回数が 0 回であること、フレーム数が最大 2 に抑えられていること、ネイティブモードで競合リスナーが抑制されること、偽装・null オリジンや不正な送信元が拒否されること、不正プロトコル時にエラーが表示されることを確認。
- **実機 Tauri / WebKit 検証**: デフォルト 4 デッキ構成（`runtime-http.json`）で 17 項目、8 デッキ 4 グループ構成（Slidev 52.15.2 および 53.0.0、`runtime-multi-http.json`）で 33 項目、証明書固定 HTTPS 構成（`runtime-multi-https-pinned.json`）で 33 項目の検査に合格。スクリーンショット `native-app/artifacts/remote-audience-audience.png` により、最終的な themeB のスライド 2 が正常に描画されていることを視覚的に確認。
- **HTTPS 検証環境と再現手順**: Chromium での HTTPS テストはコンテキスト限定の `ignoreHTTPSErrors` を使用した。実機 Linux Tauri QA 環境では、OS の信頼ストアを変更せず、通常起動時の一般的な TLS バイパスも行わない安全な構成を採用した。WebKit API 経由で `NATIVE_POC_QA` および `NATIVE_POC_QA_LOCALHOST_CERT` を使用し、localhost に対してのみ指定された証明書と完全一致する場合に通信を許可している。Node.js の接続スクリプト側でもプロセスごとに `NODE_EXTRA_CA_CERTS` を指定してローカル証明書を読み込ませた。これにより、信頼できない接続が自己署名証明書エラーとして拒否され、証明書を明示的に指定した場合のみ接続に成功するという HTTPS トランスポートおよびプロトコルの挙動を検証した（本番の信頼された証明書によるホスティングを検証したものではない）。

```bash
# HTTPS 再現手順（artifacts/remote-browser/remote-multi-profile/localhost.crt および localhost.key を使用）
node native-app/scripts/serve-https.mjs artifacts/remote-multi-profile/site <cert> <key> 4179
NODE_EXTRA_CA_CERTS=<absolute cert> node native-app/scripts/connect.mjs https://localhost:4179
NO_AT_BRIDGE=1 NATIVE_POC_QA_LOCALHOST_CERT=<absolute cert> python3 native-app/scripts/verify.py --log native-app/artifacts/remote-poc/runtime-multi-https-pinned.log
# verify.py が内部で NATIVE_POC_QA=1 を設定し、ビルド済みバイナリを起動する
```

## 試行における知見と未検証事項

- **試行過程での課題と対処**: テスト環境のブラウザで待機中のフレームを `visibility: hidden` に設定した際、HTTPS 通信下の `iframe` で `requestAnimationFrame`（rAF）の実行が停止したため、本番実装と同様の `opacity: 0` に変更して解決した。並行して動作したフィクスチャ生成処理によって証明書が再生成されたため、Tauri の HTTPS 実行が 1 回タイムアウトしたが、コピーした証明書を固定してサーバーを再起動したことで正常に合格した（製品側の TLS 実装の不具合ではない）。クリック操作に伴う不透明度のトランジションは確認応答（ack）が返された後に完了する場合があり、テスト検証では安定した DOM の状態を検査している（ack の受信が CSS アニメーションの完了を意味するものではない）。
- **残存課題と未検証環境**: 既存の wake-lock に関する Feature-Policy 警告が引き続き出力される。今回の検証環境では AT-SPI に起因して `NO_AT_BRIDGE=1` の指定が必要となる。Windows 環境、物理的な 2 画面モニター環境、および実際の公開 HTTPS 環境へのデプロイは未検証である。パブリック環境へのデプロイや push は行われていない。
