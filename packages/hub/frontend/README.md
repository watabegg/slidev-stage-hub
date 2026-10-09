# 資料ライブラリのカスタマイズ

`Home.vue` がホーム画面、`style.css` がそのスタイル。Vueの `catalog` propだけで一覧を組み立てられる。`home.ts` が `/catalog.json` を取得してマウントする。

共有ビルドでリポジトリの `examples/fixtures/`（Hubから `../../examples/fixtures`）以下のMarkdownを再帰探索する。`aaa/aaa1/slides.md` と `aaa/aaa1.md` はどちらも資料ID `aaa/aaa1`、カテゴリ `aaa` になる。ID重複はエラー。README、AGENTS、隠しディレクトリ、assets、public、node_modulesは探索対象外。

`catalog.json` の `decks` には次を公開する。

- `id`、`title`、`entry`（閲覧URL）、`pages`、`revision`
- `categoryPath`（階層を保持した配列）
- `frontmatter`：title、subtitle、author、date、description、tags
- `thumbnail`：先頭ページPNGの `src`、`width`、`height`

`categories` は各階層の `id`、`name`、`path`、`parentId` を持つ。ノートやテーマ設定は公開メタデータに含めない。

サムネイルはビルド時にChromiumで実際の先頭ページを描画する。単独再生成は `node scripts/thumbnails.mjs artifacts/module-graph/site`。このPCでは `/usr/bin/google-chrome` を使い、`CHROMIUM_EXECUTABLE` で変更できる。

`navigation.ts` がブラウザ閲覧中の常設ホームリンクを追加する。操作パネル内はテーマ既存の `themeConfig.watabegg.navigation` を利用する。iframeと `?embedded=true` ではホスト側の操作を使うため両方を非表示にする。

`Home.vue` は `<script setup lang="ts">` を使用する。公開データの型は `catalog.ts` に定義している。`pnpm typecheck` でフロントエンドのTypeScriptとVueテンプレートをstrictモードで検証する。
