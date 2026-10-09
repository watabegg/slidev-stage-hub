# Cloudflare WorkersによるSlidev資料コンパイルの実現可能性調査メモ

本稿は2026年10月9日時点における、Cloudflare Workersを用いたSlidevスライド資料コンパイルの実現可能性に関する追加調査メモである。今回はソースコードおよび公式ドキュメントの調査のみに基づいており、実際のビルド、概念実証（PoC）、実装、デプロイ、実行速度やメモリ消費量の計測は実施していない。

## 基本方針と担当範囲の整理

ユーザーの要望は、既存テーマを利用する範囲であれば、Markdownファイルや画像ファイルをCloudflare R2へアップロードするだけで資料を公開可能にすることにある。閲覧者のブラウザ側でコンパイルを実行させず、運用管理が複雑になりやすいCloudflare Containersも避け、Cloudflare Workersの利用を許容する構成が求められている。

この要望に対し、登録済みプロファイルの範囲に限定するならば、Workers上でスライド資料をコンパイルする設計は技術的根拠があり有力な選択肢となる。前回のメモでContainerの採用を推奨したのは既存のビルド処理をそのまま流用する前提に立っていたためであり、コンパイル処理を切り離して再設計すればContainerの採用は必須とは限らない。ただし、全体としての統合動作やSlidevとの完全な互換性は現時点で未検証である。

