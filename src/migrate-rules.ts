/** Pure helpers for moving local attachments to Keyhole (testable without Obsidian). */
import { escapeAltText, formatUrl, type KeyholeRef } from "./link";

/** Files Obsidian itself renders as notes, not attachments. */
const NOT_ATTACHMENTS = new Set(["md", "canvas", "base"]);

export function isAttachment(extension: string): boolean {
	return !NOT_ATTACHMENTS.has(extension.toLowerCase());
}

/** For links that do not resolve: does the link name a file (has an extension) rather than a note? */
export function looksLikeAttachment(linkpath: string): boolean {
	const base = linkpath.split("/").pop() ?? "";
	const dot = base.lastIndexOf(".");
	return dot > 0 && isAttachment(base.slice(dot + 1));
}

/**
 * The size part of an embed, e.g. "300" or "300x200", from
 * `![[photo.jpg|300]]` or `![photo.jpg|300](photo.jpg)`. Empty if there is none.
 */
export function sizeOf(original: string): string {
	const wiki = /^!\[\[[^\]|]*\|([^\]]*)\]\]$/.exec(original);
	const md = /^!\[[^\]]*?\|([^\]]*)\]\(/.exec(original);
	const candidate = (wiki?.[1] ?? md?.[1] ?? "").trim();
	return /^\d+(x\d+)?$/.test(candidate) ? candidate : "";
}

export function keyholeEmbed(name: string, size: string, ref: KeyholeRef): string {
	return `![${escapeAltText(name)}${size ? `|${size}` : ""}](${formatUrl(ref)})`;
}

export interface Replacement {
	start: number;
	end: number;
	original: string;
	replacement: string;
}

/**
 * Applies replacements from the end of the text to the start, so earlier offsets
 * stay valid. If the text moved since the offsets were computed, falls back to the
 * first occurrence of the original text. Returns the new text and how many applied.
 */
export function applyReplacements(text: string, replacements: Replacement[]): { text: string; applied: number } {
	let out = text;
	let applied = 0;
	for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
		if (out.slice(r.start, r.end) === r.original) {
			out = out.slice(0, r.start) + r.replacement + out.slice(r.end);
			applied++;
			continue;
		}
		const at = out.indexOf(r.original);
		if (at >= 0) {
			out = out.slice(0, at) + r.replacement + out.slice(at + r.original.length);
			applied++;
		}
	}
	return { text: out, applied };
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Does a canvas (its JSON text) show the file at `path`? If the canvas cannot be
 * read as JSON, any mention of the file name counts: better keep a file than lose it.
 */
export function canvasUsesFile(canvasText: string, path: string, name: string): boolean {
	if (!canvasText.trim()) return false;
	try {
		const data = JSON.parse(canvasText) as { nodes?: unknown };
		if (!Array.isArray(data.nodes)) return false;
		return (data.nodes as unknown[]).some(
			(node) => typeof node === "object" && node !== null && (node as { file?: unknown }).file === path,
		);
	} catch {
		return canvasText.includes(name);
	}
}

const KEYHOLE_URL_RE = /keyhole:\/\/[a-z0-9-]+\/[^\s)\]"'<>]+/gi;

/** Every keyhole:// URL in a text (a note or a canvas), exactly as written. */
export function findUrls(text: string): string[] {
	return [...new Set(text.match(KEYHOLE_URL_RE) ?? [])];
}

/**
 * Replaces whole keyhole:// URLs according to `map` (old URL as written → new URL).
 * Everything around them (alt text, sizes, the JSON of a canvas) stays untouched.
 */
export function rewriteUrls(text: string, map: Map<string, string>): { text: string; replaced: number } {
	let replaced = 0;
	const out = text.replace(KEYHOLE_URL_RE, (url) => {
		const next = map.get(url);
		if (next === undefined) return url;
		replaced++;
		return next;
	});
	return { text: out, replaced };
}
