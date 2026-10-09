# VueのTypeScript移行（2026-10-09）

- 採用: `Home.vue`を`<script setup lang="ts">`へ変更。catalogの公開データ型を共有し、frontendの3つのエントリも`.ts`へ移行。表示と操作は維持する。
- `pnpm typecheck`: strict設定・strictTemplatesで合格。TypeScript 6.0.3、Vue 3.5.43、vue-tsc 3.3.12を固定。
- `SLIDEV_LAB_ARTIFACT_NAME=typescript node bundle-sharing/experiments/module-graph/build.mjs`: 合格（7,498ms、235ファイル）。従来からの大きなchunkの警告は残る。
- `node scripts/verify-library.mjs artifacts/typescript/site`: 15項目合格。一覧、カテゴリ、サムネイル、スライド、ホームへの復帰、埋め込み表示を確認。
- 外部テーマ、Nativeの素のJavaScript、Nodeスクリプトは移行していない。既存4174の配信成果物は変更していない。
