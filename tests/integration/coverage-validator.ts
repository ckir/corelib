import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COVERAGE_MATRIX, type SeamCell } from "./coverage.matrix";
import { type Fixture, findUnscrubbedSecrets } from "./_harness/scrubber";
import { readFixtureFile } from "./_harness/fixtures";

const ROOT = resolve(__dirname, "..", "..");
const CONTRACTS = resolve(__dirname, "_contracts");

export function validateCoverage(): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  // 1 + 2: every external cell has a fixture that passes the scrub check.
  const referenced = new Set<string>();
  for (const cell of COVERAGE_MATRIX.filter((c): c is SeamCell & { fixturePath: string } => c.seam === "external")) {
    if (!cell.fixturePath) { errors.push(`external cell ${cell.id} has no fixturePath`); continue; }
    const abs = resolve(CONTRACTS, cell.fixturePath);
    referenced.add(abs);
    const file = readFixtureFile(abs);
    if (!file) { errors.push(`external cell ${cell.id}: missing fixture ${cell.fixturePath}`); continue; }
    for (const fx of (Array.isArray(file) ? file : [file]) as Fixture[]) {
      const leaks = findUnscrubbedSecrets(fx);
      if (leaks.length) errors.push(`fixture ${cell.fixturePath} leaks: ${leaks.join(", ")}`);
    }
  }

  // 3: no orphan fixtures (every *.json under _contracts is referenced by a cell).
  for (const abs of walkJson(CONTRACTS)) {
    if (!referenced.has(abs)) errors.push(`orphan fixture (no matrix cell): ${abs.replace(CONTRACTS + "/", "")}`);
  }

  // 4: every live-streaming cell points at an existing test file.
  for (const cell of COVERAGE_MATRIX.filter((c) => c.seam === "live-streaming")) {
    if (!cell.testFilePath) { errors.push(`live-streaming cell ${cell.id} has no testFilePath`); continue; }
    if (!existsSync(resolve(ROOT, cell.testFilePath))) errors.push(`live-streaming cell ${cell.id}: missing test ${cell.testFilePath}`);
  }

  return { ok: errors.length === 0, errors };
}

function walkJson(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = resolve(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walkJson(abs));
    else if (entry.endsWith(".json")) out.push(abs);
  }
  return out;
}

// CLI entry (run via `tsx tests/integration/coverage-validator.ts`). ESM-safe main check
// (no `require.main` — undefined under ESM/Vitest; agy plan-pass 🔴).
const isMain = process.argv[1] != null && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { ok, errors } = validateCoverage();
  if (!ok) { for (const e of errors) console.error(`✗ ${e}`); process.exit(1); }
  console.log("✓ coverage matrix valid");
}
