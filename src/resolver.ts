import type { FileCache } from "./cache";
import { decrypt, DecryptError } from "./e2e/format";
import { t } from "./i18n";
import { isEncryptedKey, typeName, type KeyholeRef } from "./link";
import { mimeOf } from "./mime";
import type { StorageBackend } from "./storage/backend";

export interface ResolverOptions {
	cacheEnabled: boolean;
	cacheMaxBytes: number;
	cacheMaxFileBytes: number;
	streamLargeMedia: boolean;
}

const STREAM_TTL_SECONDS = 6 * 60 * 60;
const MEMORY_LIMIT_BYTES = 256 * 1024 * 1024;

/**
 * Turns a keyhole reference into something the DOM can load:
 * a blob: URL (memory → offline cache → download) or, for large media,
 * a short-lived signed URL that streams. Credentials never reach the DOM;
 * a signed URL only carries a time-limited signature.
 */
export class Resolver {
	private readonly memory = new Map<string, { url: string; blob: Blob }>();
	private memoryBytes = 0;
	private readonly inflight = new Map<string, Promise<string>>();

	constructor(
		private readonly getBackend: () => StorageBackend,
		private readonly cache: FileCache,
		private readonly options: () => ResolverOptions,
		/** The vault's encryption key. Throws a readable error if this device does not have it. */
		private readonly vaultKey: () => Uint8Array<ArrayBuffer>,
	) {}

	/** Turns stored bytes into the file: decrypts them if the file is encrypted. */
	private async open(ref: KeyholeRef, stored: ArrayBuffer): Promise<Blob> {
		let data = stored;
		if (isEncryptedKey(ref.key)) {
			const key = this.vaultKey();
			try {
				data = await decrypt(key, stored);
			} catch (err) {
				const message = err instanceof DecryptError && err.reason === "not-encrypted" ? t("e2e.notEncrypted") : t("e2e.wrongKey");
				throw new Error(message, { cause: err });
			}
		}
		return new Blob([data], { type: mimeOf(typeName(ref)) });
	}

	private cacheId(key: string): string {
		return `${this.getBackend().fingerprint}|${key}`;
	}

	/** A blob: URL for the file. Downloads it if needed. */
	async blobUrl(ref: KeyholeRef): Promise<string> {
		const id = this.cacheId(ref.key);
		const hit = this.memory.get(id);
		if (hit) {
			// Refresh LRU position.
			this.memory.delete(id);
			this.memory.set(id, hit);
			return hit.url;
		}
		let pending = this.inflight.get(id);
		if (!pending) {
			pending = this.load(id, ref).finally(() => this.inflight.delete(id));
			this.inflight.set(id, pending);
		}
		return pending;
	}

	/** The file itself, e.g. to hand it to pdf.js or the share sheet. */
	async blob(ref: KeyholeRef): Promise<Blob> {
		await this.blobUrl(ref);
		const entry = this.memory.get(this.cacheId(ref.key));
		if (!entry) throw new Error("File was evicted from memory while loading");
		return entry.blob;
	}

	/**
	 * For audio and video: a cached copy if there is one, otherwise a streaming
	 * URL if the backend supports it, otherwise a full download.
	 */
	async mediaUrl(ref: KeyholeRef): Promise<string> {
		const id = this.cacheId(ref.key);
		if (this.memory.has(id) || this.inflight.has(id)) return this.blobUrl(ref);
		const opts = this.options();
		if (opts.cacheEnabled && (await this.cache.has(id).catch(() => false))) return this.blobUrl(ref);
		// An encrypted file cannot be streamed by the media player: it has to be decrypted here.
		if (opts.streamLargeMedia && !isEncryptedKey(ref.key)) {
			const url = await this.getBackend().streamUrl(ref.key, STREAM_TTL_SECONDS);
			if (url) return url;
		}
		return this.blobUrl(ref);
	}

	/** Downloads into the offline cache without creating a blob URL. */
	async makeOffline(ref: KeyholeRef): Promise<"cached" | "already" | "too-large"> {
		const id = this.cacheId(ref.key);
		if (await this.cache.has(id)) return "already";
		const data = await this.getBackend().get(ref.key);
		const opts = this.options();
		if (data.byteLength > opts.cacheMaxFileBytes) return "too-large";
		await this.cache.put(id, new Blob([data], { type: mimeOf(typeName(ref)) }), opts.cacheMaxBytes);
		return "cached";
	}

	/** Called after an upload: the bytes are already here, so cache them right away. */
	async prime(ref: KeyholeRef, data: ArrayBuffer | Blob, stored?: ArrayBuffer): Promise<void> {
		const opts = this.options();
		// A Blob (e.g. a picked file) is referenced, not copied into memory.
		const blob = new Blob([data], { type: mimeOf(typeName(ref)) });
		const id = this.cacheId(ref.key);
		this.remember(id, blob);
		// The offline cache holds what the storage holds: ciphertext for encrypted files.
		const forCache = isEncryptedKey(ref.key) ? (stored ? new Blob([stored]) : null) : blob;
		if (forCache && opts.cacheEnabled && forCache.size <= opts.cacheMaxFileBytes) {
			await this.cache.put(id, forCache, opts.cacheMaxBytes).catch(() => undefined);
		}
	}

	private async load(id: string, ref: KeyholeRef): Promise<string> {
		const opts = this.options();
		if (opts.cacheEnabled) {
			const cached = await this.cache.get(id).catch(() => null);
			if (cached) return this.remember(id, await this.open(ref, await cached.arrayBuffer()));
		}
		const data = await this.getBackend().get(ref.key);
		if (opts.cacheEnabled && data.byteLength <= opts.cacheMaxFileBytes) {
			await this.cache.put(id, new Blob([data], { type: mimeOf(typeName(ref)) }), opts.cacheMaxBytes).catch(() => undefined);
		}
		return this.remember(id, await this.open(ref, data));
	}

	private remember(id: string, blob: Blob): string {
		const existing = this.memory.get(id);
		if (existing) return existing.url;
		const url = URL.createObjectURL(blob);
		this.memory.set(id, { url, blob });
		this.memoryBytes += blob.size;
		// Only evict by size, never because an element left the DOM: Live Preview
		// moves and re-creates nodes constantly, and revoking on removal causes flicker.
		for (const [oldId, entry] of this.memory) {
			if (this.memoryBytes <= MEMORY_LIMIT_BYTES || oldId === id) break;
			URL.revokeObjectURL(entry.url);
			this.memory.delete(oldId);
			this.memoryBytes -= entry.blob.size;
		}
		return url;
	}

	/** Forgets a file in memory and in the offline cache, so the next load downloads it again. */
	async invalidate(ref: KeyholeRef): Promise<void> {
		const id = this.cacheId(ref.key);
		const entry = this.memory.get(id);
		if (entry) {
			URL.revokeObjectURL(entry.url);
			this.memoryBytes -= entry.blob.size;
			this.memory.delete(id);
		}
		this.inflight.delete(id);
		await this.cache.delete(id).catch(() => undefined);
	}

	/** Drops in-memory URLs, e.g. after the storage settings changed. */
	reset(): void {
		for (const entry of this.memory.values()) URL.revokeObjectURL(entry.url);
		this.memory.clear();
		this.memoryBytes = 0;
		this.inflight.clear();
	}
}
