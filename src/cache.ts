/**
 * Offline cache in IndexedDB. It lives in this device's app storage, outside the
 * vault, so it is never synced, committed or backed up with the notes.
 * Entries are content-addressed (keys contain a content hash), so they never go stale.
 */

interface Entry {
	id: string;
	blob: Blob;
	size: number;
	lastAccess: number;
}

const STORE = "files";

function promisify<T>(req: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
	});
}

function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
		tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
	});
}

export class FileCache {
	private db: Promise<IDBDatabase> | null = null;

	constructor(private readonly name: string) {}

	private open(): Promise<IDBDatabase> {
		if (!this.db) {
			this.db = new Promise((resolve, reject) => {
				const req = indexedDB.open(this.name, 1);
				req.onupgradeneeded = () => {
					const store = req.result.createObjectStore(STORE, { keyPath: "id" });
					store.createIndex("lastAccess", "lastAccess");
				};
				req.onsuccess = () => resolve(req.result);
				req.onerror = () => reject(req.error ?? new Error("Cannot open the offline cache"));
			});
			this.db.catch(() => (this.db = null));
		}
		return this.db;
	}

	async get(id: string): Promise<Blob | null> {
		const db = await this.open();
		const tx = db.transaction(STORE, "readwrite");
		const store = tx.objectStore(STORE);
		const entry = (await promisify(store.get(id))) as Entry | undefined;
		if (entry) store.put({ ...entry, lastAccess: Date.now() });
		await done(tx);
		return entry?.blob ?? null;
	}

	async has(id: string): Promise<boolean> {
		const db = await this.open();
		const tx = db.transaction(STORE, "readonly");
		const count = await promisify(tx.objectStore(STORE).count(id));
		return count > 0;
	}

	async put(id: string, blob: Blob, maxBytes: number): Promise<void> {
		const db = await this.open();
		const tx = db.transaction(STORE, "readwrite");
		tx.objectStore(STORE).put({ id, blob, size: blob.size, lastAccess: Date.now() } satisfies Entry);
		await done(tx);
		await this.evict(maxBytes);
	}

	/** Removes least recently used entries until the cache fits into maxBytes. */
	async evict(maxBytes: number): Promise<void> {
		const db = await this.open();
		const tx = db.transaction(STORE, "readwrite");
		const store = tx.objectStore(STORE);
		const entries: { id: string; size: number }[] = [];
		await new Promise<void>((resolve, reject) => {
			const cursorReq = store.index("lastAccess").openCursor();
			cursorReq.onsuccess = () => {
				const cursor = cursorReq.result;
				if (!cursor) return resolve();
				const value = cursor.value as Entry;
				entries.push({ id: value.id, size: value.size });
				cursor.continue();
			};
			cursorReq.onerror = () => reject(cursorReq.error ?? new Error("IndexedDB cursor failed"));
		});
		for (const id of pickEvictions(entries, maxBytes)) store.delete(id);
		await done(tx);
	}

	async usage(): Promise<{ count: number; bytes: number }> {
		const db = await this.open();
		const tx = db.transaction(STORE, "readonly");
		const all = (await promisify(tx.objectStore(STORE).getAll())) as Entry[];
		return { count: all.length, bytes: all.reduce((sum, e) => sum + e.size, 0) };
	}

	async clear(): Promise<void> {
		const db = await this.open();
		const tx = db.transaction(STORE, "readwrite");
		tx.objectStore(STORE).clear();
		await done(tx);
	}

	close(): void {
		void this.db?.then((db) => db.close()).catch(() => undefined);
		this.db = null;
	}
}

/**
 * Given entries ordered from least to most recently used, returns the ids to
 * delete so that the remaining total fits into maxBytes.
 */
export function pickEvictions(entriesOldestFirst: { id: string; size: number }[], maxBytes: number): string[] {
	let total = entriesOldestFirst.reduce((sum, e) => sum + e.size, 0);
	const out: string[] = [];
	for (const entry of entriesOldestFirst) {
		if (total <= maxBytes) break;
		out.push(entry.id);
		total -= entry.size;
	}
	return out;
}
