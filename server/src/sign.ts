/**
 * Signed URLs for media streaming. MUST stay in sync with src/storage/keyhole-sign.ts.
 * The URL carries an HMAC over method, key and expiry, made with a key derived
 * from the bearer token – never the token itself.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const SIGNING_CONTEXT = "keyhole-url-signing-v1";

export function signKey(token: string, method: string, key: string, expires: number): string {
	const signingKey = createHmac("sha256", token).update(SIGNING_CONTEXT).digest();
	return createHmac("sha256", signingKey).update(`${method.toUpperCase()}\n${key}\n${expires}`).digest("hex");
}

export function safeEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a);
	const bb = Buffer.from(b);
	return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Checks a signed URL against every configured token. */
export function verifySignature(
	tokens: string[],
	method: string,
	key: string,
	expires: number,
	signature: string,
	now: number = Date.now() / 1000,
): boolean {
	if (!Number.isFinite(expires) || expires < now) return false;
	// Refuse links that live suspiciously long (7 days), like S3 does.
	if (expires - now > 7 * 24 * 3600) return false;
	return tokens.some((token) => safeEqual(signKey(token, method, key, expires), signature));
}
