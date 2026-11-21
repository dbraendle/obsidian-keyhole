/**
 * End-to-end encryption: the file format and the key handling. Pure Web Crypto,
 * so it runs on desktop and mobile. Nothing in here talks to Obsidian or the network.
 *
 * An encrypted file ("KHE1") is:
 *
 *   magic   4 bytes   "KHE1"
 *   salt    16 bytes  random, per file
 *   chunks            the plaintext in pieces of 1 MiB, each sealed with AES-256-GCM
 *                     (16 byte tag appended)
 *
 * - The file key is HKDF-SHA256(vault key, salt, "keyhole-e2e-v1 file"). A fresh
 *   salt per file means a fresh key per file, so nonces can be plain counters.
 * - The nonce of a chunk is its index (11 bytes, big-endian) plus one byte that is 1
 *   for the last chunk and 0 otherwise. This is the STREAM construction used by age:
 *   chunks cannot be reordered, dropped or cut off without the decryption failing.
 * - The magic is authenticated with every chunk (as additional data), so a file
 *   cannot be passed off as another format version.
 * - Chunks are independent, which leaves the door open for decrypting a byte range
 *   (streaming) later without changing the format.
 *
 * The provider sees the size (rounded up by 20 bytes plus 16 per MiB), the upload
 * time and the object name, which is derived from the content with a keyed hash and
 * says nothing about the content to anyone without the key.
 */
import { hmac, toHex } from "../crypto";
import type { ByteSource } from "../storage/source";

export const MAGIC = new Uint8Array([0x4b, 0x48, 0x45, 0x31]); // "KHE1"
export const SALT_BYTES = 16;
export const HEADER_BYTES = MAGIC.length + SALT_BYTES;
export const TAG_BYTES = 16;
export const CHUNK_BYTES = 1024 * 1024;
export const KEY_BYTES = 32;
/** Extension of encrypted objects in the storage. */
export const ENCRYPTED_EXTENSION = "khe";

const KEY_PREFIX = "keyhole-key-v1:";
const encoder = new TextEncoder();

export class DecryptError extends Error {
	constructor(readonly reason: "not-encrypted" | "wrong-key-or-damaged") {
		super(reason === "not-encrypted" ? "Not a Keyhole-encrypted file" : "Wrong key, or the file was changed or damaged");
		this.name = "DecryptError";
	}
}

/** A view of the bytes; an ArrayBuffer is not copied. */
function bytes(data: ArrayBuffer | Uint8Array): Uint8Array {
	return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export function generateVaultKey(): Uint8Array<ArrayBuffer> {
	return crypto.getRandomValues(new Uint8Array(KEY_BYTES));
}

function toBase64Url(data: Uint8Array): string {
	let binary = "";
	for (const byte of data) binary += String.fromCharCode(byte);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
	if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
	try {
		const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
		return Uint8Array.from(binary, (c) => c.charCodeAt(0));
	} catch {
		return null;
	}
}

/** The key as text, for the password manager and for the other devices. */
export function exportVaultKey(key: Uint8Array): string {
	return KEY_PREFIX + toBase64Url(key);
}

/** Reads a key written by exportVaultKey. Null if the text is not a complete key. */
export function importVaultKey(text: string): Uint8Array<ArrayBuffer> | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith(KEY_PREFIX)) return null;
	const key = fromBase64Url(trimmed.slice(KEY_PREFIX.length));
	return key && key.length === KEY_BYTES ? key : null;
}

async function hkdf(vaultKey: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, info: string, bits: number): Promise<ArrayBuffer> {
	const base = await crypto.subtle.importKey("raw", vaultKey, "HKDF", false, ["deriveBits"]);
	return crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: encoder.encode(info) }, base, bits);
}

async function fileKey(vaultKey: Uint8Array<ArrayBuffer>, salt: Uint8Array<ArrayBuffer>, usage: "encrypt" | "decrypt"): Promise<CryptoKey> {
	const raw = await hkdf(vaultKey, salt, "keyhole-e2e-v1 file", 256);
	return crypto.subtle.importKey("raw", raw, "AES-GCM", false, [usage]);
}

async function nameKey(vaultKey: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
	return hkdf(vaultKey, new Uint8Array(0), "keyhole-e2e-v1 name", 256);
}

/**
 * A short, non-secret fingerprint of the key. It is stored in the (synced) settings
 * so that another device can tell whether the key pasted there is the right one.
 */
export async function keyFingerprint(vaultKey: Uint8Array<ArrayBuffer>): Promise<string> {
	return toHex(await hkdf(vaultKey, new Uint8Array(0), "keyhole-e2e-v1 fingerprint", 64));
}

/**
 * The name of an encrypted object: a keyed hash of the content. The same file gives
 * the same name (so uploading it twice stores it once), but without the key nobody
 * can tell from the name what the file is, or test a guess.
 */
export async function objectId(vaultKey: Uint8Array<ArrayBuffer>, plaintextSha256Hex: string): Promise<string> {
	return toHex(await hmac(await nameKey(vaultKey), plaintextSha256Hex)).slice(0, 32);
}

