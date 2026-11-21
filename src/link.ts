/**
 * The link format Keyhole writes into notes.
 *
 *   ![photo.jpg](keyhole://main/2026/11/3f2a9c1e0b7d4a55-photo.jpg)
 *
 * - `keyhole:` is a private scheme: nothing outside this plugin can load it,
 *   so a note never makes an unauthenticated request on its own.
 * - `main` is the storage alias. It decouples notes from hosts: moving from
 *   one provider to another means changing the settings, not the notes.
 * - The rest is the object key. It never contains credentials.
 */

export const SCHEME = "keyhole:";
export const UPLOADING_ALIAS = "uploading";

export interface KeyholeRef {
	alias: string;
	key: string;
	/**
	 * File name of an encrypted file. The key of an encrypted file says nothing about
	 * it, so the name travels in the link's fragment (`…/<id>.khe#photo.jpg`), which
	 * stays in the note and is never sent to the storage.
	 */
	name?: string;
}

/** Keys of end-to-end encrypted files end in this. */
export const ENCRYPTED_SUFFIX = ".khe";

export function isEncryptedKey(key: string): boolean {
	return key.endsWith(ENCRYPTED_SUFFIX);
}

/** The id in the key of an encrypted file (a keyed hash of its content), or null. */
export function encryptedId(key: string): string | null {
	return /(?:^|\/)([0-9a-f]{32})\.khe$/.exec(key)?.[1] ?? null;
}

/** The name that tells what kind of file this is: the real file name. */
export function typeName(ref: KeyholeRef): string {
	return ref.name ?? ref.key;
}

const ALIAS_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const KEY_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,199}$/;

export function isValidAlias(alias: string): boolean {
	return ALIAS_RE.test(alias);
}

/** A key is a relative path of safe segments: no "..", no leading dots, no empty segments. */
export function isValidKey(key: string): boolean {
	if (key.length === 0 || key.length > 512) return false;
	return key.split("/").every((segment) => KEY_SEGMENT_RE.test(segment) && !segment.includes(".."));
}

export function formatUrl(ref: KeyholeRef): string {
	return `keyhole://${ref.alias}/${ref.key}${ref.name ? `#${ref.name}` : ""}`;
}