純粋にCloudflare Workers、R2、通知用のCloudflare Queuesの組み合わせで実現を狙える範囲は、JavaScript、CSS、メタデータの生成および配信である。忠実な先頭ページPNGサムネイルの自動生成には、別途[Cloudflare Browser Runのスクリーンショットエンドポイント](https://developers.cloudflare.com/browser-run/quick-actions/screenshot-endpoint/)を利用するか、事前の画像アップロードが必要となる。Browser Runは閲覧者のブラウザではなくCloudflareが管理するChromeインスタンスであり、Worker自体の内部で直接描画を行うわけではない。HTMLからSVGへ変換するなどの簡易な代替手段では既存の実描画と同等の見た目を保証できない。また、Browser Runには別サービスとしての利用制限や課金が発生するため、厳格にWorkers単体のみで完結させる場合は事前の画像アップロードを前提とする。

## パイプライン設計と個別アダプタ要件

現行の `bundle-sharing/experiments/module-graph/build.mjs` は `ViteSlidevPlugin` と Vite のビルド処理を利用しており、`deckIds` やインポート一覧をビルド時に固定している。そのため、既存の実装を単純にWorkerへ移植するだけでは動作しない。

提案するパイプラインでは、以下の段階を経て成果物を生成する。

1. R2に配置されたソースファイルを検知し、Queue経由でWorkerを起動する。
2. パーサーでスライド構成を解析する。
3. Slidev向けのMarkdown変換およびレイアウトの注入を行う。
4. VueコンパイラでESM形式のJavaScriptを生成し、UnoCSSでCSSを生成する。
5. 生成された成果物をR2へリビジョンごとのアーティファクトとして保存する。

閲覧者側にはコンパイラを送信せず、生成されたJavaScriptはブラウザ側で実行され、Worker自身は生成した文字列を実行せず、保存と配信を担当する。

この構成を実現するには、各コンポーネントを独立して組み合わせる必要がある。スライド解析において、`@slidev/parser` 53.0.0 の通常エントリは YAML処理を含む `core.mjs` や `utils.mjs` からのAPIをエクスポートしており、CLIが使用するファイルシステム依存の `parser/fs` とは分離されている。これはページ分割やフロントマター解析の再利用候補となるが、`src` によるインクルード構文などの解決にはR2用のリゾルバを独自に実装する必要がある。また、通常パーサーのみでSlidevの描画全体が得られるわけではない。

テンプレート処理では、Vueの [`@vue/compiler-sfc` 3.5.43](https://github.com/vuejs/core/tree/v3.5.43/packages/compiler-sfc) が `parse`、`compileScript`、`compileTemplate`、`compileStyle` に相当するAPIを提供しており、`compileTemplate` はモジュールモードのJavaScript文字列を返却する。ただし、SFCの `<script>` 内にTypeScriptが含まれる場合、`compileScript` だけでTypeScriptの除去が完了するわけではないため、JavaScriptベースの別変換処理を用意するか、許可する構文を制約する必要がある。

スタイル生成においては、[`@unocss/core` の `createGenerator().generate(code)`](https://unocss.dev/tools/core) を使用することで、Viteプラグインを介さずにCSSを取得できる。ただし、プリセット設定、アイコンデータ、テーマ固有の静的CSSの読み込み、CSSの適用順序やスコープ付きスタイルの処理は別途自前で対応しなければならない。

テーマ運用については、テーマ登録時にVueおよびSlidevの共通ランタイム、テーマ固有のコンポーネント、レイアウト、セットアップ（`setup`）、ショートカット（`shortcuts`）を事前にビルドしておく方式を採る。スライド資料から参照可能なエクスポートとインポートのマッピングを定義し、同一のVue/Slidevインスタンスに接続する。使用候補となるコンポーネントをあらかじめエクスポートして後から利用可能にするため、資料全体の集合に対してtree-shakingを行っていた従来方式に比べ、総保存容量が増加する可能性がある。閲覧時の転送負担を抑える手段としてコンポーネント単位の遅延読み込み（lazy chunks）が考えられるが、その効果や容量は未計測である。

パイプラインの中核となる自前アダプタの実装も不可欠である。Slidev CLI 53.0.0 の `serve-DzvJFv6v.mjs` 内にある `createLayoutWrapperPlugin` は、レイアウトのインポート、フロントマターのprops、`useSlideContext`、`$clicksContext.setup` などを注入している。Markdown、`v-click`、スロット、コンテキスト、コードブロックや数式などの変換処理は、Slidevのバージョンを固定したうえで再利用または切り離して実装する必要があり、単にMarkdownをHTML化するだけでは代替できない。固定テーマの `section.vue` も `useSlideContext` に依存している。なお、`setup/shortcuts.ts` はブラウザのナビゲーション処理を呼び出すものであるため事前ランタイムに残せる見込みがあり、設定の衝突隔離は現行どおりドキュメント単位を維持する。

## Workers実行環境の制約と対応範囲

標準のCloudflare Workers環境には[Web標準APIにおけるeval実行の制約](https://developers.cloudflare.com/workers/runtime-apis/web-standards/)が存在し、リクエスト処理内での `eval` や `new Function` の実行が制限されている。Vueの `@vue/compiler-sfc` のブラウザ向けビルド（esm-browser）にも、静的文字列化処理の中に `evaluateConstant` から `new Function` を呼び出す経路が存在する。[`compileTemplate` では `hoistStatic` が既定で `true` だが上書きが可能](https://github.com/vuejs/core/blob/v3.5.43/packages/compiler-sfc/src/compileTemplate.ts) であり、[`@vue/compiler-core` の `transform`](https://raw.githubusercontent.com/vuejs/core/v3.5.43/packages/compiler-core/src/transform.ts) は `hoistStatic` が `true` の場合のみ `cacheStatic` に入るため、`hoistStatic: false` を指定することで該当のeval経路を回避できる可能性がある。ただし、これだけで全経路の安全性や互換性が確認されたとは言えず、単にブラウザ向け配布物を選択するだけで動作するとも言えない。なお、コンパイル結果自体をWorker内でeval実行する必要はない。

プラットフォームのリソース制限として、[Cloudflare Workersの制限仕様](https://developers.cloudflare.com/workers/platform/limits/)によりメモリ上限は1アイソレートあたり128MB、起動時間は1秒に制限されている。HTTPリクエスト時のCPU時間は無料プランで10ms、有料プラン（Paid）で標準30秒（最大5分）である。今回のコンパイル処理には有料プランの利用を前提とすることを推奨する。また、Cloudflare QueuesにはHTTPトリガーとは異なる時間制限が存在するため、HTTPの制限値をすべてのトリガーにそのまま流用してはならない。実際の処理に要するリソース量は未計測であり、同時実行時の挙動やページ単位での分割処理の要否を検証する必要がある。

対応範囲については、任意のnpmパッケージのインストール、Node.js依存のプラグイン、任意のsetup処理、PugやSassなどのプリプロセッサには自動対応せず、登録済みの対応プロファイルに固定する。新しいテーマ、プラグイン、変換機能を追加する場合は、事前ビルドの再実行やコンパイラWorkerの再デプロイが必要になりうる。すでにサポートされている構成のMarkdownファイルだけであれば、Workerを再デプロイすることなく公開できる状態を目指す。

シンタックスハイライトには、[ShikiのJavaScript正規表現エンジン](https://shiki.style/guide/regex-engines)が利用可能である（現在のCLIでも使用されている）。対応言語やテーマを限定することで、バンドルサイズやWorkerの起動コストを抑制できる見込みがある。ただし、Monaco Editor、Twoslash、Magic Moveなどの高度な機能については、初期段階からの完全対応を約束するものではない。

運用面では、メタデータと表示リビジョンの一致、公開ポインタの切り替え、旧リビジョンの保持といった設計は前回の調査メモの案を引き継ぐ。生のMarkdownファイルや発表者ノート（notes）は非公開（private）として保護する。また、Nativeクライアントへの接続については、リビジョンを固定するための拡張が必要となる。

## 次期検証事項（未実施のPoC項目）

設計の妥当性を確認するため、今後以下の概念実証（PoC）を実施して判定を行う。

1. **基本変換と描画の検証**: workerd環境上でVue、UnoCSS、Markdownの変換処理を実行し、静的な定数式を含むスライド資料から生成されたESMがブラウザ上で正常に描画できるか確認する。動的なeval経路を通さずにコンパイルが完了できるかを検証する。
2. **テーマ機能と互換性の比較**: 実テーマに含まれる `cover`、`section`、`FigureGrid` コンポーネント、`v-click`、スコープ付きCSS、新規UnoCSSクラス、画像、コードブロックを変換し、既存のビルド成果物と比較する。Vueインスタンスの重複が発生せず、`shortcuts` の衝突がないことを確認する。
3. **リソースと運用の測定**: リビジョンの更新、資料の追加、Native連携用メタデータの生成を行い、コールドスタート時およびウォーム時のCPU時間、ピークメモリ消費量、バンドルサイズを測定する。単にNode.js上で動作するだけでなく、Workersの実行環境基準を満たしているかを判定する。
