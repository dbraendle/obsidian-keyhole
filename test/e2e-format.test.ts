import { describe, expect, it } from "vitest";
import {
	CHUNK_BYTES,
	DecryptError,
	HEADER_BYTES,
	TAG_BYTES,
	decrypt,
	encrypt,
	encryptedSize,
	exportVaultKey,
	generateVaultKey,
	importVaultKey,
	isEncrypted,
	keyFingerprint,
	objectIdOf,
} from "../src/e2e/format";

function data(length: number): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(length);
	for (let i = 0; i < length; i++) out[i] = (i * 31 + 7) % 251;
	return out;
}

async function sealed(key: Uint8Array<ArrayBuffer>, plain: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
	return new Uint8Array(await (await encrypt(key, new Blob([plain]))).arrayBuffer());
}

const key = generateVaultKey();

describe("encrypted file format", () => {
	it("round-trips files of every shape", async () => {
		for (const length of [0, 1, 1000, CHUNK_BYTES - 1, CHUNK_BYTES, CHUNK_BYTES + 1, 2 * CHUNK_BYTES, 2 * CHUNK_BYTES + 77]) {
			const plain = data(length);
			const cipher = await sealed(key, plain);
			expect(cipher.length, `size for ${length}`).toBe(encryptedSize(length));
			expect(isEncrypted(cipher)).toBe(true);
			expect(new Uint8Array(await decrypt(key, cipher.buffer)), `content for ${length}`).toEqual(plain);
		}
	});

	it("never produces the same bytes twice, and nothing of the plaintext shows", async () => {
		const plain = new TextEncoder().encode("confidential ".repeat(500));
		const a = await sealed(key, plain);
		const b = await sealed(key, plain);
		expect(a).not.toEqual(b);
		expect(new TextDecoder("latin1").decode(a)).not.toContain("confidential");
	});

	it("refuses another key", async () => {
		const cipher = await sealed(key, data(5000));
		await expect(decrypt(generateVaultKey(), cipher.buffer)).rejects.toBeInstanceOf(DecryptError);
	});

	it("refuses a file with a single changed bit, anywhere", async () => {
		const cipher = await sealed(key, data(CHUNK_BYTES + 5000));
		for (const at of [4, HEADER_BYTES - 1, HEADER_BYTES, HEADER_BYTES + 100, cipher.length - TAG_BYTES - 1, cipher.length - 1]) {
			const bad = cipher.slice();
			bad[at] = (bad[at] ?? 0) ^ 1;
			await expect(decrypt(key, bad.buffer), `bit at ${at}`).rejects.toBeInstanceOf(DecryptError);
		}
	});

	it("refuses a file that was cut off, extended or reordered", async () => {
		const sealedChunk = CHUNK_BYTES + TAG_BYTES;
		const cipher = await sealed(key, data(3 * CHUNK_BYTES));
		const header = cipher.slice(0, HEADER_BYTES);
		const chunk = (i: number) => cipher.slice(HEADER_BYTES + i * sealedChunk, HEADER_BYTES + (i + 1) * sealedChunk);
		const join = (...parts: Uint8Array[]) => {
			const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
			let at = 0;
			for (const p of parts) {
				out.set(p, at);
				at += p.length;
			}
			return out.buffer;
		};
		// cut off exactly at a chunk boundary: every remaining chunk is intact on its own
		await expect(decrypt(key, join(header, chunk(0), chunk(1)))).rejects.toBeInstanceOf(DecryptError);
		await expect(decrypt(key, join(header, chunk(0)))).rejects.toBeInstanceOf(DecryptError);
		await expect(decrypt(key, join(header, chunk(1), chunk(0), chunk(2)))).rejects.toBeInstanceOf(DecryptError);
		await expect(decrypt(key, join(header, chunk(0), chunk(1), chunk(2), chunk(2)))).rejects.toBeInstanceOf(DecryptError);
		await expect(decrypt(key, cipher.slice(0, cipher.length - 1).buffer)).rejects.toBeInstanceOf(DecryptError);
		await expect(decrypt(key, header.buffer)).rejects.toBeInstanceOf(DecryptError);
	});

	it("does not accept a chunk of one file in another", async () => {
		const a = await sealed(key, data(100));
		const b = await sealed(key, data(100));
		const mixed = new Uint8Array(a.length);
		mixed.set(a.subarray(0, HEADER_BYTES), 0);
		mixed.set(b.subarray(HEADER_BYTES), HEADER_BYTES);
		await expect(decrypt(key, mixed.buffer)).rejects.toBeInstanceOf(DecryptError);
	});

	it("tells unencrypted files apart", async () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
		expect(isEncrypted(png)).toBe(false);
		await expect(decrypt(key, png.buffer)).rejects.toMatchObject({ reason: "not-encrypted" });
	});
});

describe("vault key", () => {
	it("exports and imports as text", () => {
		const text = exportVaultKey(key);
		expect(text).toMatch(/^keyhole-key-v1:[A-Za-z0-9_-]{43}$/);
		expect(importVaultKey(`  ${text}\n`)).toEqual(key);
	});

	it("rejects incomplete or foreign text", () => {
		const text = exportVaultKey(key);
		expect(importVaultKey(text.slice(0, -2))).toBeNull();
		expect(importVaultKey(text.replace("keyhole-key-v1:", ""))).toBeNull();
		expect(importVaultKey("keyhole-key-v1:not base64!")).toBeNull();
		expect(importVaultKey("")).toBeNull();
	});

	it("has a stable fingerprint that differs between keys and does not reveal the key", async () => {
		const print = await keyFingerprint(key);
		expect(print).toMatch(/^[0-9a-f]{16}$/);
		expect(await keyFingerprint(key.slice())).toBe(print);
		expect(await keyFingerprint(generateVaultKey())).not.toBe(print);
		expect(exportVaultKey(key)).not.toContain(print);
	});
});

describe("object names", () => {
	it("are the same for the same content and key, and different otherwise", async () => {
		const plain = data(3000);
		const id = await objectIdOf(key, plain.buffer);
		expect(id).toMatch(/^[0-9a-f]{32}$/);
		expect(await objectIdOf(key, plain.slice().buffer)).toBe(id);
		expect(await objectIdOf(key, data(3001).buffer)).not.toBe(id);
		expect(await objectIdOf(generateVaultKey(), plain.buffer)).not.toBe(id);
	});
});
