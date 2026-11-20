/** Small Web Crypto helpers. Web Crypto is available on desktop and mobile alike. */

const encoder = new TextEncoder();

export type Bytes = ArrayBuffer | Uint8Array;

function toBuffer(data: Bytes | string): ArrayBuffer {
	if (typeof data === "string") return encoder.encode(data).buffer;
	if (data instanceof Uint8Array) {
		return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
	}
	return data;
}

export function toHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256(data: Bytes | string): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", toBuffer(data));
}

export async function sha256Hex(data: Bytes | string): Promise<string> {
	return toHex(await sha256(data));
}

export async function hmac(key: Bytes | string, data: Bytes | string): Promise<ArrayBuffer> {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		toBuffer(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return crypto.subtle.sign("HMAC", cryptoKey, toBuffer(data));
}

export async function hmacHex(key: Bytes | string, data: Bytes | string): Promise<string> {
	return toHex(await hmac(key, data));
}