/** Parses a `keyhole://alias/key` URL. Returns null for anything else or anything unsafe. */
export function parseUrl(url: string | null | undefined): KeyholeRef | null {
	if (!url || !url.toLowerCase().startsWith("keyhole://")) return null;
	const rest = url.slice("keyhole://".length).split(/[?#]/)[0] ?? "";
	const slash = rest.indexOf("/");
	if (slash <= 0) return null;
	const alias = rest.slice(0, slash).toLowerCase();
	let key: string;
	try {
		key = decodeURIComponent(rest.slice(slash + 1));
	} catch {
		return null;
	}
	if (!isValidAlias(alias) || !isValidKey(key)) return null;
	if (isEncryptedKey(key)) {
		const hash = url.indexOf("#");
		let name = "";
		try {
			name = hash >= 0 ? decodeURIComponent(url.slice(hash + 1)) : "";
		} catch {
			// no usable name
		}
		if (NAME_RE.test(name)) return { alias, key, name };
	}
	return { alias, key };
}

/** Lower-case extension without the dot, or "" if there is none. */
export function extensionOf(name: string): string {
	const base = name.split("/").pop() ?? "";
	const dot = base.lastIndexOf(".");
	return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** Turns an arbitrary file name into a safe, readable key segment. */
export function safeFileName(fullName: string, fallbackExt: string): string {
	const name = fullName.split(/[/\\]/).pop() ?? "";
	const ext = extensionOf(name) || fallbackExt;
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const cleaned = stem
		.replace(/ß/g, "ss")
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-.]+|[-.]+$/g, "")
		.slice(0, 80);
	const safeStem = cleaned || "file";
	return ext ? `${safeStem}.${ext.replace(/[^a-z0-9]/g, "")}` : safeStem;
}

export interface KeyParts {
	prefix: string;
	date: Date;
	hash: string;
	fileName: string;
}

/**
 * Object keys are content-addressed: `{prefix}{yyyy}/{mm}/{hash16}-{name}`.
 * The same file always maps to the same key, so caches never go stale
 * and uploading a file twice stores it once.
 */
export function buildKey(parts: KeyParts): string {
	const yyyy = String(parts.date.getUTCFullYear());
	const mm = String(parts.date.getUTCMonth() + 1).padStart(2, "0");
	const prefix = normalizePrefix(parts.prefix);
	return `${prefix}${yyyy}/${mm}/${parts.hash.slice(0, 16)}-${parts.fileName}`;
}

const UPLOAD_KEY_RE = /^\d{4}\/\d{2}\/(?:[0-9a-f]{16}-[A-Za-z0-9._-]+|[0-9a-f]{32}\.khe)$/;

/** True if the key has the shape buildKey produces under this (normalized) prefix. */
export function isUploadKey(key: string, prefix: string): boolean {
	return isValidKey(key) && key.startsWith(prefix) && UPLOAD_KEY_RE.test(key.slice(prefix.length));
}

/** Key of an encrypted file: `{prefix}{yyyy}/{mm}/{id}.khe`. The id is a keyed hash of the content. */
export function buildEncryptedKey(parts: { prefix: string; date: Date; id: string }): string {
	const yyyy = String(parts.date.getUTCFullYear());
	const mm = String(parts.date.getUTCMonth() + 1).padStart(2, "0");
	return `${normalizePrefix(parts.prefix)}${yyyy}/${mm}/${parts.id}${ENCRYPTED_SUFFIX}`;
}

/** "notes" -> "notes/", "/a//b/" -> "a/b/", "" -> "". Drops unsafe segments. */
export function normalizePrefix(prefix: string): string {
	const segments = prefix
		.split("/")
		.map((s) => s.trim())
		.filter((s) => s.length > 0 && KEY_SEGMENT_RE.test(s) && !s.includes(".."));
	return segments.length ? `${segments.join("/")}/` : "";
}

/** Escapes text for use as Markdown link text (alt text). */
export function escapeAltText(text: string): string {
	return text.replace(/[[\]|\\]/g, "").replace(/\s+/g, " ").trim();
}

export function markdownEmbed(altText: string, ref: KeyholeRef): string {
	return `![${escapeAltText(altText)}](${formatUrl(ref)})`;
}

/** The file name shown to people: the last key segment without the content-hash prefix. */
export function displayName(ref: KeyholeRef): string {
	if (ref.name) return ref.name;
	const last = ref.key.split("/").pop() ?? ref.key;
	return last.replace(/^[0-9a-f]{16}-/, "");
}

export interface LinkMatch {
	/** Offsets of the whole Markdown construct, e.g. `![alt|300](keyhole://…)`. */
	start: number;
	end: number;
	embed: boolean;
	/** Alt text without a size suffix. */
	text: string;
	/** "300" or "300x200" from `![alt|300](…)`, or "". */
	size: string;
	ref: KeyholeRef;
}

const MD_LINK_RE = /(!?)\[([^\]\n]*)\]\((keyhole:\/\/[^)\s]+)\)/gi;

/** Every Keyhole link or embed in a Markdown text, in order. */
export function findLinks(text: string): LinkMatch[] {
	const out: LinkMatch[] = [];
	for (const m of text.matchAll(MD_LINK_RE)) {
		const ref = parseUrl(m[3]);
		if (!ref || m.index === undefined) continue;
		const alt = m[2] ?? "";
		const sizeMatch = /\|(\d+(?:x\d+)?)\s*$/.exec(alt);
		out.push({
			start: m.index,
			end: m.index + m[0].length,
			embed: m[1] === "!",
			text: sizeMatch ? alt.slice(0, sizeMatch.index) : alt,
			size: sizeMatch?.[1] ?? "",
			ref,
		});
	}
	return out;
}
