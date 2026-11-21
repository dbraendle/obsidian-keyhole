/**
 * Keychain entries Keyhole uses. The ids are fixed: settings (data.json) may be
 * synced or shared, so they must never decide which keychain entry is read.
 *
 * Every secret is bound to the host it was saved for. The storage URL lives in
 * the settings; without the binding, whoever can change the settings could point
 * Keyhole at another server and receive the token.
 */
export const S3_SECRET_ID = "keyhole-s3-secret";
export const HTTP_SECRET_ID = "keyhole-server-secret";
/** The vault's end-to-end encryption key (as text, see e2e/format.ts). */
export const E2E_KEY_ID = "keyhole-e2e-key";

export function bindingId(secretId: string): string {
	return `${secretId}-host`;
}

/** Scheme, host and port of a URL in lower case, or null if it is not a URL. */
export function originOf(url: string): string | null {
	try {
		const origin = new URL(url.trim()).origin.toLowerCase();
		return origin === "null" ? null : origin;
	} catch {
		return null;
	}
}

export type BindingState = "ok" | "unbound" | "other-host";

/** Compares the host a secret was saved for with the host the settings point to now. */
export function checkBinding(bound: string | null, currentUrl: string): BindingState {
	const origin = originOf(currentUrl);
	// Not a URL: no request can be made; the backend reports the invalid address.
	if (!origin) return "ok";
	if (!bound) return "unbound";
	return bound === origin ? "ok" : "other-host";
}

/** Host name for messages, e.g. "files.example.com". */
export function hostOf(origin: string | null): string {
	try {
		return origin ? new URL(origin).host : "";
	} catch {
		return "";
	}
}
