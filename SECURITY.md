# Security policy

## Supported versions

Security fixes are made on `main` and released in the next version. Only the latest release is supported.

## Reporting a vulnerability

Please report vulnerabilities **privately**. Do not open a public issue or pull request.

Use GitHub's private vulnerability reporting on this repository (Security tab, then "Report a vulnerability").
Include what is affected, how to reproduce it, and the impact you expect.

## What to expect

You will get an acknowledgement, and updates when the report is confirmed and when a fix is released.
Reporters are credited in the release notes unless they prefer otherwise.

## Scope notes

`ts-cloud` exposes proxy and SQL endpoints. They require a bearer token (`CORELIB_API_TOKEN`) and refuse
internal network targets; see "Authentication & Security" in `ts-cloud/README.md`. A bypass of either is in scope.

Dependency advisories are checked in CI (`.github/workflows/audit.yml`: `pnpm audit` and `cargo deny`).
