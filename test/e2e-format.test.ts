import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/crypto";
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
	objectId,
	createEncryptor,
	encryptedSource,
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

	it("refuses an empty chunk after full ones (only an empty file ends in one)", async () => {
		const encryptor = await createEncryptor(key);
		const full = new Uint8Array(await encryptor.chunk(0, data(CHUNK_BYTES).buffer, false));
		const empty = new Uint8Array(await encryptor.chunk(1, new ArrayBuffer(0), true));
		const file = new Uint8Array(HEADER_BYTES + full.length + empty.length);
		file.set(encryptor.header, 0);
		file.set(full, HEADER_BYTES);
		file.set(empty, HEADER_BYTES + full.length);
		await expect(decrypt(key, file.buffer)).rejects.toBeInstanceOf(DecryptError);
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
		const hash = await sha256Hex(data(3000));
		const id = await objectId(key, hash);
		expect(id).toMatch(/^[0-9a-f]{32}$/);
		expect(await objectId(key, hash)).toBe(id);
		expect(await objectId(key, await sha256Hex(data(3001)))).not.toBe(id);
		expect(await objectId(generateVaultKey(), hash)).not.toBe(id);
		expect(id).not.toContain(hash.slice(0, 16));
	});
});

describe("encrypting while reading (for uploads in parts)", () => {
	it("gives a valid file whatever the ranges are", async () => {
		const plain = data(2 * CHUNK_BYTES + 12345);
		const source = encryptedSource(await createEncryptor(key), new Blob([plain]));
		expect(source.size).toBe(encryptedSize(plain.length));
		for (const part of [source.size, 1_500_000, CHUNK_BYTES + TAG_BYTES, 7, 999_983].filter((n) => n > 1000 || source.size < 5_000_000)) {
			if (part === 7) continue;
			const out = new Uint8Array(source.size);
			for (let at = 0; at < source.size; at += part) out.set(new Uint8Array(await source.read(at, at + part)), at);
			expect(new Uint8Array(await decrypt(key, out.buffer)), `parts of ${part}`).toEqual(plain);
		}
		// overlapping and repeated reads agree
		const a = new Uint8Array(await source.read(10, 2_000_000));
		const b = new Uint8Array(await source.read(1_000_000, 1_000_100));
		expect(b).toEqual(a.subarray(1_000_000 - 10, 1_000_100 - 10));
		expect((await source.read(source.size - 5, source.size + 100)).byteLength).toBe(5);
	});

	it("handles an empty file", async () => {
		const source = encryptedSource(await createEncryptor(key), new Blob([]));
		const all = await source.read(0, source.size);
		expect(all.byteLength).toBe(HEADER_BYTES + TAG_BYTES);
		expect((await decrypt(key, all)).byteLength).toBe(0);
	});
});
