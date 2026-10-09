#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/desktop-env.sh"
cd "$NATIVE_ROOT"
CARGO_BUILD_JOBS=2 cargo run --locked -p slidev-native-poc --features desktop
