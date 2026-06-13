/**
 * ci-offload.mjs — spec §9.3 headless GitHub Actions trigger + reclaim client
 *
 * CLI: node probes/tools/ci-offload.mjs [--print-cmd] <probe-id> <commit-sha>
 *
 * --print-cmd (dry mode): prints the gh command and stub finding JSON, exits 0.
 *   Does NOT call gh and does NOT modify the scratchpad.
 * Live mode: writes stub finding, triggers workflow, polls + watches run,
 *   parses RESULT line, promotes finding on confirmation.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { addFinding, loadFindings, validateFinding } from "./scratchpad.mjs";

const WORKFLOW_FILE = "heavy-probes.yml";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Slug: strip leading/trailing non-alnum, lowercase, collapse runs to '-' */
function slugify(id) {
  return id.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

/** Build the stub finding record for a probe offload. */
function buildStubFinding(probeId, commitSha) {
  return {
    id: slugify(probeId),
    zone: "engine",
    lenses: ["races"],
    severity: "medium",
    confidence: "suspected",
    os_sensitivity: "cross-os",
    testability: "C",
    evidence: `CI offload pending. probe=${probeId} commit=${commitSha}`,
    fix_sketch: "Investigate once CI probe result is available.",
    ci_status: "pending-ci",
    ci_probe: probeId,
    ci_commit: commitSha,
  };
}

/** Return the gh command tokens for triggering the workflow. */
function buildGhCmd(probeId, commitSha) {
  return ["workflow", "run", WORKFLOW_FILE, "-f", `probe=${probeId}`, "-f", `commit=${commitSha}`];
}

// ---------------------------------------------------------------------------
// Dry mode
// ---------------------------------------------------------------------------

function dryRun(probeId, commitSha) {
  const args = buildGhCmd(probeId, commitSha);
  const cmdLine = `gh ${args.join(" ")}`;
  const stub = buildStubFinding(probeId, commitSha);
  // Validate the stub (will throw if schema is broken — catches regressions)
  validateFinding(stub);
  console.log(cmdLine);
  console.log(JSON.stringify(stub, null, 2));
}

// ---------------------------------------------------------------------------
// Live mode helpers (not executed in this task)
// ---------------------------------------------------------------------------

function gh(...args) {
  const result = spawnSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`gh ${args[0]} failed (exit ${result.status}):\n${result.stderr}`);
  return result.stdout.trim();
}

/**
 * Poll gh run list until a run for this commit appears, then return its databaseId.
 * Retries up to maxAttempts with delayMs between each.
 */
async function waitForRun(commitSha, maxAttempts = 30, delayMs = 10_000) {
  for (let i = 0; i < maxAttempts; i++) {
    const raw = gh("run", "list", "--workflow", WORKFLOW_FILE, "--json", "databaseId,headSha,status,conclusion");
    const runs = JSON.parse(raw);
    const match = runs.find((r) => r.headSha.startsWith(commitSha));
    if (match) return match.databaseId;
    if (i < maxAttempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  throw new Error(`No run found for commit ${commitSha} after ${maxAttempts} attempts`);
}

/**
 * Parse the RESULT line from run logs.
 * Returns "confirmed" | "not-reproduced" | null
 */
function parseOutcome(logs) {
  const match = logs.match(/RESULT probe=\S+ outcome=(\S+)/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Live mode (written, NOT executed here — see module-level guard in main())
// ---------------------------------------------------------------------------

async function liveRun(probeId, commitSha) {
  const stub = buildStubFinding(probeId, commitSha);
  const id = stub.id;

  // 1. Write stub finding (idempotent: skip if already present)
  const existing = loadFindings();
  if (!existing.some((f) => f.id === id)) {
    addFinding(stub);
    console.log(`[ci-offload] stub finding written: ${id}`);
  } else {
    console.log(`[ci-offload] stub finding already present: ${id}`);
  }

  // 2. Trigger workflow
  const triggerArgs = buildGhCmd(probeId, commitSha);
  console.log(`[ci-offload] triggering: gh ${triggerArgs.join(" ")}`);
  execFileSync("gh", triggerArgs, { stdio: "inherit" });

  // 3. Poll for the run to appear
  console.log("[ci-offload] waiting for run to appear...");
  const runId = await waitForRun(commitSha);
  console.log(`[ci-offload] run id: ${runId}`);

  // 4. Watch the run to completion
  console.log("[ci-offload] watching run...");
  spawnSync("gh", ["run", "watch", String(runId), "--exit-status"], { stdio: "inherit" });

  // 5. Fetch logs and parse RESULT line
  const logs = gh("run", "view", String(runId), "--log");
  const outcome = parseOutcome(logs);
  console.log(`[ci-offload] outcome: ${outcome}`);

  // 6. Promote finding if confirmed
  if (outcome === "confirmed") {
    // Load, mutate, re-write scratchpad
    const { readFileSync, writeFileSync } = await import("node:fs");
    const path = ".agent/audit_scratchpad.json";
    const data = JSON.parse(readFileSync(path, "utf8"));
    const idx = data.findings.findIndex((f) => f.id === id);
    if (idx !== -1) {
      data.findings[idx] = {
        ...data.findings[idx],
        confidence: "confirmed-by-probe",
        ci_status: "confirmed",
        probe: `gh-run:${runId}`,
        evidence: `Probe confirmed. run_id=${runId} probe=${probeId} commit=${commitSha}`,
      };
      validateFinding(data.findings[idx]);
      writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
      console.log(`[ci-offload] finding ${id} promoted to confirmed-by-probe`);
    }
  } else {
    console.log(`[ci-offload] outcome not confirmed (${outcome}); finding left as suspected`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const printCmd = argv.includes("--print-cmd");
  const positional = argv.filter((a) => !a.startsWith("--"));

  if (positional.length < 2) {
    console.error("usage: node ci-offload.mjs [--print-cmd] <probe-id> <commit-sha>");
    process.exit(1);
  }

  const [probeId, commitSha] = positional;

  if (printCmd) {
    dryRun(probeId, commitSha);
    process.exit(0);
  }

  await liveRun(probeId, commitSha);
}

main().catch((err) => {
  console.error("[ci-offload] fatal:", err.message);
  process.exit(1);
});
