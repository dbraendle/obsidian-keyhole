/**
 * Short-lived signed URLs for the Keyhole reference server.
 *
 * Media elements (<video>, <audio>) cannot send an Authorization header, so
 * streaming needs a URL that carries its own proof. The URL never contains the
 * token itself, only an HMAC over method, key and expiry, made with a key
 * derived from the token. The server derives the same key and checks it.
 *
 * MUST stay in sync with server/src/sign.ts.
 */
import { hmac, hmacHex } from "../crypto";

export const SIGNING_CONTEXT = "keyhole-url-signing-v1";

export async function deriveSigningKey(token: string): Promise<ArrayBuffer> {
	return hmac(token, SIGNING_CONTEXT);
}

export function stringToSign(method: string, key: string, expires: number): string {
	return `${method.toUpperCase()}\n${key}\n${expires}`;
}

export async function signKey(token: string, method: string, key: string, expires: number): Promise<string> {
	return hmacHex(await deriveSigningKey(token), stringToSign(method, key, expires));
}
