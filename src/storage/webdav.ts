import { encodeKeyPath, http, StorageError, TEST_KEY, type StorageBackend, type StoredObject } from "./backend";
import { parseDavList } from "./listing";
import { signKey } from "./keyhole-sign";
import { isLocalHost } from "./s3";
import { t } from "../i18n";

export interface HttpStoreConfig {
	/** Base URL; object keys are appended to it. */
	baseUrl: string;
	auth: "bearer" | "basic";
	username: string;
	/** Bearer token or Basic password. */
	secret: string;
	/** Keyhole server: supports signed URLs for streaming and creates folders itself. */
	keyholeServer: boolean;
}

/**
 * Plain HTTP PUT/GET storage: WebDAV servers (Nextcloud, Synology, rclone serve
 * webdav, Caddy, nginx) and the Keyhole reference server.
 */
export class HttpBackend implements StorageBackend {
	readonly fingerprint: string;
	private readonly base: string;
	private readonly authHeader: string;
	private readonly knownFolders = new Set<string>();

	constructor(private readonly config: HttpStoreConfig) {
		let url: URL;
		try {
			url = new URL(config.baseUrl.trim());
		} catch {
			throw new StorageError(t("storage.httpInvalidUrl"));
		}
		if (url.protocol !== "https:" && !isLocalHost(url.hostname)) {
			throw new StorageError(t("storage.httpHttps"));
		}
		if (url.username || url.password) throw new StorageError(t("storage.httpCredentialsInUrl"));
		if (!config.secret) throw new StorageError(t("storage.httpNoCredentials"));
		this.base = url.toString().replace(/\/?$/, "/");
		this.authHeader =
			config.auth === "basic"
				? `Basic ${base64(`${config.username}:${config.secret}`)}`
				: `Bearer ${config.secret}`;
		this.fingerprint = `http:${url.host}${url.pathname}`;
	}

	private url(key: string): string {
		return this.base + encodeKeyPath(key);
	}

	async put(key: string, data: ArrayBuffer, contentType: string): Promise<void> {
		const request = {
			url: this.url(key),
			method: "PUT",
			contentType,
			headers: { Authorization: this.authHeader },
			body: data,
		};
		try {
			await http(request, t("storage.uploadFailed"));
		} catch (err) {
			// WebDAV answers 409 when the parent collection does not exist yet.
			if (!(err instanceof StorageError) || err.status !== 409 || this.config.keyholeServer) throw err;
			await this.createFolders(key);
			await http(request, t("storage.uploadFailed"));
		}
	}

	private async createFolders(key: string): Promise<void> {
		const segments = key.split("/").slice(0, -1);
		let path = "";
		for (const segment of segments) {
			path += `${segment}/`;
			if (this.knownFolders.has(path)) continue;
			try {
				await http(
					{ url: this.base + encodeKeyPath(path), method: "MKCOL", headers: { Authorization: this.authHeader } },
					t("storage.mkcolFailed"),
				);
			} catch (err) {
				// 405 Method Not Allowed: the collection already exists.
				if (!(err instanceof StorageError) || err.status !== 405) throw err;
			}
			this.knownFolders.add(path);
		}
	}

	async get(key: string): Promise<ArrayBuffer> {
		const res = await http(
			{ url: this.url(key), method: "GET", headers: { Authorization: this.authHeader } },
			t("storage.downloadFailed"),
		);
		return res.arrayBuffer;
	}

	async streamUrl(key: string, ttlSeconds: number): Promise<string | null> {
		if (!this.config.keyholeServer || this.config.auth !== "bearer") return null;
		const expires = Math.floor(Date.now() / 1000) + Math.max(60, Math.floor(ttlSeconds));
		const sig = await signKey(this.config.secret, "GET", key, expires);
		return `${this.url(key)}?ke=${expires}&ks=${sig}`;
	}

	async list(prefix: string): Promise<StoredObject[]> {
		if (this.config.keyholeServer) {
			const url = `${this.base}?list=1${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ""}`;
			const res = await http({ url, method: "GET", headers: { Authorization: this.authHeader } }, t("storage.listFailed"));
			return res.json as StoredObject[];
		}
		// WebDAV: walk the collections with Depth 1 (Depth: infinity is often disabled).
		const basePath = decodeURIComponent(new URL(this.base).pathname);
		const out: StoredObject[] = [];
		const queue = [prefix.replace(/[^/]*$/, "")];
		while (queue.length) {
			const folder = queue.shift() ?? "";
			const res = await http(
				{
					url: this.base + encodeKeyPath(folder),
					method: "PROPFIND",
					headers: { Authorization: this.authHeader, Depth: "1", "Content-Type": "application/xml" },
					body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/><d:getcontentlength/><d:getlastmodified/></d:prop></d:propfind>',
				},
				t("storage.listFailed"),
			);
			for (const entry of parseDavList(res.text)) {
				if (!entry.path.startsWith(basePath)) continue;
				const key = entry.path.slice(basePath.length).replace(/\/$/, "");
				if (!key || key === folder.replace(/\/$/, "")) continue;
				if (entry.collection) queue.push(`${key}/`);
				else if (key.startsWith(prefix)) out.push({ key, size: entry.size, lastModified: entry.lastModified });
			}
		}
		return out;
	}

	async delete(key: string): Promise<void> {
		await http(
			{ url: this.url(key), method: "DELETE", headers: { Authorization: this.authHeader } },
			t("storage.deleteFailed"),
		);
	}

	async test(): Promise<void> {
		const body = new TextEncoder().encode(`Keyhole connection test ${new Date().toISOString()}\n`);
		await this.put(TEST_KEY, body.buffer, "text/plain");
		const back = await this.get(TEST_KEY);
		if (back.byteLength !== body.byteLength) throw new StorageError(t("storage.readBackMismatch"));
	}
}

function base64(text: string): string {
	let binary = "";
	for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
	return btoa(binary);
}
