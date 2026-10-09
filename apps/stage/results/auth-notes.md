# リモートスライド向けHTTP認証とローカルノート管理

## 目的と課題
外部ホストで配信されるスライド資料の閲覧時にも手元で発表者ノートを記録・保持し、デスクトップアプリから任意ホストへのHTTP認証ヘッダーを安全に設定・送信できるようにする。公開Webサーバー側へ独自認証APIは追加せず、既存の `native-player.json` とNative用ブリッジを備えたマルチ資料成果物を対象とする（任意のSlidevサイト全般でそのまま動作するわけではない）。なお、認証を要しない公開先であっても、接続先URLの指定のみでノート編集が可能である。

課題として、静的配信環境ではHTMLだけでなくJavaScript、CSS、画像などの全アセットで認証が要求されるため、HTMLの初回取得時のみヘッダーを付与する方式では表示を完結できない。また、認証ヘッダーのUI・ログ・設定ファイルへの漏出防止や、プロキシ再起動によるポート変動、スライド更新時にも手元のノートを破綻なく保持する仕組みが求められた。

## 採用方式と設計判断
全アセットへ認証ヘッダーを付与するため、レンダラー（WebKit）から直接外部へアクセスさせず、Rust側で `127.0.0.1` の一時ポートに読み取り専用プロキシを立ち上げる方式を採用した。レンダラーはローカルプロキシにGET要求を送り、Rustが同一配信元（upstream origin）へのアセット取得時にHTTPヘッダーを付与して中継する。

認証方式:
- 接続先originを固定したJSONファイルから任意のHTTPヘッダー（`Authorization: Bearer <token>`, `X-API-Key`, `Cookie`, `CF-Access-Client-Id` / `CF-Access-Client-Secret` 等）を読み込む。特定プロバイダー固有の処理は持たない。
- 認証ファイルはリポジトリ外への配置を推奨し、Unix権限0600を必須とする。上限は64KiBかつ64ヘッダーまで。平文ファイルであり、OSキーチェーンや暗号化には未対応。アプリ起動時に読み込まれ、更新時はファイル差し替えとアプリ再起動を行う。
- `connect.mjs` はメタデータ取得にヘッダーを使用し、`local-config.json` には絶対ファイルパス `authHeadersFile` のみを保存して値自体は保持しない。プロキシはGET/HEADのみ中継し、リダイレクトは追従しない。レスポンスの `Set-Cookie` や認証ヘッダーはレンダラーに渡さず、ブラウザ側のCookieやAuthorizationも配信元へ転送しない。アセットは `no-store` とし、CSPおよびX-Frame-Optionsは維持する。ヘッダー値はJavaScript、設定、ログへ明示的に公開しない。
- 対応範囲はHTTPSのルートorigin、およびHTTPの正確なlocalhost（`127.0.0.1`, `[::1]`）ルートのみ。パス配下のマウントや外部CDNへの認証ヘッダー送信は非対応。絶対上流URL（absolute upstream URL）はプロキシを経由しないため、成果物は同一originの相対URLを用いる必要がある。
- 対話的SSO、多要素認証（MFA）、端末状態確認（device posture）、相互TLS（mTLS）、トークン自動更新には対応しない。有効な固定HTTPヘッダーのみでリソースを取得できる方式を対象とする。

リモートノート管理:
- 保存先はTauriの `app_data_dir()/remote-notes/notes.json`（Linux通常 `~/.local/share/local.slidev.lab/remote-notes/notes.json`、`XDG_DATA_HOME` 変更時はその配下、JSON schemaVersion 1）。公開先へは書き込まず、ローカルMarkdownのコメント編集は従来方式を維持する。
- ノートのキーには一時プロキシのポートや資料リビジョンを含めず、正規化された配信元originと `/deckId/page` の完全URLを用いる（origin/資料/ページで分離）。これによりプロキシポートが変動しても同一ノートが維持される。
- 保存済みノートのみ再起動後も残り、下書きはメモリ上でのみ保持する。OSファイルロック、`expectedRevision` の照合、アトミックなファイル置換で整合性を担保する。
- リビジョンが変更された場合もノートは保持し、ノート読み取り応答の `sourceChanged` フラグによりUI上に警告を表示する。ページの挿入による意味的なずれには自動追従しない。リビジョンの更新を取り込むには再接続の実行とアプリの再起動が必要となる。

## 利用手順と設定例
1. リポジトリ外に権限0600のJSONファイルを作成する。
   ```json
   {"origin":"https://slides.example.com","headers":{"Authorization":"Bearer <token>"}}
   ```
   ※Cloudflare AccessのService Token（[公式ドキュメント](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)）を利用する場合は、`CF-Access-Client-Id` と `CF-Access-Client-Secret` を指定し、Access側Service Authポリシーで許可しておく（Cloudflare管理APIトークンではない。実環境・実トークンでは未検証）。
2. メタデータの取得と接続設定を実行する。
   ```bash
   node native-app/scripts/connect.mjs https://slides.example.com --headers-file /absolute/private/auth.json
   ```
3. アプリを起動する（`NO_AT_BRIDGE=1` は従来のAT-SPI起動回避用であり、アクセシビリティ検証ではない）。
   ```bash
   NO_AT_BRIDGE=1 native-app/scripts/run.sh
   ```
- デスクトップ環境のビルドコマンド:
  ```bash
  bash -c 'source native-app/scripts/desktop-env.sh; CARGO_BUILD_JOBS=2 cargo build --locked --manifest-path native-app/Cargo.toml -p slidev-native-poc --features desktop'
  ```

