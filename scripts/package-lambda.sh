#!/usr/bin/env bash
# Builds ts-cloud/dist/function.zip, the AWS Lambda deployment package.
#
# Why this exists: the Lambda runtime (nodejs24.x on Amazon Linux 2023) has glibc 2.34, but a
# corelib-rust.node built on a current Linux host or on CI's ubuntu-latest needs glibc 2.38 and fails
# to dlopen on Lambda. loadFFI() swallows that error and disables the Rust features, so the deploy
# "works" and /health stays green. This script builds the native module inside amazonlinux:2023 and
# then loads it in the real Lambda image before it hands you the zip.
#
# Usage: scripts/package-lambda.sh
# Needs: docker, pnpm, zip. First run downloads two images and compiles the crate (~2 min); later
# runs reuse the cargo cache in the docker volume `corelib-lambda-cargo`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

for tool in docker pnpm zip; do
	command -v "$tool" >/dev/null || { echo "package-lambda: '$tool' not found" >&2; exit 1; }
done

TOOLCHAIN="$(sed -n 's/^channel *= *"\(.*\)"/\1/p' rust-toolchain.toml)"
[ -n "$TOOLCHAIN" ] || { echo "package-lambda: no channel in rust-toolchain.toml" >&2; exit 1; }
MAX_GLIBC="2.34"
BUILD_IMAGE="amazonlinux:2023"
RUN_IMAGE="public.ecr.aws/lambda/nodejs:24"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/src/rust" "$WORK/out"

echo "==> Building the TypeScript bundles"
pnpm --filter ./ts-core build
pnpm --filter ./ts-markets build
pnpm --filter ./ts-cloud build

echo "==> Building corelib-rust.node in $BUILD_IMAGE (Rust $TOOLCHAIN)"
cp -r rust/Cargo.toml rust/Cargo.lock rust/build.rs rust/package.json rust/src "$WORK/src/rust/"
cat >"$WORK/build.sh" <<EOF
set -euo pipefail
export CARGO_HOME=/cache/cargo RUSTUP_HOME=/cache/rustup CARGO_TARGET_DIR=/cache/target
dnf install -y -q gcc gcc-c++ make pkgconf-pkg-config openssl-devel ca-certificates curl-minimal >/dev/null
if [ ! -x /cache/cargo/bin/rustup ]; then
	curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain $TOOLCHAIN >/dev/null 2>&1
fi
. /cache/cargo/env
rustup toolchain install $TOOLCHAIN --profile minimal >/dev/null 2>&1
cd /work/src/rust
cargo +$TOOLCHAIN build --release --locked
cp /cache/target/release/libcorelib_rust.so /work/out/corelib-rust.node
EOF
docker run --rm -v "$WORK:/work" -v corelib-lambda-cargo:/cache -w /work "$BUILD_IMAGE" bash /work/build.sh

echo "==> Checking the binary needs glibc <= $MAX_GLIBC"
docker run --rm -v "$WORK/out:/out:ro" "$BUILD_IMAGE" bash -c \
	"dnf install -y -q binutils >/dev/null && objdump -T /out/corelib-rust.node | grep -o 'GLIBC_[0-9.]*' | sort -Vu | tail -1" \
	>"$WORK/glibc.txt"
NEEDED="$(sed 's/GLIBC_//' "$WORK/glibc.txt")"
if [ "$(printf '%s\n%s\n' "$NEEDED" "$MAX_GLIBC" | sort -V | tail -1)" != "$MAX_GLIBC" ]; then
	echo "package-lambda: binary needs glibc $NEEDED, Lambda has $MAX_GLIBC" >&2
	exit 1
fi
echo "    needs glibc $NEEDED"

echo "==> Staging the package"
PKG="$WORK/pkg"
mkdir "$PKG"
cp -r ts-cloud/dist/aws/. "$PKG/"
cp "$WORK/out/corelib-rust.node" "$PKG/corelib-rust.node"
find "$PKG" -name '*.map' -delete

echo "==> Smoke test in $RUN_IMAGE (loads the native module, calls GET /health)"
cat >"$PKG/_smoke.mjs" <<'EOF'
import { createRequire } from "node:module";
const native = createRequire(import.meta.url)("/var/task/corelib-rust.node");
if (Object.keys(native).length === 0) throw new Error("corelib-rust.node loaded but exports nothing");
const { handler } = await import("/var/task/handler.mjs");
const res = await handler(
	{
		version: "2.0",
		routeKey: "GET /health",
		rawPath: "/health",
		rawQueryString: "",
		headers: { host: "x" },
		requestContext: { http: { method: "GET", path: "/health", protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "smoke" }, domainName: "x", stage: "$default" },
		isBase64Encoded: false,
	},
	{ awsRequestId: "smoke", getRemainingTimeInMillis: () => 30000 },
);
if (res.statusCode !== 200) throw new Error(`/health returned ${res.statusCode}`);
console.log("smoke ok: native module loaded, /health 200");
EOF
docker run --rm --entrypoint node -v "$PKG:/var/task:ro" "$RUN_IMAGE" /var/task/_smoke.mjs
rm "$PKG/_smoke.mjs"

echo "==> Zipping"
OUT="$ROOT/ts-cloud/dist/function.zip"
rm -f "$OUT"
(cd "$PKG" && zip -qr "$OUT" .)
echo "Built $OUT ($(du -h "$OUT" | cut -f1))"
echo "Deploy: aws lambda update-function-code --function-name <name> --zip-file fileb://$OUT"
