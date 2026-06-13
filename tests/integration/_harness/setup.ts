import { afterAll, afterEach, beforeAll } from "vitest";
import { assertNoMisses, beginItest, endItest, resetItest } from "./server";
import { cleanupAll } from "./temp";

beforeAll(() => beginItest());
afterEach(() => {
  assertNoMisses(); // any unmatched replay request fails the test loudly
  resetItest();
});
afterAll(async () => {
  await endItest();
  await cleanupAll();
});
