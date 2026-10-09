# CLI package rules

- Keep commands thin: validate CLI/config input here and delegate build, serving, thumbnails, and Stage mutations to public package APIs.
- Resolve flag paths from the caller working directory and settings-file paths from the settings file directory.
- Keep JSON stdout to one envelope; send diagnostics to stderr and never print authentication values or raw request/response bodies.
- Doctor is read-only and reports runtime readiness without claiming native binary or operating-system readiness.
