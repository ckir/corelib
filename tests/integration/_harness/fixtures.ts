import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type Fixture } from "./scrubber";

export type { Fixture };
/** A fixture file is one Fixture (same response every time) or an ordered array (sequential queue). */
export type FixtureFile = Fixture | Fixture[];

const CONTRACTS_DIR = resolve(__dirname, "..", "_contracts");

export function fixturePathFor(service: string, name: string): string {
  return resolve(CONTRACTS_DIR, service, `${name}.json`);
}

export function readFixtureFile(path: string): FixtureFile | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as FixtureFile;
  } catch {
    return null;
  }
}

export function writeFixtureFile(path: string, data: FixtureFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/** Stable key for matching a request to its fixture queue. */
export function fixtureKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}
