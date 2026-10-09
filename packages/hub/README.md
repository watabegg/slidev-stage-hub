# Hub

Run commands from the repository root:

```sh
pnpm --filter @slidev-stage-hub/hub typecheck
pnpm --filter @slidev-stage-hub/hub test
pnpm build:hub
pnpm dev:hub
```

`build:hub` creates the module-graph site, compiles the shared native protocol bridge, and prepares its offline copy. `dev:hub` serves that copy at `http://127.0.0.1:4174/`. Source fixtures live in `examples/fixtures/`; manifest `sourcePath` values stay relative to this package root so Stage can resolve them.

The default is the installed official `@slidev/theme-default` package. Slidev and Playwright are workspace dependencies. Set `SLIDEV_THEME_PATH` to explicitly use another installed theme directory. See the [development guide](../../docs/DEVELOPMENT.md) for browser setup and the published watabegg 1.2.1 example.
