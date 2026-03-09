// =============================================
// FILE: ts-core/src/configs/ConfigUtils.ts
// PURPOSE: Utility functions for configuration handling
// =============================================

import crypto from "node:crypto";

/**
 * Decrypts .enc files based on the rs_encrypt / ConfigCloud format
 * Line 0: IV (Base64)
 * Line 1: Ciphertext (Base64)
 * Password: CORELIB_AES_PASSWORD (Hex)
 */
// biome-ignore lint/suspicious/noExplicitAny: Dynamic decrypted config
export async function decryptConfig(encryptedData: string): Promise<any> {
	const { getEnv } = await import("../utils");
	const password = getEnv("CORELIB_AES_PASSWORD");
	if (!password) {
		throw new Error(
			"Decryption failed: CORELIB_AES_PASSWORD environment variable is not set.",
		);
	}

	// The format is two lines: IV then Ciphertext
	const lines = encryptedData
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	if (lines.length < 2) {
		throw new Error(
			"Invalid .enc file format. Expected IV on line 1 and Ciphertext on line 2.",
		);
	}

	const iv = Buffer.from(lines[0], "base64");
	const ciphertext = Buffer.from(lines[1], "base64");
	const key = Buffer.from(password, "hex");

	const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);

	let decrypted = decipher.update(ciphertext);
	decrypted = Buffer.concat([decrypted, decipher.final()]);

	return JSON.parse(decrypted.toString("utf8"));
}
