import { createTestDatabase } from "@itest/_harness/temp";
import { describe, expect, it } from "vitest";

describe("database (real SQLite composition)", () => {
	it("[itestCore.db.roundtrip] creates a table, inserts, and reads back", async () => {
		const db = await createTestDatabase();
		await db.query("CREATE TABLE prices (sym TEXT, px REAL)");
		await db.query("INSERT INTO prices (sym, px) VALUES ('AAPL', 191.5)");
		const res = await db.query<{ sym: string; px: number }>(
			"SELECT sym, px FROM prices",
		);
		expect(res.status).toBe("success");
		if (res.status === "success")
			expect(res.value.rows).toEqual([{ sym: "AAPL", px: 191.5 }]);
	});
});
