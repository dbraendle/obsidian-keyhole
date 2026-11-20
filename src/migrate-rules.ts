/** Pure helpers for moving local attachments to Keyhole (testable without Obsidian). */
import { escapeAltText, formatUrl, type KeyholeRef } from "./link";

/** Files Obsidian itself renders as notes, not attachments. */
const NOT_ATTACHMENTS = new Set(["md", "canvas", "base"]);

export function isAttachment(extension: string): boolean {
	return !NOT_ATTACHMENTS.has(extension.toLowerCase());
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
