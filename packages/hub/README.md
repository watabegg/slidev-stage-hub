# Hub

Run commands from the repository root:

```sh
pnpm --filter @slidev-stage-hub/hub typecheck
pnpm --filter @slidev-stage-hub/hub test
pnpm build:hub
pnpm dev:hub
```

`build:hub` creates the module-graph site, compiles the shared native protocol bridge, and prepares its offline copy. `dev:hub` serves that copy at `http://127.0.0.1:4174/`. Source fixtures live in `examples/fixtures/`; manifest `sourcePath` values stay relative to this package root so Stage can resolve them.

The theme and its Slidev/Chromium dependencies default to `/home/watabegg/slidev-watabegg`. Set `SLIDEV_THEME_PATH` to use another local theme checkout. This PoC still expects a local theme installation with its matching Slidev and Chromium packages.
