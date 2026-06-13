import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addFinding, loadFindings, validateFinding } from "./scratchpad.mjs";

const REQUIRED = ["id","zone","lenses","severity","confidence","os_sensitivity","testability","evidence","fix_sketch"];

test("validateFinding rejects a record missing a required field", () => {
  const bad = { id: "x" };
  assert.throws(() => validateFinding(bad), /missing/i);
});

test("validateFinding enforces probe-requirement rule", () => {
  const base = { id:"e-1", zone:"engine", lenses:["races"], severity:"high",
    confidence:"confirmed-by-probe", os_sensitivity:"cross-os", testability:"C",
    evidence:"x:1", fix_sketch:"y", probe:null };
  assert.throws(() => validateFinding(base), /confirmed-by-probe requires probe/i);
  base.probe = "probes/rust/tests/foo.rs";
  assert.doesNotThrow(() => validateFinding(base));
});

test("addFinding persists and loadFindings returns it", () => {
  const dir = mkdtempSync(join(tmpdir(), "sp-"));
  const path = join(dir, "audit_scratchpad.json");
  const rec = { id:"boot-1", zone:"boot", lenses:["races"], severity:"medium",
    confidence:"confirmed-by-reading", os_sensitivity:"cross-os", testability:"A",
    evidence:"ConfigManager.ts:42", fix_sketch:"serialize init", probe:null };
  addFinding(rec, path);
  const all = loadFindings(path);
  assert.equal(all.length, 1);
  assert.equal(all[0].id, "boot-1");
  rmSync(dir, { recursive: true, force: true });
});

void REQUIRED;
