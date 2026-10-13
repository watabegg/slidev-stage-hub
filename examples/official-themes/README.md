# Slidev公式テーマのサンプル

公式デモは `pnpm build:slidock`（ルートの `scripts/build-official-themes.mjs`）でビルドし、`pnpm dev:slidock` で `localhost:4174` に配信します。ホーム画面は `examples/official-themes/App.vue` で編集します。`home.ts` は Vue のマウントと CSS の読み込みを行うエントリーです。ルートの `build:slidock:fixtures` および `verify:slidock:fixtures` は従来の回帰テスト用フィクスチャのビルドと検証として個別に維持されており、`verify:slidock` は新しいデモのブラウザ検証を実行します。

サンプルのファイル内容は、`https://github.com/slidevjs/themes` のコミット `6bb2889af4c66c1fbab4c1beb2e8d962a3b55648` における `packages/theme-{name}/example.md` からバイト単位で正確に複製されています。テーマのバージョンは `Default`、`Seriph`、`Shibainu`、`Bricks` が 0.25.0、`Apple Basic` が 0.25.1 です。`examples/official-themes/sources.json` でバージョン、上流パス、SHA256 ハッシュを追跡し、スクリプトがハッシュとバージョンを検証して、サンプルのフロントマター（`theme: ./`）や本文を変更せずにテーマプロファイルを渡します。指定したコミットはサンプルに適用され、固定された npm パッケージのバージョンはテーマ自体に適用されます。

コードは MIT ライセンスです。上流の規定に基づき画像やアセットには CC BY-NC-SA 4.0 が適用され、複製された上流のライセンス情報は `examples/official-themes/LICENSE` に配置されています（参照: `https://github.com/slidevjs/themes#license`）。外部画像の URL は変更せず維持しているため表示にはネットワーク接続が必要であり、一部の古い `source.unsplash.com` の URL は利用できない可能性があります。

