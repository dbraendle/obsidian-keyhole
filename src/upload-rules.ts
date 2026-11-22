import { extensionForMime, kindOf } from "./mime";
import type { KeyholeSettings } from "./settings";

export const UPLOAD_CONCURRENCY = 3;

/** Runs `worker` over `items` with at most `limit` running at the same time, in order of start. */
export async function runLimited<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
	let next = 0;
	const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (next < items.length) {
			const item = items[next++] as T;
			await worker(item);
		}
	});
	await Promise.all(lanes);
}

/** Decides which files Keyhole takes over. Everything else is left to Obsidian. */
export function shouldUpload(file: { name: string; type: string; size: number }, settings: KeyholeSettings): boolean {
	if (file.size === 0 || file.size > settings.maxUploadMB * 1024 * 1024) return false;
	const kind = kindOf(nameFor(file));
	if (kind === "image") return settings.uploadImages;
	if (kind === "audio") return settings.uploadAudio;
	if (kind === "video") return settings.uploadVideo;
	if (kind === "pdf") return settings.uploadPdf;
	return settings.uploadOther;
}

/** Clipboard images are often called "image.png"; give them a dated name like Obsidian does. */
export function nameFor(file: { name: string; type: string }, now: Date = new Date()): string {
	const generic = !file.name || /^image\.(png|jpe?g|gif|webp)$/i.test(file.name);
	if (!generic) return file.name;
	const stamp = now.toISOString().replace(/[-:T]/g, "").slice(0, 14);
	return `Pasted image ${stamp}.${extensionForMime(file.type || "image/png")}`;
}

/**
 * Rich text copied from Office, browsers or mail clients often carries a picture
 * of the selection as well. If the clipboard holds real text, the user meant the text.
 */
export function clipboardIsRichText(data: DataTransfer): boolean {
	if (!data.types.includes("text/html")) return false;
	const html = data.getData("text/html");
	const text = html
		.replace(/<img\b[^>]*>/gi, "")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.trim();
	return text.length > 0;
}
