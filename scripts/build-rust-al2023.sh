#!/usr/bin/env bash
# Builds the corelib-rust native module (and optionally the CLI binaries) inside amazonlinux:2023, so
# the result needs glibc <= 2.34 and loads on AWS Lambda and any distro at least that new. A build on
# ubuntu-latest or a current host links glibc 2.38+ and fails to dlopen there.
#
# Builds for the architecture of the machine running docker (x86_64 or aarch64).
#
# Usage: scripts/build-rust-al2023.sh <out-dir> [--bins]
#   <out-dir>/corelib-rust.node                                      always
#   <out-dir>/{yahoo_streamer,nasdaq_polling,alpaca_streamer}        with --bins
# Needs docker. Cargo and rustup are cached in the docker volume `corelib-lambda-cargo`.
# Fails if any produced binary needs glibc newer than 2.34.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:?usage: build-rust-al2023.sh <out-dir> [--bins]}"
BINS=0
[ "${2:-}" = "--bins" ] && BINS=1

TOOLCHAIN="$(sed -n 's/^channel *= *"\(.*\)"/\1/p' "$ROOT/rust-toolchain.toml")"
[ -n "$TOOLCHAIN" ] || { echo "build-rust-al2023: no channel in rust-toolchain.toml" >&2; exit 1; }
MAX_GLIBC="2.34"

mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/src/rust" "$WORK/out"
cp -r "$ROOT"/rust/Cargo.toml "$ROOT"/rust/Cargo.lock "$ROOT"/rust/build.rs "$ROOT"/rust/package.json "$ROOT"/rust/src "$WORK/src/rust/"

cat >"$WORK/build.sh" <<INNER
set -euo pipefail
export CARGO_HOME=/cache/cargo RUSTUP_HOME=/cache/rustup CARGO_TARGET_DIR=/cache/target
dnf install -y -q gcc gcc-c++ make pkgconf-pkg-config openssl-devel ca-certificates curl-minimal binutils >/dev/null
if [ ! -x /cache/cargo/bin/rustup ]; then
	curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain $TOOLCHAIN >/dev/null 2>&1
fi
. /cache/cargo/env
rustup toolchain install $TOOLCHAIN --profile minimal >/dev/null 2>&1
cd /work/src/rust
cargo +$TOOLCHAIN build --release --locked
cp /cache/target/release/libcorelib_rust.so /work/out/corelib-rust.node
if [ "$BINS" = 1 ]; then
	cargo +$TOOLCHAIN build --release --locked --features clap --bins
	for b in yahoo_streamer nasdaq_polling alpaca_streamer; do cp /cache/target/release/\$b /work/out/\$b; done
fi
for f in /work/out/*; do
	needed=\$(objdump -T "\$f" | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -Vu | tail -1)
	echo "glibc \$needed  \$(basename "\$f")"
	[ "\$(printf '%s\n%s\n' "\$needed" $MAX_GLIBC | sort -V | tail -1)" = "$MAX_GLIBC" ] || { echo "build-rust-al2023: \$f needs glibc \$needed, limit is $MAX_GLIBC" >&2; exit 1; }
done
chown -R $(id -u):$(id -g) /work/out
INNER

echo "==> Building in amazonlinux:2023 (Rust $TOOLCHAIN, $(uname -m))"
docker run --rm -v "$WORK:/work" -v corelib-lambda-cargo:/cache -w /work amazonlinux:2023 bash /work/build.sh
cp "$WORK"/out/* "$OUT/"
