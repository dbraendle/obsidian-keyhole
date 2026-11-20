import { sha256Hex } from "../crypto";
import { encodeKeyPath, http, StorageError, TEST_KEY, type StorageBackend } from "./backend";
import { presignUrl, signHeaders, type Credentials } from "./sigv4";

export interface S3Config {
	endpoint: string;
	region: string;
	bucket: string;
	pathStyle: boolean;
	accessKeyId: string;
	secretAccessKey: string;
}

export class S3Backend implements StorageBackend {
	readonly fingerprint: string;
	private readonly creds: Credentials;
	private readonly base: URL;

	constructor(private readonly config: S3Config) {
		let endpoint: URL;
		try {
			endpoint = new URL(config.endpoint.trim());
		} catch {
			throw new StorageError("S3 endpoint is not a valid URL");
		}
		if (endpoint.protocol !== "https:" && !isLocalHost(endpoint.hostname)) {
			throw new StorageError("S3 endpoint must use https://");
		}
		if (!config.bucket.trim()) throw new StorageError("S3 bucket is missing");
		if (!config.accessKeyId || !config.secretAccessKey) throw new StorageError("S3 credentials are missing");
		this.base = endpoint;
		this.creds = {
			accessKeyId: config.accessKeyId.trim(),
			secretAccessKey: config.secretAccessKey,
			region: config.region.trim() || "auto",
		};
		this.fingerprint = `s3:${endpoint.host}/${config.bucket.trim()}`;
	}

	objectUrl(key: string): URL {
		const bucket = this.config.bucket.trim();
		const basePath = this.base.pathname.replace(/\/+$/, "");
		if (this.config.pathStyle) {
			return new URL(`${this.base.protocol}//${this.base.host}${basePath}/${bucket}/${encodeKeyPath(key)}`);
		}
		return new URL(`${this.base.protocol}//${bucket}.${this.base.host}${basePath}/${encodeKeyPath(key)}`);
	}

	async put(key: string, data: ArrayBuffer, contentType: string): Promise<void> {
		const url = this.objectUrl(key);
		const headers = await signHeaders(this.creds, {
			method: "PUT",
			url,
			headers: { "content-type": contentType },
			payloadHash: await sha256Hex(data),
		});
		await http({ url: url.toString(), method: "PUT", headers, body: data }, "Upload failed");
	}

	async get(key: string): Promise<ArrayBuffer> {
		const url = this.objectUrl(key);
		const headers = await signHeaders(this.creds, {
			method: "GET",
			url,
			headers: {},
			payloadHash: await sha256Hex(""),
		});
		const res = await http({ url: url.toString(), method: "GET", headers }, "Download failed");
		return res.arrayBuffer;
	}

	async streamUrl(key: string, ttlSeconds: number): Promise<string> {
		return presignUrl(this.creds, "GET", this.objectUrl(key), ttlSeconds);
	}

	async test(): Promise<void> {
		const body = new TextEncoder().encode(`Keyhole connection test ${new Date().toISOString()}\n`);
		await this.put(TEST_KEY, body.buffer, "text/plain");
		const back = await this.get(TEST_KEY);
		if (back.byteLength !== body.byteLength) throw new StorageError("Read-back returned different content");
	}
}

export function isLocalHost(hostname: string): boolean {
	return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
