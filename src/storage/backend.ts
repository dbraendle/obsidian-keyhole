import { requestUrl, type RequestUrlParam, type RequestUrlResponse } from "obsidian";
import { t } from "../i18n";

export interface StorageBackend {
	/** Stable, non-secret identity of the storage location (used to namespace the cache). */
	readonly fingerprint: string;
	put(key: string, data: ArrayBuffer, contentType: string): Promise<void>;
	get(key: string): Promise<ArrayBuffer>;
	/**
	 * A short-lived URL a media element can load directly (for streaming audio and
	 * video without downloading the whole file first). Null if the backend cannot do it.
	 */
	streamUrl(key: string, ttlSeconds: number): Promise<string | null>;
	/** Checks that uploading and downloading works. Throws with a readable message otherwise. */
	test(): Promise<void>;
	/** All stored objects whose key starts with prefix. */
	list(prefix: string): Promise<StoredObject[]>;
	delete(key: string): Promise<void>;
}

export interface StoredObject {
	key: string;
	size: number;
	/** Milliseconds since the epoch; 0 if unknown. */
	lastModified: number;
}

export class StorageError extends Error {
	constructor(
		message: string,
		readonly status?: number,
	) {
		super(message);
		this.name = "StorageError";
	}
}

/** Encodes each path segment of a key for use in a URL. */
export function encodeKeyPath(key: string): string {
	return key.split("/").map(encodeURIComponent).join("/");
}

/**
 * requestUrl bypasses CORS on desktop and mobile. Errors never echo request
 * headers or URLs with signatures, so credentials cannot leak into notices or logs.
 */
export async function http(params: RequestUrlParam, what: string): Promise<RequestUrlResponse> {
	let res: RequestUrlResponse;
	try {
		res = await requestUrl({ ...params, throw: false });
	} catch (err) {
		throw new StorageError(t("storage.networkError", { what, error: err instanceof Error ? err.message : t("error.unknown") }));
	}
	if (res.status >= 400) {
		throw new StorageError(`${what}: ${describeStatus(res.status)}`, res.status);
	}
	return res;
}

export function describeStatus(status: number): string {
	switch (status) {
		case 401:
			return t("storage.status401");
		case 403:
			return t("storage.status403");
		case 404:
			return t("storage.status404");
		case 409:
			return t("storage.status409");
		case 413:
			return t("storage.status413");
		default:
			return t("storage.statusOther", { status });
	}
}

export const TEST_KEY = "keyhole-connection-test.txt";
