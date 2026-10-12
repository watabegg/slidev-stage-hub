#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/desktop-env.sh"
CARGO_BUILD_JOBS=2 cargo run --manifest-path "$NATIVE_ROOT/Cargo.toml" --locked -p slive --features desktop -- "$@"
