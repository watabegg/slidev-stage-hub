# CLI

`hub` と `stage` の薄いコマンドアダプター。処理本体は Hub / Stage tools に置きます。

ルートで `pnpm build:packages` の後、`pnpm hub --help` / `pnpm stage:cli --help` を実行します。検証は `pnpm test:cli` と `pnpm verify:packed-cli`。Node.js 24.15 以上が必要です。

[CLI ガイド](../../docs/guides/cli.md) に設定、終了コード、private tarball の導入手順があります。Hub の非同期公開とジョブ追跡は[公開ジョブガイド](../../docs/guides/publication-jobs.md)を参照してください。ネイティブ Stage バイナリは同梱しません。
