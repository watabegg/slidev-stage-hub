# Slidev Cloudflare 実環境検証記録

## 目的とシステム構成

slidev-lab を Cloudflare の実環境へ展開した動作確認結果、再現手順、および制約事項を開発者向けに記録します。2026年10月9日にユーザーの許可を得て、watabegg@gmail.com の Cloudflare アカウント上に専用リソースを作成しました。既存サービスへの変更や契約プランのアップグレードは行っていません。

- 公開 URL: https://slidev-lab-poc.watabegg.workers.dev
- Worker デプロイバージョン: `57a9153d-e0e7-4afe-ab75-cbe8402badb3`（起動時間 62ms、Worker gzip 497.01KiB、ランタイムアセット別）
- リソース構成:
  - Worker: `slidev-lab-poc`
  - R2 バケット: `slidev-lab-poc-20261009`（APAC hint）
  - SQLite Durable Object: `DeckVersions`
  - 静的アセット: 98 ファイル（Workers Assets）
  - バインディング: Browser Run

本構成では、事前ビルドした Slidev 53 と固定テーマの Vue ランタイムを Workers Assets で配信します。送信された Markdown は Worker 上で Vue ESM および UnoCSS に変換され、不変なリビジョン成果物として R2 に保存されます。最新リビジョンの状態管理には Durable Object を使用し、ブラウザ側での変換処理やコンテナ実行は行いません。今回の検証では `cloud/demo` および合成した 5、50、100 ページのスライドを公開しました。

## 認証と機密情報の管理

更新系 API（`publish` の POST、および `thumbnail` の POST/PUT）には `Bearer PUBLISH_TOKEN` による認証を追加し、公開 GET リクエストは認証なしで受け付けます。`PUBLISH_TOKEN` が設定されている場合は常に認証を必須とし、トークン未設定かつ `LOCAL_MUTATIONS=true` かつホスト名が localhost（`localhost`、`127.0.0.1`、`[::1]`）の場合のみトークンなしの変更を許可します。リモート環境では `LOCAL_MUTATIONS=false` とし、公開デモとしての検証であるため、Cloudflare Access 認証は今回検証していません。

トークン管理用のファイル（`artifacts/workers/publish-token` および `cloud-secrets.json`）は Git 管理から除外（gitignored）し、権限を 600（`chmod 600`）に設定してログや文書へ値を出力しません。環境構成スクリプト `cloud-config.mjs` は既存トークンを再利用します。

## 機能検証と不具合対応

実クラウド API の検証により以下の動作を確認しました。詳細な記録は [remote-verification.json](remote-verification.json) および初期失敗と独立した継続検証を記録した [remote-verification-before.json](remote-verification-before.json) に保存しています。

- **API 挙動**: 未認証および誤トークンに対する HTTP 401 応答、認証付き公開の成功、同一内容送信時のキャッシュ応答、script タグの拒否と旧版の維持、ノートの非公開化、公開共有ランタイムおよびアセットの取得、Markdown 更新時の旧版保持と current・catalog の更新を確認しました。
- **手元ブラウザ表示**: 手元の Google Chrome から公開 URL へアクセスし、カバー表示、Enter キーによるページ送り、`v-click`、SVG 画像の読み込み、およびコンソールやページのエラーがないことを確認しました（Browser Run とは別に検証）。
- **Browser Run によるサムネイル生成**:
  - 初回検証時に画像の寸法不一致（dimensions mismatch）による HTTP 400 エラーが発生し、診断でも再現しました。
  - セレクタ指定での撮影を取りやめ、1200×675 の固定ビューポート指定に変更し、`fullPage` および `captureBeyondViewport` を false に修正しました。あわせてテスト側で `usedMs > 0` を必須としていた判定の誤りも修正しました。
  - 修正後は HTTP 200（所要時間約 9.5 秒）でサムネイルが生成され、PNG 実体の確認および保存済み画像の再利用を検証しました。なお、レスポンスから時間メタデータを取得できず `usedMs` は null となるため、正確な課金・無料枠消費時間は測定できていません。生成された画像は Git 除外の `artifacts/workers/remote-thumbnail.png` に保存されます。

