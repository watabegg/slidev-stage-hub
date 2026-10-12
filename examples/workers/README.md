# Workers / Slive 用の最小資料

ルートで `pnpm build:workers` と `pnpm dev:workers` を実行してから、別のターミナルで公開します。

```sh
node packages/cli/dist/bin/hub.js publish --origin http://127.0.0.1:4180 --id demo/intro --source examples/workers/slides.md
node packages/cli/dist/bin/stage.js connect --origin http://127.0.0.1:4180 --output-config .slidev-stage/local-config.json
```

3ページ、クリック数 `[0, 2, 0]`。公開されるノートはなく、Slive のリモートノートは端末内に保存します。
詳細は [Workers ガイド](../../docs/guides/workers.md) を参照してください。
