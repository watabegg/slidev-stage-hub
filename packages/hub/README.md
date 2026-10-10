# Hub

Run commands from the repository root:

```sh
pnpm --filter @slidev-stage-hub/hub typecheck
pnpm --filter @slidev-stage-hub/hub test
pnpm build:hub
pnpm dev:hub
```

`build:hub` creates the module-graph site, compiles the shared native protocol bridge, and prepares its offline copy. `dev:hub` serves that copy at `http://127.0.0.1:4174/`. Source fixtures live in `examples/fixtures/`. Public native manifests exclude local source paths and presenter notes; Stage preparation uses the private build receipt.

The default is the installed official `@slidev/theme-default` package. Slidev and Playwright are workspace dependencies. Set `SLIDEV_THEME_PATH` to explicitly use another installed theme directory. See the [development guide](../../docs/DEVELOPMENT.md) for browser setup and the published watabegg 1.2.1 example.

Public entry points: `@slidev-stage-hub/hub` (`/node` alias), `/serve`, `/client`, `/frontend`, `/frontend/style.css`, and `/frontend/job-status.css`. The client exports `createPublicationJobClient`; the frontend exports `mountJobStatus` for a read-only publication status view. See [Hub service](../../docs/guides/hub-service.md), [Web customization](../../docs/guides/web-customization.md), and the [publication jobs guide](../../docs/guides/publication-jobs.md).
