#!/usr/bin/env node
/**
 * synthesize.mjs — ranked markdown backlog from the audit scratchpad.
 * Usage: node probes/tools/synthesize.mjs > <output-file>
 */

import { loadFindings } from "./scratchpad.mjs";

// ── constants ──────────────────────────────────────────────────────────────────

const SEV_ORDER   = ["critical", "high", "medium", "low"];
const CONF_ORDER  = ["confirmed-by-probe", "confirmed-by-reading", "suspected"];
// Lowest boundary = root owner; facade = outermost
const ZONE_ORDER  = ["phase0", "engine", "ffi", "boot", "facade"];

// ── helpers ───────────────────────────────────────────────────────────────────

function sevRank(s)  { return SEV_ORDER.indexOf(s);  }
function confRank(c) { return CONF_ORDER.indexOf(c); }
function zoneRank(z) { return ZONE_ORDER.indexOf(z); }

function cmp(a, b) {
  const ds = sevRank(a.severity) - sevRank(b.severity);
  if (ds !== 0) return ds;
  return confRank(a.confidence) - confRank(b.confidence);
}

function truncate(s, n = 300) {
  if (!s || s.length <= n) return s ?? "";
  // keep the file:line prefix if present
  const colonIdx = s.indexOf(" —");
  const prefix = colonIdx > 0 && colonIdx < 60 ? s.slice(0, colonIdx + 2) + " " : "";
  const rest = colonIdx > 0 && colonIdx < 60 ? s.slice(colonIdx + 2) : s;
  const budget = n - prefix.length - 3;
  return prefix + rest.slice(0, budget) + "...";
}

function md(s) { return (s ?? "").replace(/\|/g, "\\|").replace(/\n/g, " "); }

// ── cluster definitions ───────────────────────────────────────────────────────
// Each cluster: { label, memberIds[] }
// Owner = member with lowest ZONE_ORDER rank; tie-break by sev then conf.

const CLUSTER_SPECS = [
  {
    label: "ts-core-node-imports-edge-compat",
    memberIds: [
      "phase0-ts-core-node-module-SysInfo-01",
      "phase0-ts-core-node-module-utils-index-01",
      "phase0-ts-core-node-module-core-index-01",
      "phase0-ts-core-node-crypto-ConfigUtils-01",
      "facade-node-module-crypto-edge-bundle-01",
    ],
  },
  {
    label: "configmanager-concurrency-races",
    memberIds: [
      "boot-ConfigManager-initialize-races-01",
      "boot-ConfigManager-partial-init-window-02",
      "boot-ConfigManager-loadExternalConfig-concurrent-05",
      "boot-ConfigManager-sysconfig-reference-severance-09",
    ],
  },
  {
    label: "configmanager-cli-argv-hazards",
    memberIds: [
      "boot-ConfigManager-cli-override-process-exit-07",
      "boot-ConfigManager-process-argv-unguarded-08",
    ],
  },
  {
    label: "http-retry-config-hazards",
    memberIds: [
      "boot-RequestUnlimited-retry-limit-unbounded-03",
      "boot-RequestUnlimited-backoff-no-jitter-04",
    ],
  },
  {
    label: "error-serialization-log-gaps",
    memberIds: [
      "phase0-logger-raw-error-sqlite-01",
      "phase0-logger-raw-error-postgres-01",
      "phase0-logger-raw-error-router-01",
      "phase0-logger-raw-error-Top100-01",
    ],
  },
  {
    label: "redb-double-open-process-abort",
    memberIds: [
      "engine-redb-open-expect-abort-01",
    ],
  },
  {
    label: "ffi-poisoned-config-boundary-robust",
    memberIds: [
      "ffi-poisoned-config-panic-01",
    ],
  },
  {
    label: "worker-bundle-size-and-platform",
    memberIds: [
      "facade-worker-bundle-size-perf-01",
      "facade-worker-tsup-platform-node-01",
    ],
  },
  {
    label: "market-status-http-error-swallow",
    memberIds: [
      "facade-market-status-error-status-swallowed-01",
    ],
  },
  {
    label: "detectRuntime-uncached",
    memberIds: [
      "boot-detectRuntime-uncached-06",
    ],
  },
  {
    label: "gcp-logger-stray-console-calls",
    memberIds: [
      "phase0-logger-gcp-console-01",
    ],
  },
  {
    label: "finnhub-no-endpoint-override",
    memberIds: [
      "engine-finnhub-no-endpoint-override-01",
    ],
  },
  {
    label: "redb-concurrent-persist-load-robust",
    memberIds: [
      "engine-redb-concurrent-persist-load-robust-01",
    ],
  },
  {
    label: "engine-reconnect-teardown-loom",
    memberIds: [
      "engine-reconnect-teardown-loom-01",
    ],
  },
  {
    label: "ffi-reentrancy-reconnect-gc",
    memberIds: [
      "ffi-reentrancy-reconnect-gc-deadlock-01",
    ],
  },
];

