# Slidock

Run commands from the repository root:

```sh
pnpm --filter @slidock/slidock typecheck
pnpm --filter @slidock/slidock test
pnpm build:slidock
pnpm dev:slidock
```

`build:slidock` creates the module-graph site, compiles the shared native protocol bridge, and prepares its offline copy. `dev:slidock` serves that copy at `http://127.0.0.1:4174/`. Source fixtures live in `examples/fixtures/`. Public native manifests exclude local source paths and presenter notes; Slive preparation uses the private build receipt.

The default is the installed official `@slidev/theme-default` package. Slidev and Playwright are workspace dependencies. Set `SLIDEV_THEME_PATH` to explicitly use another installed theme directory. See the [development guide](../../docs/DEVELOPMENT.md) for browser setup and the published watabegg 1.2.1 example.

Public entry points: `@slidock/slidock` (`/node` alias), `/serve`, `/client`, `/frontend`, `/frontend/style.css`, and `/frontend/job-status.css`. The client exports `createPublicationJobClient`; the frontend exports `mountJobStatus` for a read-only publication status view. See [Slidock service](../../docs/guides/slidock-service.md), [Web customization](../../docs/guides/web-customization.md), and the [publication jobs guide](../../docs/guides/publication-jobs.md).
