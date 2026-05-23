import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { decryptConfig } from "./ConfigUtils";

vi.mock("../utils", () => ({
	getEnv: vi.fn(),
}));

describe("ConfigUtils", () => {
	const password =
		"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"; // 64 hex chars = 32 bytes
	const key = Buffer.from(password, "hex");

	beforeEach(async () => {
		vi.resetAllMocks();
		const { getEnv } = await import("../utils");
		(getEnv as any).mockReturnValue(password);
	});

	it("should decrypt valid encrypted config data", async () => {
		const testData = { foo: "bar", secret: 123 };
		const iv = crypto.randomBytes(16);
		const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);

		let encrypted = cipher.update(JSON.stringify(testData), "utf8");
		encrypted = Buffer.concat([encrypted, cipher.final()]);

		const encryptedData = `${iv.toString("base64")}\n${encrypted.toString("base64")}`;

		const result = await decryptConfig(encryptedData);
		expect(result).toEqual(testData);
	});

	it("should throw if CORELIB_AES_PASSWORD is not set", async () => {
		const { getEnv } = await import("../utils");
		(getEnv as any).mockReturnValue(undefined);

		await expect(decryptConfig("iv\ncipher")).rejects.toThrow(
			"Decryption failed: CORELIB_AES_PASSWORD environment variable is not set.",
		);
	});

	it("should throw if encrypted data format is invalid", async () => {
		await expect(decryptConfig("just-one-line")).rejects.toThrow(
			"Invalid .enc file format. Expected IV on line 1 and Ciphertext on line 2.",
		);
	});

	it("should throw if decryption fails (invalid key/iv/ciphertext)", async () => {
		const encryptedData = "invalidIVbase64\ninvalidCipherbase64";
		// This will likely throw during Buffer.from or decipher.final()
		await expect(decryptConfig(encryptedData)).rejects.toThrow();
	});
});
