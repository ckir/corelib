// =============================================
// FILE: ts-core/src/configs/ConfigUtils.ts
// PURPOSE: Utility functions for configuration handling
// =============================================

/**
 * Decrypts .enc files based on the rs_encrypt / ConfigCloud format
 * Line 0: IV (Base64)
 * Line 1: Ciphertext (Base64)
 * Password: CORELIB_AES_PASSWORD (Hex)
 */
export async function decryptConfig(encryptedData: string): Promise<unknown> {
	const { getEnv } = await import("../utils");
	const crypto = (await import("node:crypto")).default;
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

	const [ivLine = "", cipherLine = ""] = lines; // lines.length >= 2 checked above
	const iv = Buffer.from(ivLine, "base64");
	const ciphertext = Buffer.from(cipherLine, "base64");
	const key = Buffer.from(password, "hex");

	const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);

	let decrypted = decipher.update(ciphertext);
	decrypted = Buffer.concat([decrypted, decipher.final()]);

	return JSON.parse(decrypted.toString("utf8"));
}