// ── main ──────────────────────────────────────────────────────────────────────

function main() {
  const findings = loadFindings();
  const byId = Object.fromEntries(findings.map(f => [f.id, f]));

  // Validate all cluster member IDs exist and every finding is covered exactly once
  const assignedIds = new Set();
  for (const cluster of CLUSTER_SPECS) {
    for (const id of cluster.memberIds) {
      if (!byId[id]) throw new Error(`Cluster "${cluster.label}" references unknown id: ${id}`);
      if (assignedIds.has(id)) throw new Error(`Finding ${id} appears in multiple clusters`);
      assignedIds.add(id);
    }
  }
  const unclustered = findings.filter(f => !assignedIds.has(f.id));
  if (unclustered.length > 0) {
    // Auto-cluster stragglers as singletons
    for (const f of unclustered) {
      CLUSTER_SPECS.push({ label: `unclustered-${f.id}`, memberIds: [f.id] });
      assignedIds.add(f.id);
    }
  }

  // Build clusters with resolved members + owner
  const clusters = CLUSTER_SPECS.map(spec => {
    const members = spec.memberIds.map(id => byId[id]).filter(Boolean);
    // Owner = lowest zone rank; tie-break by severity then confidence
    const owner = members.slice().sort((a, b) => {
      const dz = zoneRank(a.zone) - zoneRank(b.zone);
      if (dz !== 0) return dz;
      return cmp(a, b);
    })[0];
    const manifestations = members.filter(f => f.id !== owner.id);
    // Cluster severity = max member severity
    const clusterSev = members.reduce((best, f) =>
      sevRank(f.severity) < sevRank(best) ? f.severity : best, members[0].severity);
    const clusterConf = members.reduce((best, f) =>
      confRank(f.confidence) < confRank(best) ? f.confidence : best, members[0].confidence);
    return { ...spec, members, owner, manifestations, clusterSev, clusterConf };
  });

  // Rank clusters
  clusters.sort((a, b) => {
    const ds = sevRank(a.clusterSev) - sevRank(b.clusterSev);
    if (ds !== 0) return ds;
    return confRank(a.clusterConf) - confRank(b.clusterConf);
  });

  // ── Stats ──────────────────────────────────────────────────────────────────

  const countBy = (arr, key) => arr.reduce((acc, f) => {
    acc[f[key]] = (acc[f[key]] || 0) + 1; return acc;
  }, {});

  const bySev  = countBy(findings, "severity");
  const byConf = countBy(findings, "confidence");
  const byZone = countBy(findings, "zone");

  // ── Emit ──────────────────────────────────────────────────────────────────

  const lines = [];
  const emit  = (...args) => lines.push(args.join(""));

  emit("# Monorepo Audit — Ranked Findings Backlog");
  emit();
  emit("> Generated: 2026-06-13 · Source: `.agent/audit_scratchpad.json` · ",
       `Total findings: **${findings.length}** · Clusters: **${clusters.length}**`);
  emit("> Do NOT edit this file by hand — regenerate via `node probes/tools/synthesize.mjs`.");
  emit();

  // Summary table
  emit("## Summary");
  emit();
  emit("### By severity");
  emit();
  emit("| Severity | Count |");
  emit("|----------|-------|");
  for (const s of SEV_ORDER) emit(`| ${s} | ${bySev[s] ?? 0} |`);
  emit();

  emit("### By confidence");
  emit();
  emit("| Confidence | Count |");
  emit("|------------|-------|");
  for (const c of CONF_ORDER) emit(`| ${c} | ${byConf[c] ?? 0} |`);
  emit();

  emit("### By zone");
  emit();
  emit("| Zone | Count |");
  emit("|------|-------|");
  for (const z of ZONE_ORDER) emit(`| ${z} | ${byZone[z] ?? 0} |`);
  emit();

  // Per-cluster sections
  emit("---");
  emit();
  emit("## Ranked Clusters");
  emit();
  emit("> Ownership rule: within a cluster, the finding from the **lowest boundary zone** is the OWNER ",
       "(zone order: `phase0 < engine < ffi < boot < facade`). Higher-zone members are listed as ",
       "manifestations/affected-surfaces of the root cause.");
  emit();

  for (const cluster of clusters) {
    const { label, owner, manifestations, clusterSev, clusterConf } = cluster;

    emit(`### Cluster: \`${label}\``);
    emit();
    emit(`**Max severity:** ${clusterSev} · **Best confidence:** ${clusterConf} · `,
         `**Members:** ${cluster.members.length}`);
    emit();

    // Owner finding
    emit("#### Owner finding");
    emit();
    emit("| Field | Value |");
    emit("|-------|-------|");
    emit(`| **id** | \`${owner.id}\` |`);
    emit(`| zone | ${owner.zone} |`);
    emit(`| severity | ${owner.severity} |`);
    emit(`| confidence | ${owner.confidence} |`);
    emit(`| lenses | ${owner.lenses.join(", ")} |`);
    emit(`| os_sensitivity | ${owner.os_sensitivity} |`);
    emit(`| testability | ${owner.testability} |`);
    emit(`| probe | ${owner.probe ? `\`${owner.probe}\`` : "—"} |`);
    emit(`| evidence | ${md(truncate(owner.evidence, 300))} |`);
    emit(`| fix_sketch | ${md(truncate(owner.fix_sketch, 200))} |`);
    emit();

    if (manifestations.length > 0) {
      emit("#### Manifestations / affected surfaces");
      emit();
      emit("| id | zone | severity | confidence | lenses | os_sensitivity | testability | evidence (snippet) |");
      emit("|----|------|----------|------------|--------|----------------|-------------|-------------------|");
      for (const f of manifestations) {
        emit(`| \`${f.id}\` | ${f.zone} | ${f.severity} | ${f.confidence} | `,
             `${f.lenses.join(",")} | ${f.os_sensitivity} | ${f.testability} | `,
             `${md(truncate(f.evidence, 200))} |`);
      }
      emit();
    }

    emit("---");
    emit();
  }

  // Appendix — all 28 findings flat
  emit("## Appendix — All Findings (ranked)");
  emit();
  emit("Ranked by severity then confidence. Each finding appears exactly once.");
  emit();
  emit("| # | id | zone | severity | confidence | lenses | os | testability | cluster | probe | evidence (snippet) | fix_sketch (snippet) |");
  emit("|---|-----|------|----------|------------|--------|----|-------------|---------|-------|-------------------|----------------------|");

  // Build finding->cluster lookup
  const findingCluster = {};
  for (const cluster of clusters) {
    for (const f of cluster.members) findingCluster[f.id] = cluster.label;
  }

  const ranked = findings.slice().sort(cmp);
  ranked.forEach((f, i) => {
    emit(`| ${i + 1} | \`${f.id}\` | ${f.zone} | ${f.severity} | ${f.confidence} | `,
         `${f.lenses.join(",")} | ${f.os_sensitivity} | ${f.testability} | `,
         `\`${findingCluster[f.id] ?? "—"}\` | `,
         `${f.probe ? `\`${f.probe}\`` : "—"} | `,
         `${md(truncate(f.evidence, 180))} | `,
         `${md(truncate(f.fix_sketch, 120))} |`);
  });

  emit();
  emit(`_End of report. ${findings.length} findings · ${clusters.length} clusters · generated 2026-06-13_`);

  process.stdout.write(lines.join("\n") + "\n");
}

main();
