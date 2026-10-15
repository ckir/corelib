// Fails when a packed tarball's package.json points main/types/exports at a file the tarball does not
// contain (e.g. `main: dist/index.js` with no dist/index.js: the package installs but cannot be imported).
// Usage: node scripts/check-package-entries.mjs <tarball.tgz>...
import { execFileSync } from "node:child_process";

const collect = (value, out) => {
	if (typeof value === "string") out.add(value);
	else if (value && typeof value === "object") {
		for (const v of Object.values(value)) collect(v, out);
	}
	return out;
};

let failed = false;
for (const tgz of process.argv.slice(2)) {
	const files = new Set(
		execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" })
			.split("\n")
			.filter(Boolean),
	);
	const pkg = JSON.parse(
		execFileSync("tar", ["-xOzf", tgz, "package/package.json"], {
			encoding: "utf8",
		}),
	);
	const targets = collect(pkg.exports, new Set());
	for (const field of ["main", "types", "module", "bin"]) collect(pkg[field], targets);
	for (const t of targets) {
		if (t.includes("*")) continue; // pattern export, nothing concrete to check
		const rel = `package/${t.replace(/^\.\//, "")}`;
		if (!files.has(rel)) {
			console.error(`::error::${tgz}: ${pkg.name} points at ${t} but the tarball has no ${rel}`);
			failed = true;
		}
	}
	if (!failed) console.log(`ok  ${pkg.name}@${pkg.version} entry points present`);
}
process.exit(failed ? 1 : 0);
