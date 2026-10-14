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
# Needs: docker, pnpm, zip. The native build is scripts/build-rust-al2023.sh, which enforces glibc <= 2.34.
# First run downloads two images and compiles the crate (~2 min); later runs reuse the cargo cache in
# the docker volume `corelib-lambda-cargo`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

for tool in docker pnpm zip; do
	command -v "$tool" >/dev/null || { echo "package-lambda: '$tool' not found" >&2; exit 1; }
done

RUN_IMAGE="public.ecr.aws/lambda/nodejs:24"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "==> Building the TypeScript bundles"
pnpm --filter ./ts-core build
pnpm --filter ./ts-markets build
pnpm --filter ./ts-cloud build

mkdir -p "$WORK/out"
"$ROOT/scripts/build-rust-al2023.sh" "$WORK/out"

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
