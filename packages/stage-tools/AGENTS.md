# Stage tools package rules

- Service APIs require explicit absolute paths and must not read CLI arguments, process environment, or the current directory.
- Keep CLI defaults and environment-based dependency selection in `apps/stage/scripts` wrappers.
- Preserve source-root realpath checks, bounded remote metadata reads, redirect rejection, private auth-file checks, and secret redaction.
- Keep auth and note contents out of logs and config fields other than their intended local mappings.
- Run the narrow `@slidev-stage-hub/stage-tools` typecheck and tests for changes here.
