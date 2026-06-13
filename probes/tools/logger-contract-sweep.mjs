import { execFileSync } from "node:child_process";
const rg = (pat, glob) => { try { return execFileSync("rg", ["-n", pat, "--glob", glob, "ts-core/src","ts-markets/src","ts-cloud/src"], {encoding:"utf8"}); } catch { return ""; } };
const consoles = rg("console\\.(log|warn|error|info|debug)\\(", "!*.test.ts");
const rawErr = rg("error:\\s*(e|err|error)\\b", "!*.test.ts");
console.log("=== console.* in app code ===\n" + consoles);
console.log("=== suspected raw Error in extras (verify serializeError) ===\n" + rawErr);
