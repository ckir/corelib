import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const DEFAULT_PATH = ".agent/audit_scratchpad.json";
const ZONES = ["phase0","boot","ffi","engine","facade"];
const SEV = ["critical","high","medium","low"];
const CONF = ["confirmed-by-probe","confirmed-by-reading","suspected"];
const OS = ["windows-only","linux-only","cross-os"];
const TEST = ["A","B","C","D"];
const REQUIRED = ["id","zone","lenses","severity","confidence","os_sensitivity","testability","evidence","fix_sketch"];

export function validateFinding(rec) {
  for (const f of REQUIRED) if (rec[f] === undefined || rec[f] === null || rec[f] === "")
    throw new Error(`finding missing required field: ${f}`);
  if (!ZONES.includes(rec.zone)) throw new Error(`bad zone: ${rec.zone}`);
  if (!SEV.includes(rec.severity)) throw new Error(`bad severity: ${rec.severity}`);
  if (!CONF.includes(rec.confidence)) throw new Error(`bad confidence: ${rec.confidence}`);
  if (!OS.includes(rec.os_sensitivity)) throw new Error(`bad os_sensitivity: ${rec.os_sensitivity}`);
  if (!TEST.includes(rec.testability)) throw new Error(`bad testability: ${rec.testability}`);
  if (!Array.isArray(rec.lenses) || rec.lenses.length === 0) throw new Error("lenses must be a non-empty array");
  if (rec.confidence === "confirmed-by-probe" && !rec.probe)
    throw new Error("confirmed-by-probe requires probe path");
  return true;
}

export function loadFindings(path = DEFAULT_PATH) {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, "utf8")).findings ?? [];
}

export function addFinding(rec, path = DEFAULT_PATH) {
  validateFinding(rec);
  const findings = loadFindings(path);
  if (findings.some((f) => f.id === rec.id)) throw new Error(`duplicate id: ${rec.id}`);
  findings.push(rec);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ findings }, null, 2)}\n`);
  return rec;
}

// CLI: node scratchpad.mjs add '<json>' | list
if (process.argv[1]?.endsWith("scratchpad.mjs")) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "add") { const r = addFinding(JSON.parse(arg)); console.log(`added ${r.id}`); }
  else if (cmd === "list") { console.log(JSON.stringify(loadFindings(), null, 2)); }
  else { console.error("usage: scratchpad.mjs add '<json>' | list"); process.exit(1); }
}