## 実験環境と再現手順
Ubuntu Wayland上のTauriおよびWebKit環境で検証を実施した。テスト用ローカルサーバー `serve-auth-fixture.mjs` は擬似認証情報を生成し、BearerヘッダーとCloudflare風の2ヘッダーが全て揃った場合のみ静的アセットを返し、値はログに出力しない。

HTTP検証手順:
```bash
node native-app/scripts/serve-auth-fixture.mjs artifacts/remote-multi-profile/site native-app/artifacts/auth-poc/http 4180
node native-app/scripts/connect.mjs http://127.0.0.1:4180 --headers-file native-app/artifacts/auth-poc/http/credentials.json
NO_AT_BRIDGE=1 NATIVE_POC_NOTES_DIR="$PWD/native-app/artifacts/auth-poc/notes" python3 native-app/scripts/verify.py --log native-app/artifacts/auth-poc/http-first.log
```
※`NATIVE_POC_NOTES_DIR` は `verify.py` が設定する `NATIVE_POC_QA=1` の環境でのみ有効となり、通常保存先を汚さない。

HTTPS検証手順:
1. 証明書の作成（事前に `mkdir -p native-app/artifacts/auth-poc/tls` を実行）。
   ```bash
   openssl req -x509 -newkey rsa:2048 -nodes -keyout native-app/artifacts/auth-poc/tls/localhost.key -out native-app/artifacts/auth-poc/tls/localhost.crt -days 1 -subj /CN=localhost -addext 'basicConstraints=critical,CA:FALSE' -addext 'keyUsage=critical,digitalSignature,keyEncipherment' -addext 'extendedKeyUsage=serverAuth' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
   ```
2. 出力先に `native-app/artifacts/auth-poc/https-valid`、ポート4182、作成したcrt/keyを指定してfixtureを起動。
   ```bash
   node native-app/scripts/serve-auth-fixture.mjs artifacts/remote-multi-profile/site native-app/artifacts/auth-poc/https-valid 4182 native-app/artifacts/auth-poc/tls/localhost.crt native-app/artifacts/auth-poc/tls/localhost.key
   ```
3. `connect.mjs` には `NODE_EXTRA_CA_CERTS`、`verify.py` には `NATIVE_POC_QA_LOCALHOST_CERT` の絶対パスを指定して実行。OS信頼ストアを変更せず、localhost限定のプロセス内追加信頼によりTLS証明書およびホスト検証を保持する。

## 検証結果（2026-10-09）
- 単体テスト・ビルド: Rust 26件（core 13 + auth 13）、Node 18件（connect/auth）のテスト、およびdesktopビルドに合格。CLIでの認証なし時401応答、認証あり時のメタデータ取得成功を確認。単体テストにてorigin不一致、旧リビジョン競合、ファイル再読込、リダイレクト拒否、秘密値非表示などを検証。
- WebKit実機HTTP検証: 8資料36項目の初回実行（`http-first.json`）、再起動後36項目（`http-restart.json`）、リビジョン変更37項目（`http-updated.json`）が成功（成果物は `native-app/artifacts/auth-poc/` 配下）。再起動でプロキシポートが46709から40133へ変化しても同一ノートを保持した。リビジョン変更は `local-config.json` の先頭 `deck.revision` に `-updated-fixture` を追加する変更注入実験を行い、警告表示と保存後の警告クリアを確認した（実スライド編集ではない）。
- WebKit実機HTTPS検証: 8資料36項目が成功（`https-valid.json`）。上流リクエストでTLS=trueおよびBearer・CF風2ヘッダーの一致をfixtureで強制確認（実Cloudflareサービスでの検証ではない）。スクリーンショット `native-app/artifacts/remote-audience-audience.png` により実際の描画を確認済み。
- 回帰検証: 認証なしの外部接続（`http://127.0.0.1:4177`）でローカルノートの保存と再読み込みを含む36項目が成功した（`direct.json`）。従来のローカル配信18項目も成功し、元Markdownのハッシュ一致を確認した（`local-regression.json`）。
- 秘密情報保護: 設定ファイル、QAログ、fixtureアクセスログを検索し、生成された擬似認証情報値の漏出が0件であることを確認（認証ファイル自体を除外して検索、生成成果物はgitignored）。
- 失敗事例と採否判断: 既存の自己署名証明書（`basicConstraints=CA:TRUE`）をサーバー証明書に流用した際、Nodeは通過したがRustlsで `CaUsedAsEndEntity` が発生し、WebView準備がタイムアウトした（失敗証跡: `https.json`）。証明書検証の無効化は採用せず、`CA:FALSE`、`serverAuth`、`SAN` を設定した適切なサーバー証明書を作成する方針を採用した。また、全アセットで認証が必要なためHTMLのみヘッダーを付与する方式は退け、ネイティブ側GET/HEADプロキシを採用した。

## 制約事項と次の実験
- 制約事項: 認証情報は平文ファイル保存でありOSキーチェーンには未対応。対話的SSO、MFA、端末状態確認、mTLS、トークン自動更新には対応せず、固定HTTPヘッダーのみを対象とする。ルートoriginのみ対応し、パス配下のマウントや外部CDNへのヘッダー送信は非対応。スライドのページ挿入による意味上のずれには自動追従しない。
- 未検証事項: 実際のCloudflare環境（WorkersおよびCloudflare Access Service Auth）へのデプロイや実トークンでの検証、Windows / WebView2環境、物理2画面構成、実IdP連携は未実施。
- 次の実験・検討: 実際のCloudflare WorkersとAccess Service Authを用いた信頼済み公開HTTPSでの動作検証。必要に応じてOSキーチェーン連携、接続設定用GUI、トークン更新プロバイダー連携、スライドのページ挿入に対するノート追従を別途検討する。