今回のアカウントでの成功のみをもって、Browser Run の無料プランでの利用可否や Workers Free での動作を保証するものではありません。請求額、ピークメモリ、高負荷試験は未測定です。

## 性能測定と並列保存による改善

初回の 100 ページ公開処理では 61 秒を要しました。原因として R2 への逐次書き込みが疑われたため、6 件単位の `Promise.allSettled` による並列保存へ改修しました。全ページの保存完了後にマニフェストと current を更新する整合性の順序は維持しています。

測定結果は以下の通りです。1 回ずつの測定であり、ネットワークやキャッシュの揺れを含みます。HTTP 時間は変換、R2 保存、Durable Object 更新、通信時間を含み、CPU 時間はリモートの `wrangler tail` から取得した実 CPU 時間です（CPU 時間と経過時間は別指標）。詳細は [remote-benchmark.json](remote-benchmark.json)、[remote-benchmark-before.json](remote-benchmark-before.json)、および [cloud-metrics.json](cloud-metrics.json) を参照してください。

| ページ数 | 改善前 HTTP (ms) | 改善後 HTTP (ms) | 改善前 CPU (ms) | 改善後 CPU (ms) | 改善後キャッシュ済 HTTP (ms) |
| --- | --- | --- | --- | --- | --- |
| 5 | 5,488 | 1,849 | 118 | 104 | 493 |
| 50 | 32,110 | 8,721 | 256 | 148 | 411 |
| 100 | 61,065 | 14,018 | 353 | 178 | 545 |

改善後の 100 ページ処理における Worker CPU 時間は 178ms でしたが、この数値のみから Free プランに適合するとは結論付けません。なお、ローカル単体テスト（27/27）、認証統合テスト、API テスト（19 件）、ストレステスト（21 件）もすべて通過しています。

## 制約事項と未実装機能

本構成は認証付き公開 API に Markdown を送信する実証実験であり、以下の制約と未実装事項があります。

- **運用と更新**: Markdown の更新のみであれば Worker の再デプロイは不要ですが、新テーマの追加やランタイムの変更には共通ランタイムの再ビルドと再デプロイが必要です。
- **未実装**: R2 への Markdown 直接配置（PUT）を契機とするイベント通知や Queues による自動処理、既存 Web・Native アプリケーションへの統合は未実装です。
- **構文制限**: Mermaid、生の Vue テンプレート（raw Vue template）、ファイルのインクルード（includes）などは未対応です。数式は警告を出力した上でプレーンテキストとして扱われます。制約の詳細は [expansion.md](expansion.md) を参照してください。

## 再現手順

検証手順はリポジトリルートではなく `bundle-sharing/experiments/workers` ディレクトリで実行します。R2 バケットは作成済みのため再作成は不要です。`cloud-config.mjs` は専用アカウントおよび固定名を使用します。Wrangler の認証が必要ですが、Cloudflare API トークン値をコマンド引数に直接記述しないでください。

```bash
pnpm install --frozen-lockfile
pnpm build:runtime
node cloud-config.mjs
pnpm exec wrangler deploy --config wrangler.cloud.json --secrets-file ../../../artifacts/workers/cloud-secrets.json
SLIDEV_POC_TOKEN_FILE=../../../artifacts/workers/publish-token node remote-verify.mjs https://slidev-lab-poc.watabegg.workers.dev
SLIDEV_POC_TOKEN_FILE=../../../artifacts/workers/publish-token node remote-benchmark.mjs https://slidev-lab-poc.watabegg.workers.dev
```

## 今後の実験候補

未実施の実験候補として以下を検討しています。

- R2 への直接アップロードと Queues を連携させた自動変換処理
- 実際の各種スライド資料に対する構文互換性の拡大
- 成果物の集約形式との比較による R2 書き込み遅延の削減
- 実運用プランにおけるリソース使用量および費用の確認

## 最終確認メモ

- 実クラウド検証は33項目通過。更新版の撮影も7.2秒で成功し、1200×675のPNGを目視確認した。利用時間メタデータは取得できなかった。
- 検証CLIの `--help` が結果JSONを上書きする不具合を修正した。該当結果は保存済みの実行出力から復元し、画像取得・キャッシュ応答・更新版の撮影は追加実行した。出所はJSONの `recovery.artifactProvenance` に記録している。
