/** Parsers for storage listings (pure, testable). */
import type { StoredObject } from "./backend";

function unescapeXml(text: string): string {
	return text
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&#(\d+);/g, (_m, n: string) => String.fromCharCode(Number(n)))
		.replace(/&amp;/g, "&");
}

function tag(xml: string, name: string): string | null {
	const m = new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "i").exec(xml);
	return m ? unescapeXml(m[1] ?? "") : null;
}

function blocks(xml: string, name: string): string[] {
	return xml.match(new RegExp(`<(?:[\\w-]+:)?${name}\\b[^>]*>[\\s\\S]*?</(?:[\\w-]+:)?${name}>`, "gi")) ?? [];
}

/** S3 ListObjectsV2 response → objects plus the continuation token, if truncated. */
export function parseS3List(xml: string): { objects: StoredObject[]; next: string | null } {
	const objects = blocks(xml, "Contents").map((c) => ({
		key: tag(c, "Key") ?? "",
		size: Number(tag(c, "Size") ?? 0),
		lastModified: Date.parse(tag(c, "LastModified") ?? "") || 0,
	}));
	const truncated = (tag(xml, "IsTruncated") ?? "").toLowerCase() === "true";
	return { objects: objects.filter((o) => o.key), next: truncated ? tag(xml, "NextContinuationToken") : null };
}

export interface DavEntry {
	/** Decoded path from the server, e.g. /remote.php/dav/files/me/keyhole/2026/11/a.png */
	path: string;
	collection: boolean;
	size: number;
	lastModified: number;
}

/** WebDAV PROPFIND (Depth: 1) multistatus → entries. */
export function parseDavList(xml: string): DavEntry[] {
	return blocks(xml, "response").map((r) => {
		const href = tag(r, "href") ?? "";
		let path = href;
		try {
			path = decodeURIComponent(new URL(href, "http://x").pathname);
		} catch {
			// keep raw
		}
		return {
			path,
			collection: /<(?:[\w-]+:)?collection\b/i.test(r),
			size: Number(tag(r, "getcontentlength") ?? 0),
			lastModified: Date.parse(tag(r, "getlastmodified") ?? "") || 0,
		};
	});
}

/** Keyhole server listing (JSON) → objects. Anything that is not a well-formed entry is dropped. */
export function parseKeyholeList(json: unknown): StoredObject[] {
	if (!Array.isArray(json)) return [];
	const out: StoredObject[] = [];
	for (const item of json as unknown[]) {
		if (typeof item !== "object" || item === null) continue;
		const { key, size, lastModified } = item as Record<string, unknown>;
		if (typeof key !== "string" || !key) continue;
		out.push({
			key,
			size: typeof size === "number" && Number.isFinite(size) ? size : 0,
			lastModified: typeof lastModified === "number" && Number.isFinite(lastModified) ? lastModified : 0,
		});
	}
	return out;
}
