import { extensionOf } from "./link";

export type MediaKind = "image" | "audio" | "video" | "pdf" | "file";

const TYPES: Record<string, [MediaKind, string]> = {
	png: ["image", "image/png"],
	jpg: ["image", "image/jpeg"],
	jpeg: ["image", "image/jpeg"],
	gif: ["image", "image/gif"],
	webp: ["image", "image/webp"],
	avif: ["image", "image/avif"],
	bmp: ["image", "image/bmp"],
	svg: ["image", "image/svg+xml"],
	heic: ["image", "image/heic"],
	mp3: ["audio", "audio/mpeg"],
	m4a: ["audio", "audio/mp4"],
	wav: ["audio", "audio/wav"],
	ogg: ["audio", "audio/ogg"],
	opus: ["audio", "audio/ogg"],
	flac: ["audio", "audio/flac"],
	webm: ["video", "video/webm"],
	mp4: ["video", "video/mp4"],
	m4v: ["video", "video/mp4"],
	mov: ["video", "video/quicktime"],
	mkv: ["video", "video/x-matroska"],
	ogv: ["video", "video/ogg"],
	pdf: ["pdf", "application/pdf"],
};

const MIME_TO_EXT: Record<string, string> = Object.fromEntries(
	Object.entries(TYPES).map(([ext, [, mime]]) => [mime, ext]),
);
MIME_TO_EXT["image/jpeg"] = "jpg";
MIME_TO_EXT["audio/mp4"] = "m4a";
MIME_TO_EXT["video/mp4"] = "mp4";

export function kindOf(name: string): MediaKind {
	return TYPES[extensionOf(name)]?.[0] ?? "file";
}

export function mimeOf(name: string): string {
	return TYPES[extensionOf(name)]?.[1] ?? "application/octet-stream";
}

/** Best extension for a MIME type, used for pasted files without a usable name. */
export function extensionForMime(mime: string): string {
	return MIME_TO_EXT[mime.split(";")[0]?.trim().toLowerCase() ?? ""] ?? "bin";
}
