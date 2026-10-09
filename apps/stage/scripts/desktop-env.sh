#!/usr/bin/env bash
# Source inside another script; no changes to OS environment outside this process.
NATIVE_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
NATIVE_SDK="$NATIVE_ROOT/artifacts/sdk/root"
export PKG_CONFIG_PATH="$NATIVE_SDK/usr/lib/x86_64-linux-gnu/pkgconfig:$NATIVE_SDK/usr/share/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}"
# -sys crates consume linker flags, not C headers. Keep host runtime dependencies;
# use extracted linker symlinks alongside host directories, without a fake sysroot.
export LIBRARY_PATH="$NATIVE_SDK/usr/lib/x86_64-linux-gnu${LIBRARY_PATH:+:$LIBRARY_PATH}"
export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }-L native=$NATIVE_SDK/usr/lib/x86_64-linux-gnu"
