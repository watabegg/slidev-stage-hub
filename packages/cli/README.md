# CLI

`slidock` と `slive` の薄いコマンドアダプター。処理本体は Slidock / Slive tools に置きます。

ルートで `pnpm build:packages` の後、`pnpm slidock --help` / `pnpm slive:cli --help` を実行します。検証は `pnpm test:cli` と `pnpm verify:packed-cli`。Node.js 24.15 以上が必要です。

[CLI ガイド](../../docs/guides/cli.md) に設定、終了コード、private tarball の導入手順があります。Slidock の非同期公開とジョブ追跡は[公開ジョブガイド](../../docs/guides/publication-jobs.md)を参照してください。ネイティブ Slive バイナリは同梱しません。