function nonce(index: number, last: boolean): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(12);
	// 11 bytes of big-endian counter; a file never has more than 2^53 chunks.
	new DataView(out.buffer).setUint32(3, Math.floor(index / 0x100000000));
	new DataView(out.buffer).setUint32(7, index >>> 0);
	out[11] = last ? 1 : 0;
	return out;
}

export function chunkCount(plainBytes: number): number {
	return Math.max(1, Math.ceil(plainBytes / CHUNK_BYTES));
}

export function encryptedSize(plainBytes: number): number {
	return HEADER_BYTES + plainBytes + chunkCount(plainBytes) * TAG_BYTES;
}

export interface Encryptor {
	/** Goes first in the encrypted file. */
	header: Uint8Array<ArrayBuffer>;
	/** Seals chunk `index` (CHUNK_BYTES of plaintext, less only for the last one). */
	chunk(index: number, plain: ArrayBuffer, last: boolean): Promise<ArrayBuffer>;
}

/** Encrypts a file chunk by chunk, so the caller decides how much is in memory at once. */
export async function createEncryptor(vaultKey: Uint8Array<ArrayBuffer>): Promise<Encryptor> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	const key = await fileKey(vaultKey, salt, "encrypt");
	const header = new Uint8Array(HEADER_BYTES);
	header.set(MAGIC, 0);
	header.set(salt, MAGIC.length);
	return {
		header,
		chunk: (index, plain, last) =>
			crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce(index, last), additionalData: MAGIC, tagLength: TAG_BYTES * 8 }, key, plain),
	};
}

/**
 * The encrypted file as bytes that are produced on demand: reading a range encrypts
 * just the chunks it touches. A chunk always encrypts to the same bytes (same key,
 * nonce and content), so ranges can be read in any order and more than once.
 */
export function encryptedSource(encryptor: Encryptor, plain: Blob): ByteSource {
	const size = encryptedSize(plain.size);
	const sealed = CHUNK_BYTES + TAG_BYTES;
	const count = chunkCount(plain.size);
	return {
		size,
		async read(start, end) {
			const to = Math.min(end, size);
			const out = new Uint8Array(Math.max(0, to - start));
			if (start < HEADER_BYTES) out.set(encryptor.header.subarray(start, Math.min(to, HEADER_BYTES)), 0);
			for (let i = Math.max(0, Math.floor((start - HEADER_BYTES) / sealed)); i < count; i++) {
				const chunkStart = HEADER_BYTES + i * sealed;
				if (chunkStart >= to) break;
				const piece = await plain.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES).arrayBuffer();
				const chunk = new Uint8Array(await encryptor.chunk(i, piece, i === count - 1));
				const from = Math.max(start, chunkStart);
				const until = Math.min(to, chunkStart + chunk.length);
				if (until > from) out.set(chunk.subarray(from - chunkStart, until - chunkStart), from - start);
			}
			return out.buffer;
		},
	};
}

/** Encrypts a whole file. The result is a Blob made of the sealed chunks. */
export async function encrypt(vaultKey: Uint8Array<ArrayBuffer>, plain: Blob): Promise<Blob> {
	const encryptor = await createEncryptor(vaultKey);
	const parts: BlobPart[] = [encryptor.header];
	const count = chunkCount(plain.size);
	for (let i = 0; i < count; i++) {
		const piece = await plain.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES).arrayBuffer();
		parts.push(await encryptor.chunk(i, piece, i === count - 1));
	}
	return new Blob(parts, { type: "application/octet-stream" });
}

export function isEncrypted(data: ArrayBuffer | Uint8Array): boolean {
	const head = bytes(data).subarray(0, MAGIC.length);
	return head.length === MAGIC.length && MAGIC.every((b, i) => head[i] === b);
}

/**
 * Decrypts a whole file. Throws DecryptError if the key is wrong or a single bit
 * of the file was changed, a chunk is missing, or the end was cut off.
 */
export async function decrypt(vaultKey: Uint8Array<ArrayBuffer>, data: ArrayBuffer): Promise<ArrayBuffer> {
	const all = bytes(data);
	if (!isEncrypted(all)) throw new DecryptError("not-encrypted");
	const sealed = CHUNK_BYTES + TAG_BYTES;
	const body = all.subarray(HEADER_BYTES);
	if (all.length < HEADER_BYTES + TAG_BYTES) throw new DecryptError("wrong-key-or-damaged");
	const key = await fileKey(vaultKey, all.slice(MAGIC.length, HEADER_BYTES), "decrypt");
	const count = Math.ceil(body.length / sealed);
	const out = new Uint8Array(body.length - count * TAG_BYTES);
	let written = 0;
	for (let i = 0; i < count; i++) {
		const piece = body.slice(i * sealed, (i + 1) * sealed);
		let plain: ArrayBuffer;
		try {
			plain = await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv: nonce(i, i === count - 1), additionalData: MAGIC, tagLength: TAG_BYTES * 8 },
				key,
				piece,
			);
		} catch {
			throw new DecryptError("wrong-key-or-damaged");
		}
		// Only an empty file ends in an empty chunk. Anything else that does was not written by Keyhole.
		if (plain.byteLength === 0 && count > 1) throw new DecryptError("wrong-key-or-damaged");
		out.set(new Uint8Array(plain), written);
		written += plain.byteLength;
	}
	return out.buffer;
}
